export function getElement<T extends Element>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing required element #${id}`);
	return element as unknown as T;
}

type RendererFn = (msg: BrowserMessage) => Promise<void> | void;

const renderers = new Map<string, RendererFn>();
const pending = new Map<string, BrowserMessage>();

const stageTitle = getElement<HTMLElement>("stageTitle");
const stageNotes = getElement<HTMLElement>("stageNotes");
const stageError = getElement<HTMLElement>("stageError");
const stageCanvas = getElement<HTMLDivElement>("stageCanvas");

export function normalizeVisual(raw: BrowserMessage): BrowserMessage {
	const kind =
		typeof raw.kind === "string" && raw.kind.trim().length > 0
			? raw.kind.trim()
			: "mermaid";
	return { ...raw, kind };
}

export function planSummary(
	items?: Array<{ label: string; state?: string; detail?: string }>,
): string {
	if (!items || items.length === 0) {
		return "0 steps";
	}
	const activeIdx = items.findIndex((i) => i.state === "active");
	if (activeIdx !== -1) {
		return `step ${activeIdx + 1} of ${items.length}`;
	}
	return `${items.length} steps`;
}

export function setCaption(title?: string, notes?: string): void {
	stageTitle.textContent = title || "Diagram";
	stageNotes.textContent = notes || "";
}

export function showStageError(text: string): void {
	stageError.textContent = text;
}

export function markStale(): void {
	document.body.classList.add("stage-stale");
}

const GLYPHS: Record<string, string> = {
	done: "✓",
	active: "▸",
	todo: "·",
	blocked: "!",
};

export function renderPlan(
	items?: Array<{ label: string; state?: string; detail?: string }>,
): void {
	const list = items || [];
	document.body.classList.add("stage-structured");
	stageCanvas.classList.add("structured");

	let ol = stageCanvas.querySelector<HTMLOListElement>("ol.plan");
	if (!ol) {
		stageCanvas.replaceChildren();
		ol = document.createElement("ol");
		ol.className = "plan";
		stageCanvas.appendChild(ol);
	}

	const existing = Array.from(ol.children) as HTMLLIElement[];
	let activeElement: HTMLLIElement | null = null;

	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		const state = item.state || "todo";
		const labelText = item.label || "";
		const detailText = item.detail || "";
		const idxText = String(i + 1).padStart(2, "0");
		const glyphText = GLYPHS[state] || "·";

		let li: HTMLLIElement;
		let idxSpan: HTMLSpanElement;
		let glyphSpan: HTMLSpanElement;
		let labelSpan: HTMLSpanElement;
		let detailSpan: HTMLSpanElement;
		let srSpan: HTMLSpanElement;

		if (i < existing.length) {
			li = existing[i];
			idxSpan = li.querySelector(".idx")!;
			glyphSpan = li.querySelector(".glyph")!;
			labelSpan = li.querySelector(".label")!;
			detailSpan = li.querySelector(".detail")!;
			srSpan = li.querySelector(".sr-only")!;
		} else {
			li = document.createElement("li");
			li.className = "plan-row";

			idxSpan = document.createElement("span");
			idxSpan.className = "idx";
			idxSpan.setAttribute("aria-hidden", "true");

			glyphSpan = document.createElement("span");
			glyphSpan.className = "glyph";
			glyphSpan.setAttribute("aria-hidden", "true");

			labelSpan = document.createElement("span");
			labelSpan.className = "label";

			detailSpan = document.createElement("span");
			detailSpan.className = "detail";

			srSpan = document.createElement("span");
			srSpan.className = "sr-only";

			li.append(idxSpan, glyphSpan, labelSpan, detailSpan, srSpan);
			ol.appendChild(li);
		}

		if (li.getAttribute("data-state") !== state) {
			li.setAttribute("data-state", state);
		}

		if (state === "active") {
			if (li.getAttribute("aria-current") !== "step") {
				li.setAttribute("aria-current", "step");
			}
			activeElement = li;
		} else {
			if (li.hasAttribute("aria-current")) {
				li.removeAttribute("aria-current");
			}
		}

		if (idxSpan.textContent !== idxText) idxSpan.textContent = idxText;
		if (glyphSpan.textContent !== glyphText) glyphSpan.textContent = glyphText;
		if (labelSpan.textContent !== labelText) labelSpan.textContent = labelText;
		if (detailSpan.textContent !== detailText)
			detailSpan.textContent = detailText;
		if (srSpan.textContent !== state) srSpan.textContent = state;
	}

	while (ol.children.length > list.length) {
		ol.removeChild(ol.lastChild!);
	}

	if (activeElement) {
		const reducedMotion = matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		activeElement.scrollIntoView({
			block: "nearest",
			behavior: reducedMotion ? "auto" : "smooth",
		});
	}
}

registerRenderer("plan", (msg: BrowserMessage) => {
	const items = (msg.items || []) as Array<{
		label: string;
		state?: string;
		detail?: string;
	}>;
	const summary = planSummary(items);
	const title = msg.title ? `${msg.title} — ${summary}` : summary;
	setCaption(title, msg.notes);
	showStageError("");
	renderPlan(items);
});

export function registerRenderer(kind: string, fn: RendererFn): void {
	renderers.set(kind, fn);
	const queued = pending.get(kind);
	if (queued) {
		pending.delete(kind);
		void fn(queued);
	}
}

export async function renderVisual(raw: BrowserMessage): Promise<void> {
	const msg = normalizeVisual(raw);

	const kind = msg.kind!;
	if (kind !== "mermaid" && kind !== "plan") {
		showStageError(`Unknown visual kind '${kind}', keeping previous visual.`);
		return;
	}

	document.body.classList.remove("stage-stale");
	document.body.classList.add("has-diagram");

	const renderer = renderers.get(kind);
	if (renderer) {
		await renderer(msg);
	} else {
		pending.set(kind, msg);
		if (kind === "mermaid") {
			const checkUnavailable = () => {
				if (!renderers.has("mermaid") && pending.has("mermaid")) {
					showStageError("Diagram renderer unavailable");
				}
			};
			if (document.readyState === "complete") {
				setTimeout(checkUnavailable, 1000);
			} else {
				window.addEventListener(
					"load",
					() => setTimeout(checkUnavailable, 1000),
					{
						once: true,
					},
				);
			}
		}
	}
}
