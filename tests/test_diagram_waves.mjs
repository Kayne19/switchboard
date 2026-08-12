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

const { waves, graphInteractive, neighboursOf } = await import(
	"data:text/javascript," +
		encodeURIComponent(
			[
				lift("nodeKey"),
				lift("edgeEnds"),
				lift("graphInteractive"),
				lift("neighboursOf"),
				lift("topOf"),
				lift("waves"),
			].join("\n") + "\nexport { waves, graphInteractive, neighboursOf };",
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

// neighboursOf and graphInteractive predicates
{
	const [a, b, c] = [node("A"), node("B"), node("C")];
	const edges = [edge("A", "B"), edge("B", "C"), edge("A", "C")];

	assert.equal(graphInteractive([a, b, c], edges), true);

	const bNeighbours = neighboursOf("B", edges);
	assert.deepEqual(Array.from(bNeighbours.in), ["A"]);
	assert.deepEqual(Array.from(bNeighbours.out), ["C"]);
	assert.equal(bNeighbours.edges.length, 2);

	const unkeyedNodes = [{ id: "", getBBox: () => ({ y: 10 }) }];
	const unkeyedEdges = [{ classList: [] }];
	assert.equal(graphInteractive(unkeyedNodes, edges), false);
	assert.equal(graphInteractive([a, b, c], unkeyedEdges), false);

	// Self-loops and isolated node neighbours
	const selfEdge = edge("A", "A");
	const aSelf = neighboursOf("A", [selfEdge]);
	assert.deepEqual(Array.from(aSelf.in), ["A"]);
	assert.deepEqual(Array.from(aSelf.out), ["A"]);

	const unknownNeighbours = neighboursOf("Z", edges);
	assert.equal(unknownNeighbours.in.size, 0);
	assert.equal(unknownNeighbours.out.size, 0);
	assert.equal(unknownNeighbours.edges.length, 0);
}

// Bounded large graph wave computation (50 nodes, 100 edges)
{
	const nodesList = Array.from({ length: 50 }, (_, i) => node(`N${i}`, i * 10));
	const edgesList = [];
	for (let i = 0; i < 49; i++) {
		edgesList.push(edge(`N${i}`, `N${i + 1}`));
		if (i % 2 === 0 && i + 2 < 50) {
			edgesList.push(edge(`N${i}`, `N${i + 2}`));
		}
	}
	const { depth, edgeDepth } = waves(nodesList, edgesList);
	assert.equal(depth.size, 50);
	assert.equal(edgeDepth.size, edgesList.length);
	nodesList.forEach((n) => assert.ok(Number.isFinite(depth.get(n))));
}

// The semantic classDefs the page injects must sit UNDER the diagram header:
// mermaid reads the diagram type off the first non-comment line, so a classDef
// there means "no diagram type detected" and every flowchart fails to parse.
{
	globalThis.document = { documentElement: {} };
	globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#0b6f7d" });
	const { withSemanticClassDefs } = await import(
		"data:text/javascript," +
			encodeURIComponent(
				[
					lift("css"),
					lift("getSemanticClassDefs"),
					lift("withSemanticClassDefs"),
				].join("\n") + "\nexport { withSemanticClassDefs };",
			)
	);
	const meaningful = (src) =>
		src
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);

	const flow = meaningful(withSemanticClassDefs("flowchart TD\n  A --> B"));
	assert.equal(flow[0], "flowchart TD", "the header still comes first");
	assert.ok(
		flow[1].startsWith("classDef active"),
		"classDefs are injected under the header",
	);

	// A leading comment keeps its place; the classDefs follow the header.
	const commented = meaningful(
		withSemanticClassDefs("%% note\ngraph LR\n  A --> B"),
	);
	assert.deepEqual(commented.slice(0, 2), ["%% note", "graph LR"]);
	assert.ok(commented[2].startsWith("classDef active"));

	// Forms without classDef support are handed to mermaid untouched.
	const seq = "sequenceDiagram\n  A ->> B: hi";
	assert.equal(withSemanticClassDefs(seq), seq);
	assert.equal(withSemanticClassDefs(""), "");
}

console.log("ok — diagram reveal ordering and classDef placement");
