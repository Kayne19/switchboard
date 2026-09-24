import { useEffect, useMemo, useRef } from 'react';
import type { DiagramData, NoteData, Semantic } from '../controller/types';
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

// The callout box is 240 units wide with 14 units of inset each side: about
// 32 characters of its 11-unit body face, or 34 of its 9-unit tracked tag.
const CALLOUT_LINE_CHARS = 32;
const CALLOUT_TAG_CHARS = 34;

function wrapText(text: string, maxCharsPerLine = CALLOUT_LINE_CHARS): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxCharsPerLine) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function DiagramPrimitive({
  data,
  focused = false,
  id,
  note,
  onCalloutChange,
}: {
  data: DiagramData;
  focused?: boolean;
  /** This diagram's object id: an anchored note only belongs to it when its `anchor.target` matches. */
  id: string;
  note?: NoteData | null;
  onCalloutChange?: (placed: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  // Until the host has been measured, the first frame must already pick the
  // right orientation: it falls back to the screen's own aspect ratio, so a
  // portrait phone never flashes a landscape callout before the observer
  // reports the real size.
  const sizeMeasured = size.width > 0 && size.height > 0;
  const portrait = sizeMeasured
    ? size.height > size.width * 1.05
    : window.innerHeight > window.innerWidth * 1.05;
  // The anchor's target is part of the protocol: a note aimed at another
  // object that happens to name one of this diagram's nodes is not ours.
  const anchoredNodeId =
    note?.anchor && note.anchor.target === id ? note.anchor.node : undefined;
  const hasAnchoredNode = Boolean(anchoredNodeId && data.nodes.some((n) => n.id === anchoredNodeId));
  const layout = useMemo(
    () => layoutDiagram(data, portrait ? 'portrait' : 'landscape', hasAnchoredNode ? anchoredNodeId : undefined),
    [data, portrait, hasAnchoredNode, anchoredNodeId],
  );
  const { nodeWidth, nodeHeight } = layout;
  // The callout box fits three wrapped lines and a one-line tag. A longer
  // note — or a word or tag too wide for the box — is not truncated or
  // spilled over the diagram: it is treated as not fitting, so the note
  // stays in the rail with the matching badge and nothing is silently lost.
  const calloutLines =
    hasAnchoredNode && note
      ? wrapText(note.segments.map((segment) => segment.text).join(''), CALLOUT_LINE_CHARS)
      : [];
  const calloutFits =
    calloutLines.length > 0 &&
    calloutLines.length <= 3 &&
    calloutLines.every((line) => line.length <= CALLOUT_LINE_CHARS) &&
    (note?.tag?.length ?? 0) <= CALLOUT_TAG_CHARS;
  const calloutPlaced = Boolean(!portrait && layout.callout && calloutFits);

  useEffect(() => {
    onCalloutChange?.(calloutPlaced);
  }, [calloutPlaced, onCalloutChange]);

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
            const isAnchored = hasAnchoredNode && node.id === anchoredNodeId;
            const color = isAnchored ? 'var(--orange)' : colors[node.semantic ?? 'paper'];
            return (
              <g key={node.id} transform={`translate(${box.x} ${box.y})`}>
                <g className={`diagram-node__body${isAnchored ? ' diagram-node__body--anchored' : ''}`} style={{ animationDelay: `${120 + index * 50}ms` }}>
                  <path
                    className="diagram-node__frame"
                    d={`M 0 14 L 14 0 H ${nodeWidth - 22} L ${nodeWidth} 22 V ${nodeHeight} H 18 L 0 ${nodeHeight - 18} Z`}
                    fill="var(--black, #000000)"
                    stroke={color}
                    strokeOpacity={isAnchored ? '1' : '.64'}
                    strokeWidth={isAnchored ? '2.2' : '1.3'}
                    vectorEffect="non-scaling-stroke"
                    filter={isAnchored ? 'url(#active-edge-glow)' : undefined}
                  />
                  <line
                    x1="16"
                    y1="39"
                    x2={nodeWidth - 16}
                    y2="39"
                    stroke={color}
                    strokeOpacity={isAnchored ? '.45' : '.23'}
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
                  {isAnchored && !calloutPlaced ? (
                    <g className="diagram-node__marker" transform={`translate(${nodeWidth - 36}, 6)`}>
                      <rect width="30" height="15" rx="2" fill="rgba(var(--orange-rgb), 0.25)" stroke="var(--orange)" strokeWidth="1" />
                      <text x="15" y="11" textAnchor="middle" fill="var(--orange)" fontSize="8.5" fontWeight="700" fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" letterSpacing="0.05em">
                        NOTE
                      </text>
                    </g>
                  ) : null}
                </g>
              </g>
            );
          })}
        </g>
        {calloutPlaced && layout.callout && note ? (
          <g className="diagram-callout" style={{ animationDelay: '150ms' }}>
            <path
              className="diagram-callout__leader"
              d={pathThrough(layout.callout.leader)}
              fill="none"
              stroke="var(--orange)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={layout.callout.leader[layout.callout.leader.length - 1].x}
              cy={layout.callout.leader[layout.callout.leader.length - 1].y}
              r="3"
              fill="var(--orange)"
            />
            <g transform={`translate(${layout.callout.box.x} ${layout.callout.box.y})`}>
              <path
                className="diagram-callout__box"
                d={`M 0 10 L 10 0 H ${layout.callout.box.width - 16} L ${layout.callout.box.width} 16 V ${layout.callout.box.height} H 12 L 0 ${layout.callout.box.height - 12} Z`}
                fill="#000000"
                stroke="rgba(var(--orange-rgb), 0.75)"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
              />
              {note.tag ? (
                <text x="14" y="20" className="diagram-callout__tag tech micro" fill="rgba(232, 230, 223, 0.4)" fontSize="9" letterSpacing="0.08em">
                  {note.tag}
                </text>
              ) : null}
              <text x="14" y={note.tag ? 37 : 24} className="diagram-callout__text" fill="var(--paper)" fontSize="11" fontFamily="'Helvetica Neue', Arial, sans-serif" letterSpacing="-0.01em">
                {calloutLines.map((line, idx) => (
                  <tspan key={idx} x="14" dy={idx === 0 ? 0 : 15}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        ) : null}
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
