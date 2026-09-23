import { useMemo, useRef } from 'react';
import type { DiagramData, Semantic } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';
import { layoutDiagram, type Point } from './diagramLayout';

const colors: Record<Semantic, string> = {
  red: 'var(--red)',
  orange: 'var(--orange)',
  green: 'var(--green)',
  cyan: 'var(--cyan)',
  amber: 'var(--amber)',
  paper: 'var(--paper)',
  muted: 'var(--muted)',
};

const pathThrough = (points: Point[]) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

export function DiagramPrimitive({ data, focused = false }: { data: DiagramData; focused?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  const portrait = size.height > size.width * 1.05;
  const layout = useMemo(() => layoutDiagram(data, portrait ? 'portrait' : 'landscape'), [data, portrait]);
  const { nodeWidth, nodeHeight } = layout;

  const activeNodes = new Set(data.nodes.filter((node) => node.state === 'active').map((node) => node.id));
  const hasSingleActiveNode = activeNodes.size === 1;
  const edges = layout.edges.map((laidOut, index) => {
    const { edge } = laidOut;
    const active = Boolean(
      edge.active || (hasSingleActiveNode && (activeNodes.has(edge.from) || activeNodes.has(edge.to))),
    );
    return { ...laidOut, key: `${edge.from}-${edge.to}-${index}`, active, color: colors[edge.semantic ?? 'paper'] };
  });

  return (
    <div ref={hostRef} className={`diagram-primitive${focused ? ' diagram-primitive--focused' : ''}`} data-testid="diagram">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={data.title ?? 'System diagram'}
      >
        <defs>
          {/* The region is the whole drawing, not each edge's bounding box: a
              straight edge has a zero-height box, and a filter region derived
              from it would erase the edge entirely. */}
          <filter id="active-edge-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="diagram-edges">
          {edges.map((edge, index) => {
            const end = edge.points[edge.points.length - 1];
            return (
              <g key={edge.key}>
                <path
                  className={`diagram-edge${edge.active ? ' diagram-edge--active' : ''}`}
                  style={{ animationDelay: `${index * 60}ms` }}
                  d={pathThrough(edge.points)}
                  fill="none"
                  stroke={edge.color}
                  strokeOpacity={edge.active ? 0.85 : 0.48}
                  strokeWidth={edge.active ? 2 : 1.25}
                  strokeDasharray={edge.active ? '10 8' : undefined}
                  vectorEffect="non-scaling-stroke"
                  filter={edge.active ? 'url(#active-edge-glow)' : undefined}
                />
                <circle cx={end.x} cy={end.y} r="3" fill={edge.color} opacity=".9" />
              </g>
            );
          })}
        </g>
        <g className="diagram-nodes">
          {layout.nodes.map(({ node, box }, index) => {
            const color = colors[node.semantic ?? 'paper'];
            return (
              <g key={node.id} transform={`translate(${box.x} ${box.y})`}>
                <g className="diagram-node__body" style={{ animationDelay: `${120 + index * 50}ms` }}>
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
                </g>
              </g>
            );
          })}
        </g>
        {/* Labels paint last, each on a backing of its own, so no node or
            crossing edge can cover the words on an edge. */}
        <g className="diagram-edge-labels">
          {edges.map((edge) =>
            edge.label ? (
              <g key={edge.key} className="diagram-edge-label-group" style={{ animationDelay: `${120 + edges.length * 50}ms` }}>
                <rect className="diagram-edge-label__backing" {...edge.label.box} />
                <text x={edge.label.x} y={edge.label.y} textAnchor="middle" dominantBaseline="central" className="diagram-edge-label" fill={edge.color}>
                  {edge.label.text}
                </text>
              </g>
            ) : null,
          )}
        </g>
      </svg>
    </div>
  );
}
