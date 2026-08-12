import assert from "node:assert/strict";

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
		this.classList = new FakeClassList();
		this._textContent = "";
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
		if (selector.startsWith("ol.")) {
			return (
				this.tagName === "OL" &&
				this.className.split(" ").includes(selector.slice(3))
			);
		}
		if (selector.startsWith(".")) {
			return this.className.split(" ").includes(selector.slice(1));
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

const stageModule = await import("../static/stage.js");

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

console.log(
	"ok — stage renderer registration race, positional plan updates, and accessibility",
);
