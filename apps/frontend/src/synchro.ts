export interface SynchroController {
	setLevel(level: number): void;
	setMode(mode: "idle" | "transmitting" | "receiving" | "alert"): void;
}

export function initMissionClock(clockElementId: string): void {
	const el = document.querySelector<HTMLElement>(`#${clockElementId}`);
	if (!el) return;

	const startTime = Date.now();
	const update = () => {
		const elapsedMs = Date.now() - startTime;
		const totalSecs = Math.floor(elapsedMs / 1000);
		const hrs = String(Math.floor(totalSecs / 3600)).padStart(2, "0");
		const mins = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, "0");
		const secs = String(totalSecs % 60).padStart(2, "0");
		el.textContent = `T+${hrs}:${mins}:${secs}`;
	};

	setInterval(update, 1000);
	update();
}

export function initSynchro(canvasId: string): SynchroController {
	const canvas = document.querySelector<HTMLCanvasElement>(`#${canvasId}`);
	const ctx = canvas?.getContext("2d");
	if (!canvas || !ctx) return { setLevel() {}, setMode() {} };

	let level = 0.04;
	let targetLevel = 0.04;
	let mode: "idle" | "transmitting" | "receiving" | "alert" = "idle";
	let phase = 0;
	const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

	const resize = () => {
		const rect = canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const width = Math.round(rect.width * dpr);
		const height = Math.round(rect.height * dpr);
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
	};

	const palette = () => {
		switch (mode) {
			case "transmitting":
				return {
					primary: "#ff3547",
					secondary: "#ff9800",
					glow: "rgba(255,53,71,.45)",
					label: "VOICE INPUT // RECORDING",
				};
			case "receiving":
				return {
					primary: "#4bea86",
					secondary: "#00dced",
					glow: "rgba(75,234,134,.4)",
					label: "AI VOICE // PLAYBACK",
				};
			case "alert":
				return {
					primary: "#ff3547",
					secondary: "#ffd43b",
					glow: "rgba(255,53,71,.55)",
					label: "VOICE LINK // FAULT",
				};
			default:
				return {
					primary: "#00dced",
					secondary: "#ff9800",
					glow: "rgba(0,220,237,.3)",
					label: "VOICE LINK // READY",
				};
		}
	};

	const render = () => {
		resize();
		const width = canvas.width;
		const height = canvas.height;
		if (width <= 0 || height <= 0) {
			requestAnimationFrame(render);
			return;
		}

		const dpr = window.devicePixelRatio || 1;
		level += (targetLevel - level) * 0.16;
		if (!reducedMotion) phase += mode === "transmitting" ? 0.12 : 0.045;
		const colors = palette();
		const middle = height / 2;
		const amplitude = Math.max(1.5 * dpr, height * 0.34 * level);

		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = "rgba(255,152,0,.08)";
		ctx.lineWidth = dpr;
		for (let x = 0; x < width; x += 24 * dpr) {
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();
		}
		ctx.strokeStyle = "rgba(255,152,0,.2)";
		ctx.beginPath();
		ctx.moveTo(0, middle);
		ctx.lineTo(width, middle);
		ctx.stroke();

		ctx.save();
		ctx.shadowBlur = 8 * dpr;
		ctx.shadowColor = colors.glow;
		ctx.strokeStyle = colors.primary;
		ctx.lineWidth = 1.8 * dpr;
		ctx.beginPath();
		for (let x = 0; x <= width; x += 3 * dpr) {
			const unit = x / Math.max(1, width);
			const envelope = Math.sin(Math.PI * unit);
			const carrier =
				Math.sin(unit * Math.PI * 12 + phase) * 0.64 +
				Math.sin(unit * Math.PI * 29 - phase * 1.7) * 0.2;
			const y = middle + carrier * amplitude * envelope;
			if (x === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
		ctx.restore();

		ctx.fillStyle = colors.secondary;
		ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
		ctx.fillText(colors.label, 10 * dpr, 15 * dpr);
		requestAnimationFrame(render);
	};

	window.addEventListener("resize", resize);
	requestAnimationFrame(render);

	return {
		setLevel(next: number) {
			targetLevel = Math.max(0, Math.min(1, next));
		},
		setMode(next) {
			mode = next;
		},
	};
}
