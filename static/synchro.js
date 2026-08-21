// Bespoke Audio Synchro Waveform & Mission Telemetry Visualizer
// Draws real-time harmonic synchro curves, tactical grids, and sync rate readouts.
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
        const decis = Math.floor((elapsedMs % 1000) / 100);
        el.textContent = `T+${hrs}:${mins}:${secs}.${decis}`;
    };
    setInterval(update, 100);
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
        if (canvas.width !== rect.width * dpr ||
            canvas.height !== rect.height * dpr) {
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
        }
    };
    window.addEventListener("resize", resize);
    resize();
    const render = () => {
        resize();
        const w = canvas.width;
        const h = canvas.height;
        // Smooth level transition
        currentLevel += (targetLevel - currentLevel) * 0.15;
        phase += currentMode === "transmitting" ? 0.08 : 0.035;
        ctx.clearRect(0, 0, w, h);
        if (w <= 0 || h <= 0) {
            requestAnimationFrame(render);
            return;
        }
        const midY = h / 2;
        // Tactical background grid
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255, 154, 0, 0.07)";
        const step = 20 * (window.devicePixelRatio || 1);
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
        ctx.strokeStyle = "rgba(255, 154, 0, 0.18)";
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(w, midY);
        ctx.stroke();
        // Colors based on state
        let primaryColor = "rgba(0, 229, 255, 0.85)";
        let secondaryColor = "rgba(255, 154, 0, 0.75)";
        let glowColor = "rgba(0, 229, 255, 0.4)";
        let syncRate = 98.2 + Math.sin(phase * 0.5) * 1.2;
        if (currentMode === "transmitting") {
            primaryColor = "rgba(255, 34, 34, 0.95)";
            secondaryColor = "rgba(255, 154, 0, 0.9)";
            glowColor = "rgba(255, 34, 34, 0.5)";
            syncRate = 99.4 + Math.sin(phase * 2) * 0.5;
        }
        else if (currentMode === "receiving") {
            primaryColor = "rgba(66, 255, 120, 0.95)";
            secondaryColor = "rgba(0, 229, 255, 0.8)";
            glowColor = "rgba(66, 255, 120, 0.45)";
            syncRate = 99.8;
        }
        else if (currentMode === "alert") {
            primaryColor = "rgba(255, 34, 34, 1)";
            secondaryColor = "rgba(255, 204, 0, 1)";
            glowColor = "rgba(255, 34, 34, 0.7)";
            syncRate = 42.0 + Math.sin(phase * 4) * 8.0;
        }
        const amp = h * 0.35 * (0.2 + currentLevel * 0.8);
        // Glow pass
        ctx.shadowBlur = 8 * (window.devicePixelRatio || 1);
        ctx.shadowColor = glowColor;
        // Harmonic Wave 1 (Primary Sine)
        ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
        ctx.strokeStyle = primaryColor;
        ctx.beginPath();
        for (let x = 0; x < w; x += 3) {
            const normX = (x / w) * Math.PI * 4;
            const y = midY + Math.sin(normX + phase) * amp * Math.cos(normX * 0.5 + phase * 0.7);
            if (x === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Harmonic Wave 2 (Counter-Harmonic Cosine)
        ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
        ctx.strokeStyle = secondaryColor;
        ctx.beginPath();
        for (let x = 0; x < w; x += 3) {
            const normX = (x / w) * Math.PI * 3.2;
            const y = midY +
                Math.cos(normX - phase * 1.2) * amp * 0.75 * Math.sin(normX * 0.7 + phase);
            if (x === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        // Telemetry overlay on canvas
        ctx.font = `${Math.max(10, 10 * (window.devicePixelRatio || 1))}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = secondaryColor;
        ctx.fillText(`SYNCHRO: ${syncRate.toFixed(1)}%`, 8 * (window.devicePixelRatio || 1), 14 * (window.devicePixelRatio || 1));
        let stateTag = "ARMED // STANDBY";
        if (currentMode === "transmitting") {
            stateTag = "TX >> 16kHz";
        }
        else if (currentMode === "receiving") {
            stateTag = "RX << STREAM";
        }
        const stateWidth = ctx.measureText(stateTag).width;
        ctx.fillStyle = primaryColor;
        ctx.fillText(stateTag, w - stateWidth - 8 * (window.devicePixelRatio || 1), 14 * (window.devicePixelRatio || 1));
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
