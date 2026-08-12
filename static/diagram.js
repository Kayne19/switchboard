import { getElement, registerRenderer, setCaption, showStageError, } from "./stage.js";
const loadCdnModule = (url) => import(url);
let mermaid = null;
try {
    mermaid = (await loadCdnModule("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;
}
catch {
    /* CDN failed */
}
const canvas = getElement("stageCanvas");
const stage = getElement("stage");
const zoomLabel = getElement("stageZoomLabel");
const stageNotes = getElement("stageNotes");
// Optional. The diagram renders without it; it just appears all at once.
let anime = null;
try {
    anime = (await loadCdnModule("https://cdn.jsdelivr.net/npm/animejs@4/+esm"));
}
catch {
    /* no animation, still a diagram */
}
// The diagram is drawn in the page's own colours, read from the same custom
// properties everything else uses, so it cannot drift from the rest of the UI
// and follows the light/dark switch for free. Re-read per render rather than
// once at load, because the scheme can change while the page is open.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const getSemanticClassDefs = () => `
classDef active stroke:${css("--energy")},stroke-width:2px,color:${css("--energy")};
classDef done stroke:${css("--ok")},stroke-width:1px,color:${css("--ok")};
classDef blocked stroke:${css("--hold")},stroke-width:1px,color:${css("--hold")};
classDef muted stroke:${css("--muted")},stroke-width:1px,color:${css("--muted")};
`;
// Mermaid picks the diagram type off the first non-comment line, so the class
// definitions have to land *under* the header — put them on top and every
// flowchart dies with "no diagram type detected", which is every `:::active`
// diagram the agent can draw.
const withSemanticClassDefs = (srcRaw) => {
    const lines = srcRaw.split("\n");
    const header = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("%%"));
    if (header < 0 ||
        !/^(flowchart|graph|stateDiagram)/i.test(lines[header].trim()))
        return srcRaw;
    lines.splice(header + 1, 0, getSemanticClassDefs());
    return lines.join("\n");
};
const applyTheme = () => {
    if (!mermaid)
        return;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        // Unset variables are derived from primaryColor, which lands somewhere
        // muddy. The ones that carry the look are set outright.
        themeVariables: {
            darkMode: dark,
            background: css("--bg"),
            primaryColor: css("--surface"),
            primaryBorderColor: css("--line"),
            primaryTextColor: css("--text"),
            secondaryColor: css("--surface-alt"),
            secondaryBorderColor: css("--line"),
            tertiaryColor: css("--surface-alt"),
            lineColor: css("--muted"),
            textColor: css("--text"),
            mainBkg: css("--surface"),
            nodeBorder: css("--line"),
            clusterBkg: css("--surface-alt"),
            clusterBorder: css("--line"),
            edgeLabelBackground: css("--bg"),
            // The page's own font, so a node label and a transcript line are set
            // in the same type. 16px rather than 14: the diagram has a whole
            // ultrawide to spread into now and a legibility floor holding it up on
            // a phone, and 14px was chosen back when the picture was squeezed into
            // a 660px column and every pixel of width was worth a pixel of text.
            // It is one value for both schemes — only the colours are conditional
            // — so a re-initialise on a light/dark switch cannot resize the type
            // out from under a fit.
            fontFamily: "system-ui, sans-serif",
            fontSize: "16px",
        },
        // Both of these are what make `<img>` inside a node label work. The
        // source comes from our own agent over our own socket, so the sanitizer
        // is not guarding a trust boundary here.
        securityLevel: "antiscript",
        flowchart: { htmlLabels: true, curve: "basis", useMaxWidth: true },
    });
};
if (mermaid) {
    applyTheme();
}
let seq = 0;
let renderGeneration = 0;
// Zoom is an absolute scale on the diagram's own dimensions rather than a
// fraction of the panel, so 1 means the size mermaid drew it at with its
// text at full height. --dgm-w/--dgm-h carry the viewBox's intrinsic size
// over to the stylesheet; everything here is arithmetic in real pixels.
const BASE_FONT_PX = 16;
// Under this the labels stop being readable and a diagram that cannot be
// read is not information, so an automatic fit will not go there. It would
// rather overflow a legible picture into a canvas you can scroll than shrink
// an illegible whole one into view.
const LEGIBLE_FONT_PX = 14;
const FIT_FLOOR = LEGIBLE_FONT_PX / BASE_FONT_PX;
// The floor is a default, not a wall: somebody who wants the overview of a
// forty-node graph asks for it by hand, with the buttons or with a pinch.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
let zoom = 1;
// "contain" shows the whole picture, "width" fills the panel across and lets
// the diagram run off the bottom. Neither answer suits both shapes — a wide
// left-to-right flowchart wants containing, a tall top-down one wants the
// width and a scroll — so fit is a cycle rather than a setting. It survives
// a new diagram, because it is a preference about how you read.
let fitMode = "contain";
// Whether the zoom on screen is one the caller chose. A resize re-fits only
// when it is not: a deliberate 200% has to survive rotating the iPad.
let userZoomed = false;
const applyZoom = (z) => {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    canvas.style.setProperty("--zoom", String(zoom));
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
};
// The viewBox is the only honest source of intrinsic size: the width/height
// attributes are stripped after render, and getBBox measures the ink rather
// than the box the diagram was laid out in. The fallback is there so that a
// renderer that ever stops emitting one costs the fit, not the diagram.
const intrinsic = () => {
    const el = canvas.querySelector("svg");
    if (!el)
        return null;
    const box = (el.getAttribute("viewBox") || "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
    if (box.length === 4 && box[2] > 0 && box[3] > 0)
        return { el, w: box[2], h: box[3] };
    const bbox = el.getBBox?.();
    return bbox?.width > 0 ? { el, w: bbox.width, h: bbox.height } : null;
};
// Publishes the intrinsic size to the stylesheet. Read once per render — a
// diagram's own dimensions do not change while it is on screen, only the
// scale does.
const measureDiagram = () => {
    const size = intrinsic();
    if (!size)
        return null;
    canvas.style.setProperty("--dgm-w", String(size.w));
    canvas.style.setProperty("--dgm-h", String(size.h));
    return size;
};
// How much height the panel could give the diagram, not merely how much it
// is giving it now. The stage is only as tall as its contents until it meets
// its cap, so a small diagram sits in a short canvas, and measuring that
// would make "fit" mean "stay exactly the size you already are". The slack
// between the stage's current height and its cap is the room the canvas
// would take if the diagram asked for it. In theater mode the stage has a
// definite height and no cap, so there is no slack and none is wanted.
const roomForDiagram = () => {
    const cap = parseFloat(getComputedStyle(stage).maxHeight);
    const slack = Number.isFinite(cap)
        ? Math.max(0, cap - stage.getBoundingClientRect().height)
        : 0;
    // clientWidth rather than the border box: this is the room actually left
    // over, with any scrollbar already deducted.
    return { w: canvas.clientWidth, h: canvas.clientHeight + slack };
};
const scaleToFit = (mode) => {
    const size = intrinsic();
    const room = roomForDiagram();
    if (!size || room.w <= 0 || room.h <= 0)
        return null;
    const byWidth = room.w / size.w;
    const raw = mode === "width" ? byWidth : Math.min(byWidth, room.h / size.h);
    return Math.min(ZOOM_MAX, Math.max(FIT_FLOOR, raw));
};
const fitDiagram = (mode, { toTop = false } = {}) => {
    const scale = scaleToFit(mode);
    if (scale === null)
        return false;
    fitMode = mode;
    userZoomed = false;
    applyZoom(scale);
    if (toTop)
        canvas.scrollTo(0, 0);
    return true;
};
// Zoom about a point rather than about the corner: what is under the cursor,
// or between the fingers, is the thing being looked at, and it should still
// be there afterwards. The anchor is measured off the SVG's own rect, which
// already accounts for the centring margin, so the sums hold whether the
// diagram overflows the panel or floats in the middle of it.
const zoomAbout = (z, clientX, clientY) => {
    const el = canvas.querySelector("svg");
    userZoomed = true;
    if (!el)
        return applyZoom(z);
    const before = el.getBoundingClientRect();
    const ax = before.width ? (clientX - before.left) / before.width : 0.5;
    const ay = before.height ? (clientY - before.top) / before.height : 0.5;
    applyZoom(z);
    // Forces the new layout, so the correction below is against real numbers.
    const after = el.getBoundingClientRect();
    canvas.scrollLeft += after.left + ax * after.width - clientX;
    canvas.scrollTop += after.top + ay * after.height - clientY;
};
// The buttons have no cursor to anchor to, so they hold the middle of the
// panel still — which is where you were reading.
const canvasCentre = () => {
    const r = canvas.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
};
getElement("stageZoom").addEventListener("click", (e) => {
    const target = e.target;
    const d = target instanceof HTMLElement ? target.dataset.zoom : undefined;
    if (!d)
        return;
    if (d === "0") {
        // The first press after a hand-set zoom puts the fit back; a press from
        // a fit moves to the other one. So the button always means "show me the
        // sensible thing", and only becomes a cycle once you are already there.
        const next = userZoomed
            ? fitMode
            : fitMode === "contain"
                ? "width"
                : "contain";
        fitDiagram(next, { toTop: true });
        return;
    }
    zoomAbout(zoom * (d === "+" ? 1.25 : 0.8), ...canvasCentre());
});
// Ctrl/⌘ + wheel zooms, plain wheel scrolls — the same contract as a map.
canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey)
        return;
    e.preventDefault();
    zoomAbout(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
}, { passive: false });
canvas.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (currentFocusedNode) {
            clearGraphFocus();
            e.preventDefault();
            return;
        }
    }
    if (e.key === "ArrowLeft") {
        panBy(-40, 0, "keyboard");
        e.preventDefault();
    }
    else if (e.key === "ArrowRight") {
        panBy(40, 0, "keyboard");
        e.preventDefault();
    }
    else if (e.key === "ArrowUp") {
        panBy(0, -40, "keyboard");
        e.preventDefault();
    }
    else if (e.key === "ArrowDown") {
        panBy(0, 40, "keyboard");
        e.preventDefault();
    }
    else if (e.key === "+" || e.key === "=") {
        zoomAbout(zoom * 1.25, ...canvasCentre());
        e.preventDefault();
    }
    else if (e.key === "-") {
        zoomAbout(zoom * 0.8, ...canvasCentre());
        e.preventDefault();
    }
    else if (e.key === "0") {
        const next = userZoomed
            ? fitMode
            : fitMode === "contain"
                ? "width"
                : "contain";
        fitDiagram(next, { toTop: true });
        e.preventDefault();
    }
});
// Touch, by way of pointer events rather than touch events, so that a mouse
// drag pans for free and there is one code path to be wrong in rather than
// two. Two live pointers is a pinch, one is a pan.
const pointers = new Map();
let pinch = null;
const pointerPair = () => [...pointers.values()];
const spread = () => {
    const [a, b] = pointerPair();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};
const midpoint = () => {
    const [a, b] = pointerPair();
    return a && b ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : [0, 0];
};
const setPanning = () => canvas.classList.toggle("panning", pointers.size === 1);
// The canvas is `touch-action: none`, so nothing scrolls unless it is
// scrolled here. Whatever the canvas cannot spend is handed to the page:
// otherwise a swipe across a diagram that already fits its panel would
// vanish into nothing on a phone, with the rest of the page below it.
const panBy = (dx, dy, type) => {
    canvas.scrollLeft -= dx;
    const before = canvas.scrollTop;
    canvas.scrollTop -= dy;
    const unused = dy - (before - canvas.scrollTop);
    if (unused && type === "touch")
        window.scrollBy(0, -unused);
};
// Far enough that it is a drag and not a tap with a shaky hand.
const DRAG_SLOP = 6;
canvas.addEventListener("pointerdown", (e) => {
    if (!canvas.querySelector("svg") || canvas.classList.contains("structured"))
        return;
    pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        fromX: e.clientX,
        fromY: e.clientY,
        type: e.pointerType,
        held: false,
    });
    // The pinch is measured from where it started, never from the last frame:
    // accumulated per-frame ratios drift, and a pinch that returns to where it
    // began has to bring the zoom back with it.
    if (pointers.size === 2)
        pinch = { dist: spread(), zoom };
    setPanning();
});
canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev)
        return;
    // Capture is taken on the first real movement rather than on the press.
    // A captured pointer retargets its click to the capturing element, and
    // taking it up front would mean mermaid's clickable nodes never saw a tap
    // again. Taken here, a drag still keeps driving the pan after the finger
    // has left the panel, and a tap is left alone.
    const held = prev.held ||
        Math.hypot(e.clientX - prev.fromX, e.clientY - prev.fromY) > DRAG_SLOP;
    if (held && !prev.held)
        canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, {
        ...prev,
        x: e.clientX,
        y: e.clientY,
        held,
    });
    if (pinch && pointers.size === 2) {
        const dist = spread();
        if (dist > 0)
            zoomAbout(pinch.zoom * (dist / pinch.dist), ...midpoint());
        return;
    }
    if (pointers.size === 1)
        panBy(e.clientX - prev.x, e.clientY - prev.y, prev.type);
});
const endPointer = (e) => {
    pointers.delete(e.pointerId);
    // A pinch with a finger lifted becomes a pan from wherever the survivor
    // now is, which is why the pan works off the last recorded position rather
    // than off the gesture's start: there is no jump to make.
    if (pointers.size < 2)
        pinch = null;
    setPanning();
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
// The panel changes size for reasons that have nothing to do with the
// diagram: a window dragged, an iPad rotated, the voice column reflowing,
// theater mode handing over the whole screen. An absolute zoom needs no
// re-applying when that happens — that is half the point of it — but a fit
// was computed against a box that no longer exists, so it is worked out
// again. Only when the caller has not since set the zoom themselves.
let refitPending = 0;
new ResizeObserver(() => {
    // ResizeObserver fires per frame and this callback changes the size of the
    // thing inside the box it watches, so the work is coalesced to one pass a
    // frame and skipped when the answer has not moved — a scrollbar appearing
    // and disappearing is otherwise a loop with no end to it.
    if (refitPending)
        return;
    refitPending = requestAnimationFrame(() => {
        refitPending = 0;
        if (userZoomed)
            return;
        const scale = scaleToFit(fitMode);
        if (scale !== null && Math.abs(scale - zoom) > 0.005)
            applyZoom(scale);
    });
}).observe(canvas);
// The reveal follows the graph, not document order: a source node arrives,
// its edges run out of it, and the nodes they land on arrive as they are
// reached. That is the diagram explaining itself in the order you would draw
// it, instead of a pile of parts fading up together.
//
// Mermaid tags each edge path with `LS-<source>` and `LE-<target>` classes
// and gives each node group an id of `flowchart-<key>-<n>`, which is enough
// to rebuild the graph from the rendered SVG. When those markers are missing
// (sequence and state diagrams, or a mermaid that renames them) rank falls
// back to geometry: top of the picture first.
const nodeKey = (g) => /^flowchart-(.+)-\d+$/.exec(g.id || "")?.[1] ?? null;
const edgeEnds = (p) => {
    const of = (prefix) => Array.from(p.classList)
        .find((c) => c.startsWith(prefix))
        ?.slice(prefix.length);
    const from = of("LS-");
    const to = of("LE-");
    return from && to ? { from, to } : null;
};
const graphInteractive = (nodes, edges) => {
    if (nodes.length === 0 || edges.length === 0)
        return false;
    return (nodes.some((n) => nodeKey(n) !== null) &&
        edges.every((e) => edgeEnds(e) !== null));
};
const neighboursOf = (key, edges) => {
    const inSet = new Set();
    const outSet = new Set();
    const incidentEdges = [];
    for (const e of edges) {
        const ends = edgeEnds(e);
        if (ends) {
            if (ends.to === key) {
                inSet.add(ends.from);
                incidentEdges.push(e);
            }
            if (ends.from === key) {
                outSet.add(ends.to);
                incidentEdges.push(e);
            }
        }
    }
    return { in: inSet, out: outSet, edges: incidentEdges };
};
const topOf = (el) => el.getBBox?.().y ?? 0;
// Breadth-first from every node nothing points at, so each wave is one hop
// further from a source. Anything the walk never reaches (a cycle with no
// entry, an unlinked node) is swept into a final wave rather than dropped.
const waves = (nodes, edges) => {
    const keyed = new Map();
    nodes.forEach((n) => {
        const k = nodeKey(n);
        if (k)
            keyed.set(k, n);
    });
    const links = edges.map(edgeEnds);
    if (!keyed.size || !links.every(Boolean)) {
        // Geometric fallback: rank by how far down the picture the node sits.
        const sorted = [...nodes].sort((a, b) => topOf(a) - topOf(b));
        return {
            depth: new Map(sorted.map((n, i) => [n, i])),
            edgeDepth: new Map(edges.map((p, i) => [p, i])),
        };
    }
    const validLinks = links;
    const out = new Map();
    const indegree = new Map([...keyed.keys()].map((key) => [key, 0]));
    validLinks.forEach(({ from, to }, i) => {
        const outgoing = out.get(from) ?? [];
        outgoing.push({ to, edge: edges[i] });
        out.set(from, outgoing);
        indegree.set(to, (indegree.get(to) ?? 0) + 1);
    });
    // Longest path from a source, not shortest — a node has to wait for every
    // wire pointing at it, or a shortcut edge makes it appear before the wire
    // running the long way round has even started drawing. Kahn's order, so a
    // node is only placed once all of its incoming edges are accounted for.
    const rank = new Map([...keyed.keys()].map((key) => [key, 0]));
    const left = new Map(indegree);
    const queue = [...keyed.keys()].filter((k) => !left.get(k));
    // A graph that is all cycle has no source to start from, so one node is
    // drafted as the entry rather than leaving the build with nothing to do.
    if (!queue.length)
        queue.push([...keyed.keys()][0]);
    const placed = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
        const k = queue[i];
        (out.get(k) ?? []).forEach(({ to }) => {
            // An edge back into something already built cannot push it later; its
            // rank is spent.
            if (!placed.has(to))
                rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(k) ?? 0) + 1));
            left.set(to, (left.get(to) ?? 1) - 1);
            if (left.get(to) === 0 && !placed.has(to)) {
                placed.add(to);
                queue.push(to);
            }
        });
    }
    const depth = new Map();
    const edgeDepth = new Map();
    placed.forEach((key) => {
        const node = keyed.get(key);
        if (node)
            depth.set(node, rank.get(key) ?? 0);
    });
    validLinks.forEach(({ from }, i) => {
        if (placed.has(from))
            edgeDepth.set(edges[i], rank.get(from) ?? 0);
    });
    // Nodes inside a cycle are never placed by Kahn's, and an unlinked node is
    // never reached at all. Both close out the build rather than never
    // arriving — a diagram missing a box is worse than one built out of order.
    const last = Math.max(0, ...depth.values());
    nodes.forEach((n) => depth.has(n) || depth.set(n, last + 1));
    edges.forEach((p) => edgeDepth.has(p) || edgeDepth.set(p, last + 1));
    return { depth, edgeDepth };
};
// Mermaid positions every node group with its own `transform="translate(x,y)"`,
// and an animation that writes the `transform` property wipes that out — which
// is what dumped the whole graph in the top-left corner. So each node's
// contents are slipped into an untransformed inner group, and everything that
// moves or scales happens in there. The positioned group is never a target.
// `transform-box: fill-box` (in the CSS) makes the wrapper scale about the
// node's own centre rather than about the SVG origin.
const fxWrap = (g) => {
    const existing = g.querySelector(":scope > g.fx");
    if (existing)
        return existing;
    const fx = document.createElementNS("http://www.w3.org/2000/svg", "g");
    fx.setAttribute("class", "fx");
    fx.append(...Array.from(g.childNodes));
    g.append(fx);
    return fx;
};
const reveal = (svg) => {
    if (!anime)
        return;
    // Motion is decoration; the diagram is the content.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches)
        return;
    const { animate } = anime;
    const edges = Array.from(svg.querySelectorAll("path.flowchart-link, path.relation, path.transition, .messageLine0, .messageLine1"));
    const nodes = Array.from(svg.querySelectorAll(".node, .actor, .statediagram-state, .cluster"));
    const labels = Array.from(svg.querySelectorAll(".edgeLabel, .messageText"));
    const { depth, edgeDepth } = waves(nodes, edges);
    // One hop of the build. A node extrudes, then the wires leave it while it
    // is still settling — overlapping the two is what makes it read as one
    // continuous movement rather than a slideshow. Cap total wave delay to 1.2s.
    const maxDepth = Math.max(0, ...depth.values(), ...edgeDepth.values());
    const STEP = maxDepth > 0 ? Math.min(300, 1200 / maxDepth) : 0;
    const EDGE_LAG = Math.min(190, STEP * 0.6);
    // Everything starts hidden in one pass, before anything animates. Setting
    // this per-group as each animation starts lets the first frame flash the
    // finished diagram.
    const shells = nodes.map(fxWrap);
    shells.forEach((n) => {
        n.style.opacity = "0";
    });
    labels.forEach((l) => {
        l.style.opacity = "0";
    });
    const lengths = edges.map((p) => {
        const len = p.getTotalLength?.() || 0;
        p.style.strokeDasharray = String(len);
        p.style.strokeDashoffset = String(len);
        return len;
    });
    // Each node pushes out of the page: it starts small, dark and out of
    // focus, comes up past its final size and settles. No panel fades in around
    // it — the diagram is built in place on the page rather than arriving as a
    // finished tile laid over it.
    shells.forEach((n, i) => {
        const at = (depth.get(nodes[i]) ?? 0) * STEP;
        animate(n, {
            opacity: [0, 1],
            scale: [
                { to: 0.86, duration: 0 },
                { to: 1.05, duration: 300, ease: "outCubic" },
                { to: 1, duration: 260, ease: "outBack" },
            ],
            duration: 560,
            delay: at,
        });
    });
    // Edges leave the node that has just landed and reach for the next one, so
    // the wire arrives before the thing on the end of it. Drawn by hand rather
    // than through anime's SVG helper so that a rename in the library costs the
    // effect and not the diagram.
    edges.forEach((p, i) => {
        if (!lengths[i])
            return;
        const at = (edgeDepth.get(p) ?? 0) * STEP + EDGE_LAG;
        animate(p, {
            strokeDashoffset: [lengths[i], 0],
            duration: 380,
            delay: at,
            ease: "inOutQuad",
        });
        // The wire is brighter while current is running down it, then rests.
        animate(p, {
            stroke: [css("--accent"), getComputedStyle(p).stroke || css("--muted")],
            strokeWidth: [2.4, 1.4],
            duration: 640,
            delay: at,
            ease: "outQuad",
        });
    });
    // Each edge label rides in with its own edge rather than all of them at the
    // end: the annotation belongs to the wire, not to the finished picture.
    labels.forEach((l, i) => {
        const near = edges[i] ? edgeDepth.get(edges[i]) : 0;
        animate(l, {
            opacity: [0, 1],
            duration: 260,
            delay: (near ?? 0) * STEP + EDGE_LAG + 200,
            ease: "outQuad",
        });
    });
};
export async function renderMermaid(msg) {
    if (!mermaid) {
        showStageError("Diagram renderer unavailable");
        return;
    }
    const srcRaw = (msg.source || "").trim();
    if (!srcRaw)
        return;
    const src = withSemanticClassDefs(srcRaw);
    const generation = ++renderGeneration;
    const current = () => generation === renderGeneration;
    document.body.classList.remove("stage-structured");
    canvas.classList.remove("structured");
    // Mermaid measures text in the DOM, so the panel has to be visible and the
    // fonts settled before rendering or the labels come out the wrong size.
    await document.fonts.ready;
    if (!current())
        return;
    const id = "dgm" + ++seq;
    try {
        // Parse first: a bad diagram then fails without blanking a good one that
        // is already up, and without flashing mermaid's red error graphic.
        const parsed = await mermaid.parse(src, { suppressErrors: true });
        if (!current())
            return;
        if (!parsed) {
            showStageError("That diagram did not parse. Previous one kept.");
            return;
        }
        const { svg, bindFunctions } = await mermaid.render(id, src);
        if (!current())
            return;
        // Parsed to a node rather than assigned as innerHTML: the HTML parser is
        // lenient about the unclosed tags mermaid's HTML labels can contain, and
        // this keeps the swap to a single element rather than a markup string.
        const el = new DOMParser()
            .parseFromString(svg, "text/html")
            .querySelector("svg");
        if (el) {
            // Caption swapped only once the new diagram has actually parsed and
            // rendered. Applied up front, a diagram that failed to parse left the
            // previous picture on screen wearing the new one's title — "Previous
            // one kept" captioned as something else entirely.
            setCaption(msg.title || "Diagram", msg.notes || "");
            canvas.replaceChildren(el);
            bindFunctions?.(canvas);
            showStageError("");
            // Mermaid's own sizing comes off first: the inline `max-width` that
            // `useMaxWidth` emits, and the width and height attributes with it.
            // The box is the stylesheet's business now, driven by --dgm-w/--dgm-h
            // and --zoom. The viewBox is left exactly as it arrived, because it is
            // what those first two are read from.
            el.removeAttribute("style");
            el.removeAttribute("width");
            el.removeAttribute("height");
            el.setAttribute("preserveAspectRatio", "xMidYMid meet");
            measureDiagram();
            // Layout has to be real before anything is measured: before getBBox
            // and getTotalLength for the reveal, and before the fit, which would
            // otherwise be measuring the diagram that was on screen a moment ago
            // against a panel that is still the shape it was for it.
            el.getBoundingClientRect();
            fitDiagram(fitMode, { toTop: true });
            const edges = Array.from(el.querySelectorAll("path.flowchart-link, path.relation, path.transition, .messageLine0, .messageLine1"));
            const nodes = Array.from(el.querySelectorAll(".node, .actor, .statediagram-state, .cluster"));
            setupGraphInteraction(el, nodes, edges, msg);
            if (!msg.replay) {
                reveal(el);
            }
        }
    }
    catch (err) {
        if (current())
            showStageError("Render failed: " + err);
    }
    finally {
        // A throw mid-render leaves mermaid's scratch node parented to the body.
        document.getElementById("d" + id)?.remove();
        document.getElementById(id)?.parentNode === document.body &&
            document.getElementById(id)?.remove();
    }
}
registerRenderer("mermaid", renderMermaid);
let currentFocusedNode = null;
let currentSvgEl = null;
let currentMsg = null;
const clearGraphFocus = () => {
    if (!currentSvgEl)
        return;
    const allNodes = Array.from(currentSvgEl.querySelectorAll(".node, .actor, .statediagram-state, .cluster"));
    const allEdges = Array.from(currentSvgEl.querySelectorAll("path.flowchart-link, path.relation, path.transition, .messageLine0, .messageLine1"));
    allNodes.forEach((n) => {
        n.classList.remove("focus", "dim");
    });
    allEdges.forEach((e) => {
        e.classList.remove("focus-edge");
    });
    currentFocusedNode = null;
    if (currentMsg) {
        stageNotes.textContent = currentMsg.notes || "";
    }
};
const setupGraphInteraction = (svg, nodes, edges, msg) => {
    currentSvgEl = svg;
    currentMsg = msg;
    clearGraphFocus();
    const isArmed = graphInteractive(nodes, edges);
    if (!isArmed) {
        canvas.setAttribute("aria-label", "Diagram viewport");
        return;
    }
    canvas.setAttribute("aria-label", "Diagram viewport — nodes selectable");
    const keyedNodes = nodes.filter((n) => nodeKey(n) !== null);
    for (const n of keyedNodes) {
        const key = nodeKey(n);
        const { in: inSet, out: outSet, edges: incidentEdges, } = neighboursOf(key, edges);
        n.setAttribute("tabindex", "0");
        n.setAttribute("role", "button");
        const rawLabel = (n.textContent || "").trim().replace(/\s+/g, " ");
        const nodeLabel = rawLabel || key;
        n.setAttribute("aria-label", `${nodeLabel}, ${inSet.size} in, ${outSet.size} out`);
        const focusThisNode = () => {
            if (currentFocusedNode === n) {
                clearGraphFocus();
                return;
            }
            currentFocusedNode = n;
            const incidentSet = new Set(incidentEdges);
            nodes.forEach((other) => {
                if (other === n) {
                    other.classList.add("focus");
                    other.classList.remove("dim");
                }
                else {
                    other.classList.remove("focus");
                    other.classList.add("dim");
                }
            });
            edges.forEach((e) => {
                if (incidentSet.has(e)) {
                    e.classList.add("focus-edge");
                }
                else {
                    e.classList.remove("focus-edge");
                }
            });
            stageNotes.textContent = `${nodeLabel}: ${inSet.size} in, ${outSet.size} out`;
        };
        n.addEventListener("click", (e) => {
            e.stopPropagation();
            focusThisNode();
        });
        n.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                focusThisNode();
            }
        });
    }
};
canvas.addEventListener("click", (e) => {
    if (currentFocusedNode &&
        e.target instanceof Element &&
        !e.target.closest(".node, .actor, .statediagram-state, .cluster")) {
        clearGraphFocus();
    }
});
export { waves, graphInteractive, neighboursOf };
