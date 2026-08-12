export function getElement(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing required element #${id}`);
    return element;
}
const KNOWN_KINDS = new Set(["mermaid", "plan", "timeline", "diff"]);
const renderers = new Map();
const pending = new Map();
const stageTitle = getElement("stageTitle");
const stageNotes = getElement("stageNotes");
const stageError = getElement("stageError");
const stageCanvas = getElement("stageCanvas");
export function normalizeVisual(raw) {
    const kind = typeof raw.kind === "string" && raw.kind.trim().length > 0
        ? raw.kind.trim()
        : "mermaid";
    return { ...raw, kind };
}
export function planSummary(items) {
    if (!items || items.length === 0) {
        return "0 steps";
    }
    const activeIdx = items.findIndex((i) => i.state === "active");
    if (activeIdx !== -1) {
        return `step ${activeIdx + 1} of ${items.length}`;
    }
    return `${items.length} steps`;
}
export function formatMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return "0ms";
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    if (ms < 60000) {
        const sec = (ms / 1000).toFixed(1).replace(/\.0$/, "");
        return `${sec}s`;
    }
    if (ms < 3600000) {
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}m ${String(s).padStart(2, "0")}s`;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${String(m).padStart(2, "0")}m`;
}
export function timelineSummary(items) {
    if (!items || items.length === 0)
        return "0 hops";
    const activeIdx = items.findIndex((i) => i.state === "active");
    const totalMs = items.reduce((sum, item) => sum + (typeof item.ms === "number" ? item.ms : 0), 0);
    const allHaveMs = items.every((item) => typeof item.ms === "number");
    const durStr = allHaveMs ? formatMs(totalMs) : "";
    if (activeIdx !== -1) {
        const hopStr = `hop ${activeIdx + 1} of ${items.length}`;
        return durStr ? `${hopStr}, ${durStr}` : hopStr;
    }
    const hopStr = `${items.length} hops`;
    return durStr ? `${hopStr}, ${durStr}` : hopStr;
}
export function setCaption(title, notes) {
    stageTitle.textContent = title || "Diagram";
    stageNotes.textContent = notes || "";
}
export function showStageError(text) {
    stageError.textContent = text;
}
const HISTORY_CAP = 8;
const historyRing = [];
let nextSeq = 0;
let cursorSeq = null; // null means live
let cursorEvicted = false;
export function markStale() {
    document.body.classList.add("stage-stale");
    historyRing.length = 0;
    cursorSeq = null;
    cursorEvicted = false;
    updateHistoryUI();
}
export function historyState() {
    const live = cursorSeq === null;
    let evicted = false;
    let index = -1;
    if (!live) {
        index = historyRing.findIndex((f) => f.seq === cursorSeq);
        if (index === -1) {
            cursorEvicted = true;
            if (historyRing.length > 0) {
                cursorSeq = historyRing[0].seq;
                index = 0;
            }
        }
        if (cursorEvicted && index === 0) {
            evicted = true;
        }
    }
    else {
        cursorEvicted = false;
        index = historyRing.length > 0 ? historyRing.length - 1 : -1;
    }
    const behind = live ? 0 : historyRing.length - 1 - (index >= 0 ? index : 0);
    return {
        index: index >= 0 ? index : 0,
        length: historyRing.length,
        live,
        evicted,
        behind,
    };
}
export function updateHistoryUI() {
    const st = historyState();
    const historyEl = document.getElementById("stageHistory");
    const liveBtn = document.getElementById("historyLive");
    const backBtn = document.getElementById("historyBack");
    const fwdBtn = document.getElementById("historyForward");
    const labelSpan = document.getElementById("historyLabel");
    if (historyEl) {
        historyEl.style.display =
            st.length > 1 && document.body.classList.contains("has-diagram")
                ? "flex"
                : "none";
    }
    if (backBtn) {
        const backDisabled = st.index <= 0;
        backBtn.disabled = backDisabled;
        if (backDisabled) {
            backBtn.setAttribute("aria-disabled", "true");
        }
        else {
            backBtn.removeAttribute("aria-disabled");
        }
    }
    if (fwdBtn) {
        const fwdDisabled = st.live || st.index >= st.length - 1;
        fwdBtn.disabled = fwdDisabled;
        if (fwdDisabled) {
            fwdBtn.setAttribute("aria-disabled", "true");
        }
        else {
            fwdBtn.removeAttribute("aria-disabled");
        }
    }
    if (liveBtn) {
        if (st.behind > 0) {
            liveBtn.setAttribute("data-behind", String(st.behind));
            liveBtn.removeAttribute("aria-disabled");
        }
        else {
            liveBtn.removeAttribute("data-behind");
            liveBtn.setAttribute("aria-disabled", "true");
        }
    }
    if (labelSpan) {
        if (!st.live && st.length > 0) {
            labelSpan.textContent = st.evicted
                ? "oldest kept frame"
                : `frame ${st.index + 1} of ${st.length}`;
        }
        else {
            labelSpan.textContent = "";
        }
    }
}
export function historyBack() {
    if (historyRing.length === 0)
        return;
    cursorEvicted = false;
    const st = historyState();
    if (st.live) {
        const targetIndex = historyRing.length - 2;
        if (targetIndex >= 0) {
            cursorSeq = historyRing[targetIndex].seq;
            void renderCurrentFrame();
        }
    }
    else if (st.index > 0) {
        cursorSeq = historyRing[st.index - 1].seq;
        void renderCurrentFrame();
    }
}
export function historyForward() {
    if (historyRing.length === 0 || cursorSeq === null)
        return;
    cursorEvicted = false;
    const st = historyState();
    if (st.index < historyRing.length - 1) {
        cursorSeq = historyRing[st.index + 1].seq;
        void renderCurrentFrame();
    }
    else {
        cursorSeq = null; // Return to live
        void renderCurrentFrame();
    }
}
export function historyLive() {
    cursorEvicted = false;
    cursorSeq = null;
    void renderCurrentFrame();
}
async function renderCurrentFrame() {
    const st = historyState();
    updateHistoryUI();
    if (historyRing.length === 0)
        return;
    const frame = st.live
        ? historyRing[historyRing.length - 1]
        : historyRing[st.index];
    if (!frame)
        return;
    const renderer = renderers.get(frame.msg.kind);
    if (renderer) {
        await renderer({ ...frame.msg, replay: true });
    }
    if (!st.live) {
        const captionSuffix = st.evicted
            ? " — oldest kept frame"
            : ` — frame ${st.index + 1} of ${st.length}`;
        const currentTitle = stageTitle.textContent || "Diagram";
        if (!currentTitle.includes(" — frame ") &&
            !currentTitle.includes(" — oldest kept frame")) {
            stageTitle.textContent = currentTitle + captionSuffix;
        }
    }
}
const GLYPHS = {
    done: "✓",
    active: "▸",
    todo: "·",
    blocked: "!",
};
export function renderRows(kind, items) {
    const list = items || [];
    document.body.classList.add("stage-structured");
    stageCanvas.classList.add("structured");
    let ol = stageCanvas.querySelector("ol.plan");
    if (!ol || ol.getAttribute("data-visual") !== kind) {
        stageCanvas.replaceChildren();
        ol = document.createElement("ol");
        ol.className = kind === "timeline" ? "plan timeline" : "plan";
        ol.setAttribute("data-visual", kind);
        stageCanvas.appendChild(ol);
    }
    let maxMs = 0;
    let hasAnyMs = false;
    if (kind === "timeline") {
        for (const item of list) {
            if (typeof item.ms === "number") {
                hasAnyMs = true;
                if (item.ms > maxMs)
                    maxMs = item.ms;
            }
        }
        if (!hasAnyMs) {
            ol.setAttribute("data-bars", "none");
        }
        else if (maxMs === 0) {
            ol.setAttribute("data-bars", "flat");
        }
        else {
            ol.setAttribute("data-bars", "scaled");
        }
    }
    else {
        ol.removeAttribute("data-bars");
    }
    const existing = Array.from(ol.children);
    let activeElement = null;
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const state = item.state || "todo";
        const labelText = item.label || "";
        let detailText = item.detail || "";
        const idxText = String(i + 1).padStart(2, "0");
        const glyphText = GLYPHS[state] || "·";
        let li;
        let idxSpan;
        let glyphSpan;
        let labelSpan;
        let detailSpan;
        let barDiv = null;
        let srSpan;
        if (i < existing.length) {
            li = existing[i];
            idxSpan = li.querySelector(".idx");
            glyphSpan = li.querySelector(".glyph");
            labelSpan = li.querySelector(".label");
            detailSpan = li.querySelector(".detail");
            barDiv = li.querySelector(".bar");
            srSpan = li.querySelector(".sr-only");
        }
        else {
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
        if (kind === "timeline" && hasAnyMs) {
            if (!barDiv) {
                barDiv = document.createElement("div");
                barDiv.className = "bar";
                barDiv.setAttribute("aria-hidden", "true");
                li.insertBefore(barDiv, detailSpan);
            }
            if (typeof item.ms === "number") {
                barDiv.removeAttribute("data-dur");
                const fillPct = maxMs > 0 ? Math.min(1, Math.max(0, item.ms / maxMs)) : 0;
                barDiv.style.setProperty("--dur", String(fillPct));
                if (fillPct > 0) {
                    let fillI = barDiv.querySelector("i");
                    if (!fillI) {
                        fillI = document.createElement("i");
                        barDiv.appendChild(fillI);
                    }
                }
                else {
                    barDiv.replaceChildren();
                }
                detailText = item.detail
                    ? `${item.detail} · ${formatMs(item.ms)}`
                    : formatMs(item.ms);
            }
            else {
                barDiv.setAttribute("data-dur", "unknown");
                barDiv.style.removeProperty("--dur");
                barDiv.replaceChildren();
                if (!item.detail) {
                    detailText = "—";
                }
            }
        }
        else {
            if (barDiv) {
                barDiv.remove();
            }
        }
        if (li.getAttribute("data-state") !== state) {
            li.setAttribute("data-state", state);
        }
        if (state === "active") {
            if (li.getAttribute("aria-current") !== "step") {
                li.setAttribute("aria-current", "step");
            }
            activeElement = li;
        }
        else {
            if (li.hasAttribute("aria-current")) {
                li.removeAttribute("aria-current");
            }
        }
        if (idxSpan.textContent !== idxText)
            idxSpan.textContent = idxText;
        if (glyphSpan.textContent !== glyphText)
            glyphSpan.textContent = glyphText;
        if (labelSpan.textContent !== labelText)
            labelSpan.textContent = labelText;
        if (detailSpan.textContent !== detailText)
            detailSpan.textContent = detailText;
        if (srSpan.textContent !== state)
            srSpan.textContent = state;
    }
    while (ol.children.length > list.length) {
        ol.removeChild(ol.lastChild);
    }
    if (activeElement) {
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
        activeElement.scrollIntoView({
            block: "nearest",
            behavior: reducedMotion ? "auto" : "smooth",
        });
    }
}
export function renderPlan(items) {
    renderRows("plan", items);
}
export function renderTimeline(items) {
    renderRows("timeline", items);
}
registerRenderer("plan", (msg) => {
    const items = (msg.items || []);
    const summary = planSummary(items);
    const title = msg.title ? `${msg.title} — ${summary}` : summary;
    setCaption(title, msg.notes);
    showStageError("");
    renderPlan(items);
});
registerRenderer("timeline", (msg) => {
    const items = (msg.items || []);
    const summary = timelineSummary(items);
    const title = msg.title ? `${msg.title} — ${summary}` : summary;
    setCaption(title, msg.notes);
    showStageError("");
    renderTimeline(items);
});
export function registerRenderer(kind, fn) {
    renderers.set(kind, fn);
    const queued = pending.get(kind);
    if (queued) {
        pending.delete(kind);
        void fn(queued);
    }
}
export async function renderVisual(raw) {
    const msg = normalizeVisual(raw);
    const kind = msg.kind;
    if (!KNOWN_KINDS.has(kind)) {
        showStageError(`Unknown visual kind '${kind}', keeping previous visual.`);
        return;
    }
    const frame = { seq: ++nextSeq, msg };
    historyRing.push(frame);
    if (historyRing.length > HISTORY_CAP) {
        historyRing.shift();
    }
    document.body.classList.remove("stage-stale");
    document.body.classList.add("has-diagram");
    if (cursorSeq !== null) {
        updateHistoryUI();
        return;
    }
    updateHistoryUI();
    const renderer = renderers.get(kind);
    if (renderer) {
        await renderer(msg);
    }
    else {
        pending.set(kind, msg);
        if (kind === "mermaid") {
            const checkUnavailable = () => {
                if (!renderers.has("mermaid") && pending.has("mermaid")) {
                    showStageError("Diagram renderer unavailable");
                }
            };
            if (document.readyState === "complete") {
                setTimeout(checkUnavailable, 1000);
            }
            else {
                window.addEventListener("load", () => setTimeout(checkUnavailable, 1000), {
                    once: true,
                });
            }
        }
    }
}
