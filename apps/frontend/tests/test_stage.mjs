import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class FakeClassList {
	constructor() {
		this._set = new Set();
	}
	add(...names) {
		names.forEach((n) => this._set.add(n));
	}
	remove(...names) {
		names.forEach((n) => this._set.delete(n));
	}
	toggle(name, force) {
		if (force === undefined) {
			if (this._set.has(name)) this._set.delete(name);
			else this._set.add(name);
		} else if (force) {
			this._set.add(name);
		} else {
			this._set.delete(name);
		}
	}
	contains(name) {
		return this._set.has(name);
	}
}

class FakeElement {
	constructor(tagName = "div", id = "") {
		this.tagName = tagName.toUpperCase();
		this.id = id;
		this.className = "";
		this.children = [];
		this.parentNode = null;
		this.attributes = new Map();
		this.dataset = {};
		this.classList = new FakeClassList();
		this._textContent = "";
		this.style = {
			_props: new Map(),
			setProperty(k, v) {
				this._props.set(k, String(v));
			},
			getPropertyValue(k) {
				return this._props.get(k) ?? "";
			},
			removeProperty(k) {
				this._props.delete(k);
			},
		};
	}

	get textContent() {
		return this._textContent;
	}

	set textContent(value) {
		this._textContent = String(value);
		if (value === "") {
			this.children.forEach((c) => (c.parentNode = null));
			this.children = [];
		}
	}

	setAttribute(key, value) {
		this.attributes.set(key, String(value));
	}

	getAttribute(key) {
		return this.attributes.get(key) ?? null;
	}

	hasAttribute(key) {
		return this.attributes.has(key);
	}

	removeAttribute(key) {
		this.attributes.delete(key);
	}

	appendChild(child) {
		child.parentNode = this;
		this.children.push(child);
		return child;
	}

	insertBefore(newChild, refChild) {
		newChild.parentNode = this;
		const idx = this.children.indexOf(refChild);
		if (idx !== -1) {
			this.children.splice(idx, 0, newChild);
		} else {
			this.children.push(newChild);
		}
		return newChild;
	}

	remove() {
		if (this.parentNode) {
			this.parentNode.removeChild(this);
		}
	}

	removeChild(child) {
		const idx = this.children.indexOf(child);
		if (idx !== -1) {
			this.children.splice(idx, 1);
			child.parentNode = null;
		}
		return child;
	}

	get lastChild() {
		return this.children[this.children.length - 1] || null;
	}

	replaceChildren(...newChildren) {
		this.children.forEach((c) => (c.parentNode = null));
		this.children = [];
		newChildren.forEach((c) => this.appendChild(c));
	}

	append(...nodes) {
		nodes.forEach((n) =>
			this.appendChild(typeof n === "string" ? new FakeElement("span") : n),
		);
	}

	querySelector(selector) {
		return this._find(selector);
	}

	querySelectorAll(selector) {
		const results = [];
		this._findAll(selector, results);
		return results;
	}

	_find(selector) {
		for (const child of this.children) {
			if (child._matches(selector)) return child;
			const found = child._find(selector);
			if (found) return found;
		}
		return null;
	}

	_findAll(selector, results) {
		for (const child of this.children) {
			if (child._matches(selector)) results.push(child);
			child._findAll(selector, results);
		}
	}

	_matches(selector) {
		if (selector === "*") return true;
		if (selector.includes("[")) {
			const tag = selector.split("[")[0];
			const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)=['"]?([^'"]+)['"]?\]/);
			const tagMatch = !tag || this.tagName.toLowerCase() === tag.toLowerCase();
			if (!attrMatch) return false;
			return tagMatch && this.getAttribute(attrMatch[1]) === attrMatch[2];
		}
		if (selector.includes(".")) {
			const parts = selector.split(".");
			const tag = parts[0];
			const classes = parts.slice(1);
			const tagMatch = !tag || this.tagName.toLowerCase() === tag.toLowerCase();
			const elementClasses = this.className.split(" ");
			const clsMatch = classes.every((c) => elementClasses.includes(c));
			return tagMatch && clsMatch;
		}
		return this.tagName.toLowerCase() === selector.toLowerCase();
	}

	scrollIntoView(options) {
		this.lastScrollOptions = options;
	}
}

// Global DOM setup
const elements = new Map();
const stageTitle = new FakeElement("p", "stageTitle");
const stageNotes = new FakeElement("p", "stageNotes");
const stageError = new FakeElement("p", "stageError");
const stageCanvas = new FakeElement("div", "stageCanvas");
const documentBody = new FakeElement("body", "body");

elements.set("stageTitle", stageTitle);
elements.set("stageNotes", stageNotes);
elements.set("stageError", stageError);
elements.set("stageCanvas", stageCanvas);

globalThis.document = {
	body: documentBody,
	getElementById(id) {
		return elements.get(id) || null;
	},
	createElement(tagName) {
		return new FakeElement(tagName);
	},
};

globalThis.window = {
	addEventListener() {},
};

let reducedMotionMatches = false;
globalThis.matchMedia = (query) => ({
	matches: query.includes("prefers-reduced-motion: reduce")
		? reducedMotionMatches
		: false,
});

const stageModule = await import("../../../static/stage.js");

// 1. normalizeVisual
assert.deepEqual(stageModule.normalizeVisual({ source: "flowchart TD; A" }), {
	source: "flowchart TD; A",
	kind: "mermaid",
});
assert.deepEqual(
	stageModule.normalizeVisual({ kind: "   ", source: "flowchart TD; A" }),
	{ kind: "mermaid", source: "flowchart TD; A" },
);
assert.deepEqual(stageModule.normalizeVisual({ kind: "plan", items: [] }), {
	kind: "plan",
	items: [],
});

// 2. planSummary
assert.equal(stageModule.planSummary(undefined), "0 steps");
assert.equal(stageModule.planSummary([]), "0 steps");
assert.equal(
	stageModule.planSummary([
		{ label: "Inspect", state: "done" },
		{ label: "Test", state: "active" },
		{ label: "Deploy", state: "todo" },
	]),
	"step 2 of 3",
);
assert.equal(
	stageModule.planSummary([
		{ label: "Inspect", state: "done" },
		{ label: "Test", state: "done" },
	]),
	"2 steps",
);

// 3. Renderer registration race
let mermaidRendererCalledWith = null;
await stageModule.renderVisual({
	kind: "mermaid",
	title: "Queued Mermaid Visual",
	source: "flowchart TD; A-->B",
});
assert.equal(
	mermaidRendererCalledWith,
	null,
	"not called prior to registration",
);

stageModule.registerRenderer("mermaid", (msg) => {
	mermaidRendererCalledWith = msg;
});
assert.notEqual(mermaidRendererCalledWith, null, "flushed upon registration");
assert.equal(mermaidRendererCalledWith.title, "Queued Mermaid Visual");

// 4. Unknown kind preservation & first message validation
documentBody.classList.remove("has-diagram");
await stageModule.renderVisual({
	kind: "invalid_kind",
	source: "something",
});
assert.equal(
	documentBody.classList.contains("has-diagram"),
	false,
	"has-diagram not set on invalid first message",
);

await stageModule.renderVisual({
	kind: "plan",
	title: "Initial Plan",
	items: [{ label: "Step 1", state: "active" }],
});
assert.equal(stageError.textContent, "");
const olBefore = stageCanvas.querySelector("ol.plan");
assert.notEqual(olBefore, null);

await stageModule.renderVisual({
	kind: "unknown_kind",
	source: "something",
});
assert.match(stageError.textContent, /Unknown visual kind 'unknown_kind'/);
assert.equal(
	stageCanvas.querySelector("ol.plan"),
	olBefore,
	"previous visual preserved on unknown kind",
);

// 5. Positional plan updates & accessibility helpers
stageError.textContent = "";
stageModule.renderPlan([
	{ label: "Step 1", state: "active", detail: "in progress" },
	{ label: "Step 2", state: "todo" },
	{ label: "Step 3", state: "todo" },
]);

const ol = stageCanvas.querySelector("ol.plan");
assert.equal(ol.children.length, 3);
const li1 = ol.children[0];
const li2 = ol.children[1];
const li3 = ol.children[2];

assert.equal(li1.getAttribute("data-state"), "active");
assert.equal(li1.getAttribute("aria-current"), "step");
assert.equal(li1.querySelector(".idx").getAttribute("aria-hidden"), "true");
assert.equal(li1.querySelector(".glyph").getAttribute("aria-hidden"), "true");
assert.equal(li1.querySelector(".idx").textContent, "01");
assert.equal(li1.querySelector(".glyph").textContent, "▸");
assert.equal(li1.querySelector(".label").textContent, "Step 1");
assert.equal(li1.querySelector(".detail").textContent, "in progress");
assert.equal(li1.querySelector(".sr-only").textContent, "active");

assert.equal(li2.getAttribute("data-state"), "todo");
assert.equal(li2.hasAttribute("aria-current"), false);

// Re-render updated plan with state shift
stageModule.renderPlan([
	{ label: "Step 1", state: "done", detail: "completed" },
	{ label: "Step 2", state: "active", detail: "running" },
	{ label: "Step 3", state: "todo" },
]);

assert.equal(ol.children[0], li1, "positional element 1 reused in place");
assert.equal(ol.children[1], li2, "positional element 2 reused in place");
assert.equal(ol.children[2], li3, "positional element 3 reused in place");

assert.equal(li1.getAttribute("data-state"), "done");
assert.equal(li1.hasAttribute("aria-current"), false);
assert.equal(li1.querySelector(".glyph").textContent, "✓");
assert.equal(li1.querySelector(".detail").textContent, "completed");
assert.equal(li1.querySelector(".sr-only").textContent, "done");

assert.equal(li2.getAttribute("data-state"), "active");
assert.equal(li2.getAttribute("aria-current"), "step");
assert.equal(li2.querySelector(".glyph").textContent, "▸");
assert.equal(li2.querySelector(".detail").textContent, "running");

// Truncate tail
stageModule.renderPlan([
	{ label: "Step 1", state: "done" },
	{ label: "Step 2", state: "done" },
]);
assert.equal(ol.children.length, 2, "tail element removed");

// 6. Reduced motion assertions for scrollIntoView
reducedMotionMatches = true;
stageModule.renderPlan([{ label: "Step 1", state: "active" }]);
assert.deepEqual(ol.children[0].lastScrollOptions, {
	block: "nearest",
	behavior: "auto",
});

reducedMotionMatches = false;
stageModule.renderPlan([{ label: "Step 1", state: "active" }]);
assert.deepEqual(ol.children[0].lastScrollOptions, {
	block: "nearest",
	behavior: "smooth",
});

// 7. markStale
stageModule.markStale();
assert.equal(documentBody.classList.contains("stage-stale"), true);

// 8. formatMs and timelineSummary
assert.equal(stageModule.formatMs(0), "0ms");
assert.equal(stageModule.formatMs(999), "999ms");
assert.equal(stageModule.formatMs(1000), "1s");
assert.equal(stageModule.formatMs(8400), "8.4s");
assert.equal(stageModule.formatMs(60000), "1m 00s");
assert.equal(stageModule.formatMs(124000), "2m 04s");
assert.equal(stageModule.formatMs(3600000), "1h 00m");
assert.equal(stageModule.formatMs(4320000), "1h 12m");
assert.equal(stageModule.formatMs(86400000), "24h 00m");

assert.equal(stageModule.timelineSummary([]), "0 hops");
assert.equal(
	stageModule.timelineSummary([
		{ label: "hop1", ms: 1200 },
		{ label: "hop2", ms: 8400 },
	]),
	"2 hops, 9.6s",
);
assert.equal(
	stageModule.timelineSummary([
		{ label: "hop1", state: "done", ms: 1200 },
		{ label: "hop2", state: "active", ms: 8400 },
	]),
	"hop 2 of 2, 9.6s",
);

// 9. Timeline duration rendering rules & data-visual guard
stageCanvas.replaceChildren();
stageModule.renderTimeline([
	{ label: "hop1", state: "done", ms: 100, detail: "start" },
	{ label: "hop2", state: "active", ms: 300, detail: "process" },
	{ label: "hop3", state: "todo" },
]);
const timelineOl = stageCanvas.querySelector("ol.timeline");
assert.notEqual(timelineOl, null);
assert.equal(timelineOl.getAttribute("data-visual"), "timeline");
assert.equal(timelineOl.getAttribute("data-bars"), "scaled");
assert.equal(timelineOl.children.length, 3);
const tLi3 = timelineOl.children[2];
assert.equal(tLi3.querySelector(".bar").getAttribute("data-dur"), "unknown");
assert.equal(tLi3.querySelector(".detail").textContent, "—");

// Re-render plan on same canvas -> data-visual guard rebuilds list
stageModule.renderPlan([{ label: "plan item 1" }]);
const planOl = stageCanvas.querySelector("ol.plan");
assert.equal(planOl.getAttribute("data-visual"), "plan");
assert.equal(planOl.hasAttribute("data-bars"), false);

// 10. diff module tests
const diffModule = await import("../../../static/diff.js");

const sampleDiff = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,2 +10,2 @@ function test() {
 --- inside hunk context
-old line
+new line
\\ No newline at end of file
`;

const parsedFiles = diffModule.parseUnifiedDiff(sampleDiff);
assert.equal(parsedFiles.length, 1);
assert.equal(parsedFiles[0].oldPath, "a/src/main.ts");
assert.equal(parsedFiles[0].newPath, "b/src/main.ts");
const hunkLines = parsedFiles[0].hunks[0].lines;
assert.equal(hunkLines.length, 3);
assert.equal(hunkLines[0].op, "ctx");
assert.equal(hunkLines[0].text, "--- inside hunk context");
assert.equal(hunkLines[1].op, "del");
assert.equal(hunkLines[1].text, "old line");
assert.equal(hunkLines[2].op, "add");
assert.equal(hunkLines[2].text, "new line");
assert.equal(hunkLines[2].noNewline, true);

assert.equal(diffModule.parseUnifiedDiff("no hunk header").length, 0);
assert.equal(diffModule.diffSummary(parsedFiles), "1 file, +1 -1");

// Render diff to fake DOM & check line number attributes
stageModule.showStageError("");
diffModule.renderDiff({
	source: sampleDiff,
	title: "Test Diff",
});
const diffUl = stageCanvas.querySelector("ul.diff");
assert.notEqual(diffUl, null);
assert.equal(diffUl.getAttribute("data-visual"), "diff");
const diffLines = diffUl.querySelectorAll(".diff-line");
assert.equal(diffLines.length, 3);
assert.equal(diffLines[1].getAttribute("data-op"), "del");
assert.equal(diffLines[1].getAttribute("data-old"), "11");
assert.equal(diffLines[2].getAttribute("data-op"), "add");
assert.equal(diffLines[2].getAttribute("data-new"), "11");
assert.equal(diffLines[2].querySelector(".text").textContent, "new line");

// 11. History ring & eviction safety
stageModule.markStale();
for (let i = 1; i <= 10; i++) {
	await stageModule.renderVisual({
		kind: "plan",
		title: `Plan ${i}`,
		items: [{ label: `Item ${i}` }],
	});
}

let st = stageModule.historyState();
assert.equal(st.length, 8, "ring buffer retains max 8 frames");
assert.equal(st.live, true);

// Pin history frame 0 (which is Plan 3 after 10 pushes)
stageModule.historyBack(); // step back from live
st = stageModule.historyState();
assert.equal(st.live, false);
assert.equal(st.index, 6); // index 6 of 8

// Pin oldest kept frame (index 0)
for (let k = 0; k < 10; k++) stageModule.historyBack();
st = stageModule.historyState();
assert.equal(st.index, 0);

// Push 10 more frames while pinned on history
for (let i = 11; i <= 20; i++) {
	await stageModule.renderVisual({
		kind: "plan",
		title: `Plan ${i}`,
		items: [{ label: `Item ${i}` }],
	});
}
// Pinned frame was evicted -> state snaps to oldest retained with evicted: true
st = stageModule.historyState();
assert.equal(st.live, false);
assert.equal(st.evicted, true);

stageModule.historyLive();
st = stageModule.historyState();
assert.equal(st.live, true);

// 12. DOM element ceilings & leak tests
stageCanvas.replaceChildren();
// 40-row timeline ceiling check
stageModule.renderTimeline(
	Array.from({ length: 40 }, (_, i) => ({
		label: `Hop ${i}`,
		ms: i * 100,
	})),
);
const timelineElemCount = stageCanvas.querySelectorAll("*").length;
assert.ok(
	timelineElemCount <= 350,
	`timeline elements ${timelineElemCount} <= 350`,
);

// Re-rendering 10 times consecutively leaves child count identical
const initialChildCount =
	stageCanvas.querySelector("ol.timeline").children.length;
for (let r = 0; r < 10; r++) {
	stageModule.renderTimeline(
		Array.from({ length: 40 }, (_, i) => ({
			label: `Hop ${i}`,
			ms: i * 100,
		})),
	);
}
assert.equal(
	stageCanvas.querySelector("ol.timeline").children.length,
	initialChildCount,
	"no orphaned nodes after consecutive renders",
);

// 13. Advanced Diff text behavior & security / HTML escaping
const maliciousDiff = `diff --git a/src/bad.ts b/src/bad.ts
--- a/src/bad.ts
+++ b/src/bad.ts
@@ -1,2 +1,3 @@
 function safe() {}
-<script>alert('xss')</script>
+<img src=x onerror=alert('xss')>
+const amp = "&" && "<test>";
\\ No newline at end of file
`;

const parsedMalicious = diffModule.parseUnifiedDiff(maliciousDiff);
assert.equal(parsedMalicious.length, 1);
assert.equal(parsedMalicious[0].hunks[0].lines[1].op, "del");
assert.equal(
	parsedMalicious[0].hunks[0].lines[1].text,
	"<script>alert('xss')</script>",
);
assert.equal(parsedMalicious[0].hunks[0].lines[3].noNewline, true);

diffModule.renderDiff({
	source: maliciousDiff,
	title: "Malicious Diff",
});
const renderedDiffUl = stageCanvas.querySelector("ul.diff");
assert.notEqual(renderedDiffUl, null);
const maliciousLines = renderedDiffUl.querySelectorAll(".diff-line");
assert.equal(maliciousLines.length, 4);
assert.equal(
	maliciousLines[1].querySelector(".text").textContent,
	"<script>alert('xss')</script>",
);
assert.equal(
	maliciousLines[2].querySelector(".text").textContent,
	"<img src=x onerror=alert('xss')>",
);
assert.equal(
	maliciousLines[3].querySelector(".text").textContent,
	'const amp = "&" && "<test>";',
);

// Truncated hunk recovery test (early @@ in INHUNK state)
const truncatedDiff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,100 +1,100 @@
-old line
+new line
@@ -5,2 +5,2 @@
 ctx line
`;
const parsedTruncated = diffModule.parseUnifiedDiff(truncatedDiff);
assert.equal(parsedTruncated.length, 1);
assert.equal(
	parsedTruncated[0].hunks.length,
	2,
	"early header transitions to OUTSIDE state and parses second hunk",
);

// Multi-file summary calculation
assert.equal(
	diffModule.diffSummary([
		{ hunks: [{ lines: [{ op: "add" }, { op: "del" }] }] },
		{ hunks: [{ lines: [{ op: "add" }, { op: "add" }] }] },
	]),
	"2 files, +3 -1",
);

// 14. Advanced Timeline ordering & duration scaling
assert.equal(stageModule.formatMs(59900), "59.9s");
assert.equal(stageModule.formatMs(3599000), "59m 59s");
assert.equal(stageModule.formatMs(-100), "0ms");
assert.equal(stageModule.formatMs(NaN), "0ms");

stageCanvas.replaceChildren();
stageModule.renderTimeline([
	{ label: "Hop 1", state: "done", ms: 500, detail: "first" },
	{ label: "Hop 2", state: "active", ms: 2000, detail: "second" },
	{ label: "Hop 3", state: "todo", ms: 1000 },
]);

const tOl = stageCanvas.querySelector("ol.timeline");
assert.equal(tOl.children.length, 3);
const tBar1 = tOl.children[0].querySelector(".bar");
const tBar2 = tOl.children[1].querySelector(".bar");
assert.equal(tBar1.hasAttribute("data-dur"), false);
assert.equal(tBar2.hasAttribute("data-dur"), false);
assert.equal(
	tOl.children[0].querySelector(".detail").textContent,
	"first · 500ms",
);
assert.equal(
	tOl.children[1].querySelector(".detail").textContent,
	"second · 2s",
);

// Verify max duration scaling calculation (2000ms is max -> 100% width ratio)
assert.equal(tBar1.style.getPropertyValue("--dur"), "0.25");
assert.equal(tBar2.style.getPropertyValue("--dur"), "1");

// Hop state update reuse
stageModule.renderTimeline([
	{ label: "Hop 1", state: "done", ms: 500, detail: "first" },
	{ label: "Hop 2", state: "done", ms: 2000, detail: "second" },
	{ label: "Hop 3", state: "active", ms: 1000, detail: "third" },
]);
assert.equal(tOl.children[1].getAttribute("data-state"), "done");
assert.equal(tOl.children[2].getAttribute("data-state"), "active");
assert.equal(tOl.children[2].getAttribute("aria-current"), "step");

// 15. History background live buffering & eviction safety
stageModule.markStale();
for (let i = 1; i <= 5; i++) {
	await stageModule.renderVisual({
		kind: "plan",
		title: `Plan ${i}`,
		items: [{ label: `Step ${i}` }],
	});
}

// Step back to frame 3
stageModule.historyBack();
stageModule.historyBack();
let hSt = stageModule.historyState();
assert.equal(hSt.live, false);
assert.equal(hSt.index, 2);

// Receive new frame while pinned in history
await stageModule.renderVisual({
	kind: "plan",
	title: "Background Plan 6",
	items: [{ label: "Step 6" }],
});

hSt = stageModule.historyState();
assert.equal(hSt.live, false, "remains pinned on frame 3");
assert.equal(hSt.length, 6);

// Return to live
stageModule.historyLive();
hSt = stageModule.historyState();
assert.equal(hSt.live, true);
assert.equal(hSt.index, 5);

// 16. Rapid Kind Switching & Coexistence
await stageModule.renderVisual({
	kind: "plan",
	title: "Plan Mode",
	items: [{ label: "Plan item" }],
});
assert.equal(
	stageCanvas.querySelector("ol[data-visual='plan']") !== null,
	true,
);
assert.equal(documentBody.classList.contains("stage-structured"), true);

await stageModule.renderVisual({
	kind: "timeline",
	title: "Timeline Mode",
	items: [{ label: "Hop item", ms: 100 }],
});
assert.equal(
	stageCanvas.querySelector("ol[data-visual='timeline']") !== null,
	true,
);
assert.equal(
	stageCanvas.querySelector("ol[data-visual='plan']"),
	null,
	"old plan replaced clean",
);

diffModule.renderDiff({
	source: "@@ -1 +1 @@\n-a\n+b",
	title: "Diff Mode",
});
assert.equal(stageCanvas.querySelector("ul.diff") !== null, true);
assert.equal(
	stageCanvas.querySelector("ol.timeline"),
	null,
	"old timeline replaced clean",
);

// 17. Diff hunk line parsing and exact whitespace preservation
const diffWithPrefixInHunk = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 context line
---- old line
++++ new line`;
const parsedHunkLines = diffModule.parseUnifiedDiff(diffWithPrefixInHunk);
assert.equal(parsedHunkLines.length, 1);
assert.equal(parsedHunkLines[0].hunks[0].lines.length, 3);
assert.equal(parsedHunkLines[0].hunks[0].lines[1].text, "--- old line");
assert.equal(parsedHunkLines[0].hunks[0].lines[2].text, "+++ new line");

const diffWithTrailingSpace = "@@ -1 +1 @@\n-old line \n+new line  ";
const parsedSpace = diffModule.parseUnifiedDiff(diffWithTrailingSpace);
assert.equal(parsedSpace[0].hunks[0].lines[0].text, "old line ");
assert.equal(parsedSpace[0].hunks[0].lines[1].text, "new line  ");

// 18. Partial timeline duration summary handling
const partialMsSummary = stageModule.timelineSummary([
	{ label: "Hop 1", ms: 100 },
	{ label: "Hop 2" },
]);
assert.equal(partialMsSummary, "2 hops");

// 19. Mobile stage cap can shrink the canvas below its desktop minimum.
const pageHtml = readFileSync("static/legacy/index.html", "utf8");
assert.match(
	pageHtml,
	/@media \(max-width: 1080px\)[\s\S]*body:not\(\.theater\) #stageCanvas\s*\{\s*min-height:\s*0;/,
);

console.log(
	"ok — stage renderer registration race, positional plan updates, and accessibility",
);
