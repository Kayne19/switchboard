// The reveal builds the diagram one hop at a time, and the ordering it uses is
// the only part of it that can be wrong without being obviously wrong on screen.
// So it is checked here: the functions are lifted out of the page's module
// script and run against plain objects, since they only ever touch `id`,
// `classList` and `getBBox`.
//
// Run: node tests/test_diagram_waves.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const diagram = readFileSync(
	new URL("../static/diagram.js", import.meta.url),
	"utf8",
);
const lift = (name) => {
	const start = diagram.indexOf(`const ${name} = `);
	assert.notEqual(start, -1, `${name} is no longer in static/diagram.js`);
	// The compiled module keeps these helpers as top-level const declarations.
	const end = diagram.indexOf("\nconst ", start + 1);
	return diagram.slice(start, end);
};

const { waves } = await import(
	"data:text/javascript," +
		encodeURIComponent(
			[lift("nodeKey"), lift("edgeEnds"), lift("topOf"), lift("waves")].join(
				"\n",
			) + "\nexport { waves };",
		)
);

const node = (key, y = 0) => ({
	id: `flowchart-${key}-0`,
	getBBox: () => ({ y }),
});
const edge = (from, to) => ({
	classList: ["flowchart-link", `LS-${from}`, `LE-${to}`],
});

// A --> B --> C with a shortcut A --> C: every node sits at its distance from
// the source, and C waits for the longer path rather than arriving with B.
{
	const [a, b, c] = [node("A"), node("B"), node("C")];
	const edges = [edge("A", "B"), edge("B", "C"), edge("A", "C")];
	const { depth, edgeDepth } = waves([a, b, c], edges);
	assert.equal(depth.get(a), 0);
	assert.equal(depth.get(b), 1);
	assert.equal(depth.get(c), 2);
	assert.equal(
		edgeDepth.get(edges[0]),
		0,
		"A->B leaves as soon as A has landed",
	);
	assert.equal(edgeDepth.get(edges[1]), 1, "B->C waits for B");
}

// A cycle has no source to start from. One node is drafted as the entry and the
// rest follow, and the back edge does not push the entry later than the node it
// points at.
{
	const [a, b] = [node("A"), node("B")];
	const edges = [edge("A", "B"), edge("B", "A")];
	const { depth, edgeDepth } = waves([a, b], edges);
	assert.equal(depth.get(a), 0);
	assert.equal(depth.get(b), 1);
	edges.forEach((e) => assert.ok(Number.isFinite(edgeDepth.get(e))));
}

// An orphan is pointed at by nothing and points at nothing, and a node stranded
// behind a cycle is never reached. Neither may be dropped from the build.
{
	const [a, b, orphan] = [node("A"), node("B"), node("X")];
	const { depth } = waves([a, b, orphan], [edge("A", "B"), edge("B", "A")]);
	[a, b, orphan].forEach((n) =>
		assert.ok(Number.isFinite(depth.get(n)), "every node arrives"),
	);
	assert.ok(depth.get(a) > depth.get(orphan), "the cycle closes out the build");
}

// Sequence and state diagrams carry no LS-/LE- markers, so ordering falls back
// to geometry: whatever sits highest in the picture is built first.
{
	const low = { id: "", getBBox: () => ({ y: 400 }) };
	const high = { id: "", getBBox: () => ({ y: 10 }) };
	const { depth } = waves([low, high], [{ classList: [] }]);
	assert.ok(depth.get(high) < depth.get(low));
}

console.log("ok — diagram reveal ordering");
