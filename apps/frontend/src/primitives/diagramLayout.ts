// Diagram geometry: which layer each node sits in, where it goes, how each
// edge is routed, and where its label sits. Pure, so the rules below can be
// checked without a browser.
//
// Layout is layered along a main axis (x in landscape, y in portrait) and
// spread along the cross axis. Two rules keep a diagram readable:
// - Every gap between layers is wide enough for the labels that sit in it.
//   When the approved spacing is too tight, the drawing grows and the SVG
//   scales it to fit, rather than letting labels slide under nodes.
// - An edge between adjacent layers bends in the gap between them. Any other
//   edge -- one that skips a layer, stays in its layer, or runs backwards --
//   leaves through the gap beside its source, runs along its own lane
//   outside the node band, and comes back in through the gap before its
//   target, so it never passes through a node.

import type { DiagramData, DiagramEdge, DiagramNode } from '../controller/types';

export type DiagramOrientation = 'landscape' | 'portrait';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutNode {
  node: DiagramNode;
  layer: number;
  box: Box;
}

export interface EdgeLabel {
  text: string;
  /** The centre of the label's text. */
  x: number;
  y: number;
  /** The label's backing: what it paints over. */
  box: Box;
}

export interface LaidOutEdge {
  edge: DiagramEdge;
  /** Axis-aligned route from the source's outline to the target's. */
  points: Point[];
  label: EdgeLabel | null;
}

export interface DiagramCallout {
  targetNodeId: string;
  box: Box;
  leader: Point[];
  placement: 'above' | 'below' | 'left' | 'right';
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  callout?: DiagramCallout | null;
}

// The approved geometry, in main/cross terms.
const GEOMETRY = {
  landscape: { main: 1000, cross: 620, nodeMain: 182, nodeCross: 88, padMain: 112, padCross: 82 },
  portrait: { main: 1000, cross: 700, nodeMain: 98, nodeCross: 244, padMain: 110, padCross: 96 },
} as const;

// Edge labels are set in the monospace face at 11 user units with 0.06em
// tracking (.diagram-edge-label), so a label's width is known before it is
// drawn: 0.6em advance plus the tracking, rounded up.
const LABEL_ADVANCE = 7.3;
const LABEL_HEIGHT = 14;
const LABEL_BACKING = 4;
// Space kept clear between a label's backing and anything else in its gap.
const CLEARANCE = 6;
// The narrowest gap between layers, labelled or not.
const MIN_GAP = 40;
// Space between the node band and the first lane.
const LANE_GAP = 10;
const MIN_LANE_PITCH = 26;

interface Placed {
  node: DiagramNode;
  layer: number;
  main: number;
  cross: number;
}

export function createLayers(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramNode[][] {
  if (nodes.length === 0) return [];

  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (outgoing.has(edge.from) && outgoing.has(edge.to)) {
      outgoing.get(edge.from)?.push(edge.to);
    }
  }

  // Collapse every feedback loop into one component before assigning depth.
  // The resulting component graph is a DAG, so longest-path layering is both
  // bounded and deterministic even for pure cycles and self-loops.
  const visitIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextVisitIndex = 0;

  const findComponent = (id: string) => {
    visitIndex.set(id, nextVisitIndex);
    lowLink.set(id, nextVisitIndex);
    nextVisitIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const child of outgoing.get(id) ?? []) {
      if (!visitIndex.has(child)) {
        findComponent(child);
        lowLink.set(id, Math.min(lowLink.get(id) ?? 0, lowLink.get(child) ?? 0));
      } else if (onStack.has(child)) {
        lowLink.set(id, Math.min(lowLink.get(id) ?? 0, visitIndex.get(child) ?? 0));
      }
    }

    if (lowLink.get(id) !== visitIndex.get(id)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };

  for (const node of nodes) {
    if (!visitIndex.has(node.id)) findComponent(node.id);
  }

  const componentByNode = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const id of component) componentByNode.set(id, componentIndex);
  });

  const componentOutgoing = components.map(() => new Set<number>());
  const componentIncoming = components.map(() => 0);
  for (const [from, children] of outgoing) {
    const fromComponent = componentByNode.get(from);
    if (fromComponent === undefined) continue;
    for (const child of children) {
      const toComponent = componentByNode.get(child);
      if (
        toComponent === undefined ||
        toComponent === fromComponent ||
        componentOutgoing[fromComponent].has(toComponent)
      ) {
        continue;
      }
      componentOutgoing[fromComponent].add(toComponent);
      componentIncoming[toComponent] += 1;
    }
  }

  const componentDepth = components.map(() => 0);
  const queue = componentIncoming.flatMap((count, index) => (count === 0 ? [index] : []));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const component = queue[cursor];
    for (const child of componentOutgoing[component]) {
      componentDepth[child] = Math.max(componentDepth[child], componentDepth[component] + 1);
      componentIncoming[child] -= 1;
      if (componentIncoming[child] === 0) queue.push(child);
    }
  }

  const maxDepth = Math.max(...componentDepth);
  const layers = Array.from({ length: maxDepth + 1 }, () => [] as DiagramNode[]);
  for (const node of nodes) {
    const component = componentByNode.get(node.id);
    layers[component === undefined ? 0 : componentDepth[component]].push(node);
  }
  return layers;
}

function labelBacking(text: string) {
  return {
    width: text.length * LABEL_ADVANCE + 2 * LABEL_BACKING,
    height: LABEL_HEIGHT + 2 * LABEL_BACKING,
  };
}

export function layoutDiagram(data: DiagramData, orientation: DiagramOrientation, anchorNodeId?: string): DiagramLayout {
  const geometry = GEOMETRY[orientation];
  const landscape = orientation === 'landscape';
  const layers = createLayers(data.nodes, data.edges);
  const lastLayer = layers.length - 1;

  // A label's extent along each axis, in main/cross terms. Text is always
  // horizontal, so which of its sides runs along the main axis depends on
  // the orientation.
  const labelExtent = (text: string) => {
    const backing = labelBacking(text);
    return landscape
      ? { main: backing.width, cross: backing.height }
      : { main: backing.height, cross: backing.width };
  };

  // --- Layers along the main axis -------------------------------------------
  const placed = new Map<string, Placed>();
  layers.forEach((layerNodes, layer) => {
    const usable = geometry.cross - geometry.padCross * 2;
    const step = layerNodes.length <= 1 ? 0 : usable / (layerNodes.length - 1);
    layerNodes.forEach((node, index) => {
      const cross = layerNodes.length === 1 ? geometry.cross / 2 : geometry.padCross + index * step;
      placed.set(node.id, { node, layer, main: 0, cross });
    });
  });
  const resolved = data.edges.flatMap((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    return from && to ? [{ edge, from, to }] : [];
  });
  const adjacent = (entry: (typeof resolved)[number]) => entry.to.layer - entry.from.layer === 1;

  let widestGap = MIN_GAP;
  for (const entry of resolved) {
    if (adjacent(entry) && entry.edge.label) {
      widestGap = Math.max(widestGap, labelExtent(entry.edge.label).main + 2 * CLEARANCE);
    }
  }
  const approvedStep = layers.length <= 1 ? 0 : (geometry.main - geometry.padMain * 2) / (layers.length - 1);
  const step = layers.length <= 1 ? 0 : Math.max(approvedStep, geometry.nodeMain + widestGap);
  const mainSize = Math.max(geometry.main, geometry.padMain * 2 + step * Math.max(0, lastLayer));
  const mainOf = (layer: number) => geometry.padMain + layer * step;
  for (const entry of placed.values()) entry.main = mainOf(entry.layer);

  const outerMargin = (geometry.padMain - geometry.nodeMain / 2) / 2;
  const channelAfter = (layer: number) =>
    layer < lastLayer ? mainOf(layer) + step / 2 : mainOf(layer) + geometry.nodeMain / 2 + outerMargin;
  const channelBefore = (layer: number) =>
    layer > 0 ? mainOf(layer) - step / 2 : mainOf(layer) - geometry.nodeMain / 2 - outerMargin;

  // --- Lanes outside the node band ------------------------------------------
  const laneEdges = resolved.filter((entry) => !adjacent(entry));
  const pitches = laneEdges.map((entry) =>
    Math.max(MIN_LANE_PITCH, entry.edge.label ? labelExtent(entry.edge.label).cross + 2 * CLEARANCE : 0),
  );
  const laneSpace = laneEdges.length ? LANE_GAP + pitches.reduce((sum, pitch) => sum + pitch, 0) : 0;
  const nodeCrossMin = Math.min(...[...placed.values()].map((entry) => entry.cross - geometry.nodeCross / 2));
  const crossShift = laneEdges.length ? laneSpace + Math.max(0, -nodeCrossMin) : 0;
  for (const entry of placed.values()) entry.cross += crossShift;
  const laneCross = new Map<(typeof resolved)[number], number>();
  let cursor = nodeCrossMin + crossShift - LANE_GAP;
  laneEdges.forEach((entry, index) => {
    laneCross.set(entry, cursor - pitches[index] / 2);
    cursor -= pitches[index];
  });
  const crossSize = geometry.cross + crossShift;

  // --- Mapping main/cross to x/y --------------------------------------------
  const point = (main: number, cross: number): Point => (landscape ? { x: main, y: cross } : { x: cross, y: main });
  const box = (main: number, cross: number, mainExtent: number, crossExtent: number): Box =>
    landscape
      ? { x: main - mainExtent / 2, y: cross - crossExtent / 2, width: mainExtent, height: crossExtent }
      : { x: cross - crossExtent / 2, y: main - mainExtent / 2, width: crossExtent, height: mainExtent };

  const nodes: LaidOutNode[] = [...placed.values()].map((entry) => ({
    node: entry.node,
    layer: entry.layer,
    box: box(entry.main, entry.cross, geometry.nodeMain, geometry.nodeCross),
  }));

  // --- Routes and label anchors ---------------------------------------------
  const anchors = resolved.map((entry) => {
    const { from, to } = entry;
    const exit = from.main + geometry.nodeMain / 2;
    const entrance = to.main - geometry.nodeMain / 2;
    if (adjacent(entry)) {
      const channel = channelAfter(from.layer);
      return {
        entry,
        route: [[exit, from.cross], [channel, from.cross], [channel, to.cross], [entrance, to.cross]],
        anchor: { main: channel, cross: (from.cross + to.cross) / 2 },
        // Where along its bend the label may slide if it meets another.
        slide: [Math.min(from.cross, to.cross), Math.max(from.cross, to.cross)] as const,
      };
    }
    const lane = laneCross.get(entry) ?? 0;
    const out = channelAfter(from.layer);
    const back = channelBefore(to.layer);
    return {
      entry,
      route: [[exit, from.cross], [out, from.cross], [out, lane], [back, lane], [back, to.cross], [entrance, to.cross]],
      anchor: { main: (out + back) / 2, cross: lane },
      slide: [lane, lane] as const,
    };
  });

  // Labels that share a gap can meet when their bends overlap; move the later
  // one along its own bend until it clears.
  const placedLabels: Array<{ main: number; cross: number; extent: { main: number; cross: number } }> = [];
  const labelFor = (item: (typeof anchors)[number]): EdgeLabel | null => {
    const text = item.entry.edge.label;
    if (!text) return null;
    const extent = labelExtent(text);
    let { cross } = item.anchor;
    for (const other of [...placedLabels].sort((a, b) => a.cross - b.cross)) {
      const clash =
        Math.abs(other.main - item.anchor.main) < (other.extent.main + extent.main) / 2 &&
        Math.abs(other.cross - cross) < (other.extent.cross + extent.cross) / 2;
      if (clash) cross = Math.min(item.slide[1], other.cross + (other.extent.cross + extent.cross) / 2);
    }
    placedLabels.push({ main: item.anchor.main, cross, extent });
    const centre = point(item.anchor.main, cross);
    const backing = labelBacking(text);
    return {
      text,
      x: centre.x,
      y: centre.y,
      box: { x: centre.x - backing.width / 2, y: centre.y - backing.height / 2, ...backing },
    };
  };

  const edges: LaidOutEdge[] = anchors.map((item) => ({
    edge: item.entry.edge,
    points: item.route.map(([main, cross]) => point(main, cross)),
    label: labelFor(item),
  }));

  const width = landscape ? mainSize : crossSize;
  const height = landscape ? crossSize : mainSize;
  const callout = anchorNodeId ? placeCallout(nodes, edges, anchorNodeId, width, height, orientation) : null;

  return {
    width,
    height,
    nodeWidth: landscape ? geometry.nodeMain : geometry.nodeCross,
    nodeHeight: landscape ? geometry.nodeCross : geometry.nodeMain,
    nodes,
    edges,
    callout,
  };
}

function boxesOverlap(a: Box, b: Box, clearance = 10): boolean {
  return !(
    a.x + a.width + clearance <= b.x ||
    b.x + b.width + clearance <= a.x ||
    a.y + a.height + clearance <= b.y ||
    b.y + b.height + clearance <= a.y
  );
}

export function placeCallout(
  nodes: LaidOutNode[],
  edges: LaidOutEdge[],
  targetNodeId: string,
  diagramWidth: number,
  diagramHeight: number,
  orientation: DiagramOrientation,
): DiagramCallout | null {
  if (orientation === 'portrait') return null;

  const target = nodes.find((n) => n.node.id === targetNodeId);
  if (!target) return null;

  const calloutWidth = 240;
  const calloutHeight = 80;
  const gap = 20;

  const candidates: Array<{
    placement: 'above' | 'below' | 'left' | 'right';
    box: Box;
    leader: Point[];
  }> = [
    {
      placement: 'above',
      box: {
        x: Math.max(10, Math.min(diagramWidth - calloutWidth - 10, target.box.x + (target.box.width - calloutWidth) / 2)),
        y: target.box.y - gap - calloutHeight,
        width: calloutWidth,
        height: calloutHeight,
      },
      leader: [
        { x: target.box.x + target.box.width / 2, y: target.box.y - gap },
        { x: target.box.x + target.box.width / 2, y: target.box.y },
      ],
    },
    {
      placement: 'below',
      box: {
        x: Math.max(10, Math.min(diagramWidth - calloutWidth - 10, target.box.x + (target.box.width - calloutWidth) / 2)),
        y: target.box.y + target.box.height + gap,
        width: calloutWidth,
        height: calloutHeight,
      },
      leader: [
        { x: target.box.x + target.box.width / 2, y: target.box.y + target.box.height + gap },
        { x: target.box.x + target.box.width / 2, y: target.box.y + target.box.height },
      ],
    },
    {
      placement: 'right',
      box: {
        x: target.box.x + target.box.width + gap,
        y: Math.max(10, Math.min(diagramHeight - calloutHeight - 10, target.box.y + (target.box.height - calloutHeight) / 2)),
        width: calloutWidth,
        height: calloutHeight,
      },
      leader: [
        { x: target.box.x + target.box.width + gap, y: target.box.y + target.box.height / 2 },
        { x: target.box.x + target.box.width, y: target.box.y + target.box.height / 2 },
      ],
    },
    {
      placement: 'left',
      box: {
        x: target.box.x - gap - calloutWidth,
        y: Math.max(10, Math.min(diagramHeight - calloutHeight - 10, target.box.y + (target.box.height - calloutHeight) / 2)),
        width: calloutWidth,
        height: calloutHeight,
      },
      leader: [
        { x: target.box.x - gap, y: target.box.y + target.box.height / 2 },
        { x: target.box.x, y: target.box.y + target.box.height / 2 },
      ],
    },
  ];

  for (const cand of candidates) {
    if (
      cand.box.x < 10 ||
      cand.box.x + cand.box.width > diagramWidth - 10 ||
      cand.box.y < 10 ||
      cand.box.y + cand.box.height > diagramHeight - 10
    ) {
      continue;
    }
    const overlapsOtherNode = nodes.some(
      (n) => n.node.id !== targetNodeId && boxesOverlap(cand.box, n.box, 12),
    );
    if (overlapsOtherNode) continue;

    const overlapsLabel = edges.some(
      (e) => e.label && boxesOverlap(cand.box, e.label.box, 8),
    );
    if (overlapsLabel) continue;

    return {
      targetNodeId,
      box: cand.box,
      leader: cand.leader,
      placement: cand.placement,
    };
  }

  return null;
}
