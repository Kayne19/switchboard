// Tactical Audio Synchro Waveform & Multi-Instrument Telemetry Core
// Renders dual harmonic Lissajous synchro curves, 24-band frequency spectrum meters,
// polar synchro radar reticles, and real-time mission telemetry.
export function initMissionClock(clockElementId) {
    const el = document.querySelector(`#${clockElementId}`);
    if (!el)
        return;
    const startTime = Date.now();
    const update = () => {
        const elapsedMs = Date.now() - startTime;
        const totalSecs = Math.floor(elapsedMs / 1000);
        const hrs = String(Math.floor(totalSecs / 3600)).padStart(2, "0");
        const mins = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, "0");
        const secs = String(totalSecs % 60).padStart(2, "0");
        const decis = String(Math.floor((elapsedMs % 1000) / 10)).padStart(2, "0");
        el.textContent = `T+${hrs}:${mins}:${secs}.${decis}`;
    };
    setInterval(update, 50);
    update();
}
export function initSynchro(canvasId) {
    const canvas = document.querySelector(`#${canvasId}`);
    if (!canvas) {
        return {
            setLevel() { },
            setMode() { },
        };
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return {
            setLevel() { },
            setMode() { },
        };
    }
    let currentLevel = 0;
    let targetLevel = 0;
    let currentMode = "idle";
    let phase = 0;
    const resize = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(rect.width * dpr);
        const targetH = Math.round(rect.height * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
        }
    };
    window.addEventListener("resize", resize);
    resize();
    const render = () => {
        resize();
        const w = canvas.width;
        const h = canvas.height;
        if (w <= 0 || h <= 0) {
            requestAnimationFrame(render);
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        currentLevel += (targetLevel - currentLevel) * 0.18;
        phase += currentMode === "transmitting" ? 0.095 : 0.04;
        ctx.clearRect(0, 0, w, h);
        const midY = h / 2;
        const midX = w / 2;
        // 1. Tactical grid lines & coordinate axes
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255, 154, 0, 0.08)";
        const step = 20 * dpr;
        for (let x = 0; x < w; x += step) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let y = 0; y < h; y += step) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        // Center tactical baseline
        ctx.strokeStyle = "rgba(255, 154, 0, 0.22)";
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(w, midY);
        ctx.stroke();
        // Color & Signal Palette based on active mode
        let primaryColor = "rgba(0, 229, 255, 0.95)";
        let secondaryColor = "rgba(255, 154, 0, 0.85)";
        let glowColor = "rgba(0, 229, 255, 0.45)";
        let syncRate = 98.4 + Math.sin(phase * 0.6) * 1.1;
        if (currentMode === "transmitting") {
            primaryColor = "rgba(255, 34, 34, 1)";
            secondaryColor = "rgba(255, 154, 0, 0.95)";
            glowColor = "rgba(255, 34, 34, 0.65)";
            syncRate = 99.6 + Math.sin(phase * 2.5) * 0.3;
        }
        else if (currentMode === "receiving") {
            primaryColor = "rgba(56, 239, 125, 1)";
            secondaryColor = "rgba(0, 229, 255, 0.9)";
            glowColor = "rgba(56, 239, 125, 0.55)";
            syncRate = 99.9;
        }
        else if (currentMode === "alert") {
            primaryColor = "rgba(255, 34, 34, 1)";
            secondaryColor = "rgba(255, 204, 0, 1)";
            glowColor = "rgba(255, 34, 34, 0.85)";
            syncRate = 42.0 + Math.sin(phase * 5) * 12.0;
        }
        const amp = (h * 0.38) * (0.2 + currentLevel * 0.8);
        // 2. Central Polar Synchro Radar Reticle
        ctx.save();
        ctx.strokeStyle = "rgba(255, 154, 0, 0.15)";
        ctx.lineWidth = 1 * dpr;
        const radarRadius = Math.min(midY * 0.85, 30 * dpr);
        ctx.beginPath();
        ctx.arc(midX, midY, radarRadius, 0, Math.PI * 2);
        ctx.arc(midX, midY, radarRadius * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        // Rotating radar sweep line
        ctx.strokeStyle = primaryColor;
        ctx.beginPath();
        ctx.moveTo(midX, midY);
        ctx.lineTo(midX + Math.cos(phase * 1.5) * radarRadius, midY + Math.sin(phase * 1.5) * radarRadius);
        ctx.stroke();
        ctx.restore();
        // 3. 24-Band Flanking Equalizer Frequency Bars
        const barCount = 14;
        const barWidth = 3 * dpr;
        const barGap = 2 * dpr;
        // Left flank equalizer
        for (let i = 0; i < barCount; i++) {
            const barHeight = Math.sin(phase * 1.6 + i * 0.35) * amp * 0.85 * (0.3 + currentLevel);
            const x = 12 * dpr + i * (barWidth + barGap);
            ctx.fillStyle = secondaryColor;
            ctx.fillRect(x, midY - Math.abs(barHeight) / 2, barWidth, Math.abs(barHeight) + 2);
        }
        // Right flank equalizer
        for (let i = 0; i < barCount; i++) {
            const barHeight = Math.cos(phase * 1.8 + i * 0.45) * amp * 0.85 * (0.3 + currentLevel);
            const x = w - 12 * dpr - (barCount - i) * (barWidth + barGap);
            ctx.fillStyle = primaryColor;
            ctx.fillRect(x, midY - Math.abs(barHeight) / 2, barWidth, Math.abs(barHeight) + 2);
        }
        // 4. Central Harmonic Curves (EVA Synchro Waves)
        ctx.shadowBlur = 8 * dpr;
        ctx.shadowColor = glowColor;
        // Wave 1: Primary Harmonic Sine
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = primaryColor;
        ctx.beginPath();
        const startX = 85 * dpr;
        const endX = w - 85 * dpr;
        for (let x = startX; x <= endX; x += 3 * dpr) {
            const normX = ((x - startX) / (endX - startX)) * Math.PI * 4;
            const y = midY + Math.sin(normX + phase) * amp * Math.cos(normX * 0.5 + phase * 0.7);
            if (x === startX)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Wave 2: Counter-Harmonic Cosine
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = secondaryColor;
        ctx.beginPath();
        for (let x = startX; x <= endX; x += 3 * dpr) {
            const normX = ((x - startX) / (endX - startX)) * Math.PI * 3.2;
            const y = midY + Math.cos(normX - phase * 1.2) * amp * 0.75 * Math.sin(normX * 0.7 + phase);
            if (x === startX)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        // 5. Tactical Telemetry & Registration Marks
        ctx.font = `${Math.max(10, 10 * dpr)}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = secondaryColor;
        ctx.fillText(`SYNCHRO RATE: ${syncRate.toFixed(1)}%`, 12 * dpr, 14 * dpr);
        let stateTag = "ARMED // STANDBY";
        if (currentMode === "transmitting") {
            stateTag = "TX >> 16kHz PCM";
        }
        else if (currentMode === "receiving") {
            stateTag = "RX << SPEECH DUPLEX";
        }
        else if (currentMode === "alert") {
            stateTag = "ALERT // LINE SEVERED";
        }
        const stateWidth = ctx.measureText(stateTag).width;
        ctx.fillStyle = primaryColor;
        ctx.fillText(stateTag, w - stateWidth - 12 * dpr, 14 * dpr);
        // Corner registration ticks
        ctx.strokeStyle = "rgba(255, 154, 0, 0.45)";
        ctx.beginPath();
        ctx.moveTo(0, 8 * dpr);
        ctx.lineTo(8 * dpr, 0);
        ctx.moveTo(w, 8 * dpr);
        ctx.lineTo(w - 8 * dpr, 0);
        ctx.moveTo(0, h - 8 * dpr);
        ctx.lineTo(8 * dpr, h);
        ctx.moveTo(w, h - 8 * dpr);
        ctx.lineTo(w - 8 * dpr, h);
        ctx.stroke();
        requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
    return {
        setLevel(lvl) {
            targetLevel = Math.max(0, Math.min(1, lvl));
        },
        setMode(m) {
            currentMode = m;
        },
    };
}
