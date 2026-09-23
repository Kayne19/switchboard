import { motion, useReducedMotion } from 'motion/react';
import { useMemo, useRef } from 'react';
import type { DiagramData, DiagramEdge, DiagramNode, Semantic } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';

const colors: Record<Semantic, string> = {
  red: 'var(--red)',
  orange: 'var(--orange)',
  green: 'var(--green)',
  cyan: 'var(--cyan)',
  amber: 'var(--amber)',
  paper: 'var(--paper)',
  muted: 'var(--muted)',
};

type PositionedNode = DiagramNode & { x: number; y: number; layer: number; indexInLayer: number };

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

function edgePath(from: PositionedNode, to: PositionedNode, portrait: boolean, nodeWidth: number, nodeHeight: number) {
  if (portrait) {
    const startY = from.y + nodeHeight / 2;
    const endY = to.y - nodeHeight / 2;
    const midY = (startY + endY) / 2;
    return `M ${from.x} ${startY} V ${midY} H ${to.x} V ${endY}`;
  }
  const startX = from.x + nodeWidth / 2;
  const endX = to.x - nodeWidth / 2;
  const midX = (startX + endX) / 2;
  return `M ${startX} ${from.y} H ${midX} V ${to.y} H ${endX}`;
}

export function DiagramPrimitive({ data, focused = false }: { data: DiagramData; focused?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  const portrait = size.height > size.width * 1.05;
  const reduced = useReducedMotion();
  const viewBox = portrait ? { width: 700, height: 1000 } : { width: 1000, height: 620 };
  const nodeWidth = portrait ? 244 : 182;
  const nodeHeight = portrait ? 98 : 88;
  const layers = useMemo(() => createLayers(data.nodes, data.edges), [data.nodes, data.edges]);
  const positioned = useMemo(() => {
    const result: PositionedNode[] = [];
    const padMain = portrait ? 110 : 112;
    const mainSpan = (portrait ? viewBox.height : viewBox.width) - padMain * 2;
    const layerStep = layers.length <= 1 ? 0 : mainSpan / (layers.length - 1);
    layers.forEach((layerNodes, layerIndex) => {
      const crossMax = portrait ? viewBox.width : viewBox.height;
      const crossPad = portrait ? 96 : 82;
      const usable = crossMax - crossPad * 2;
      const step = layerNodes.length <= 1 ? 0 : usable / (layerNodes.length - 1);
      layerNodes.forEach((node, index) => {
        const cross = layerNodes.length === 1 ? crossMax / 2 : crossPad + index * step;
        result.push({
          ...node,
          layer: layerIndex,
          indexInLayer: index,
          x: portrait ? cross : padMain + layerIndex * layerStep,
          y: portrait ? padMain + layerIndex * layerStep : cross,
        });
      });
    });
    return result;
  }, [layers, portrait, viewBox.height, viewBox.width]);

  const byId = new Map(positioned.map((node) => [node.id, node]));
  const activeNodes = new Set(data.nodes.filter((node) => node.state === 'active').map((node) => node.id));
  const hasSingleActiveNode = activeNodes.size === 1;

  return (
    <div ref={hostRef} className={`diagram-primitive${focused ? ' diagram-primitive--focused' : ''}`} data-testid="diagram">
      <svg
        viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={data.title ?? 'System diagram'}
      >
        <defs>
          <filter id="active-edge-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="diagram-edges">
          {data.edges.map((edge, index) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const active = Boolean(
              edge.active || (hasSingleActiveNode && (activeNodes.has(edge.from) || activeNodes.has(edge.to))),
            );
            const color = colors[edge.semantic ?? 'paper'];
            const d = edgePath(from, to, portrait, nodeWidth, nodeHeight);
            const labelX = portrait ? (from.x + to.x) / 2 : (from.x + to.x) / 2;
            const labelY = portrait ? (from.y + to.y) / 2 : (from.y + to.y) / 2;
            return (
              <g key={`${edge.from}-${edge.to}`}>
                <motion.path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeOpacity={active ? 0.85 : 0.48}
                  strokeWidth={active ? 2 : 1.25}
                  strokeDasharray={active ? '10 8' : undefined}
                  vectorEffect="non-scaling-stroke"
                  filter={active ? 'url(#active-edge-glow)' : undefined}
                  initial={reduced ? undefined : { pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1, strokeDashoffset: active ? [0, -36] : 0 }}
                  transition={{
                    pathLength: { duration: 0.42, delay: index * 0.06 },
                    opacity: { duration: 0.2, delay: index * 0.06 },
                    strokeDashoffset: active ? { duration: 2.2, ease: 'linear', repeat: Infinity } : undefined,
                  }}
                />
                <circle cx={to.x} cy={portrait ? to.y - nodeHeight / 2 : to.y} r="3" fill={color} opacity=".9" />
                {edge.label ? (
                  <text x={labelX} y={labelY - 6} textAnchor="middle" className="diagram-edge-label" fill={color}>
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
        <g className="diagram-nodes">
          {positioned.map((node, index) => {
            const color = colors[node.semantic ?? 'paper'];
            return (
              <motion.g
                key={node.id}
                transform={`translate(${node.x - nodeWidth / 2} ${node.y - nodeHeight / 2})`}
                initial={reduced ? undefined : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.28, delay: 0.12 + index * 0.05 }}
              >
                <path
                  d={`M 0 14 L 14 0 H ${nodeWidth - 22} L ${nodeWidth} 22 V ${nodeHeight} H 18 L 0 ${nodeHeight - 18} Z`}
                  fill="var(--black, #000000)"
                  stroke={color}
                  strokeOpacity=".64"
                  strokeWidth="1.3"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1="16"
                  y1="39"
                  x2={nodeWidth - 16}
                  y2="39"
                  stroke={color}
                  strokeOpacity=".23"
                  vectorEffect="non-scaling-stroke"
                />
                <text x="18" y="28" className="diagram-node-label" fill={color}>
                  {node.label}
                </text>
                <text x="18" y="58" className="diagram-node-sub">
                  {node.sub}
                </text>
                {node.detail ? (
                  <text x="18" y="76" className="diagram-node-detail">
                    {node.detail}
                  </text>
                ) : null}
              </motion.g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
