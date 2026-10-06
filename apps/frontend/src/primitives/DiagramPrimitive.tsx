import { useCallback, useEffect, useMemo } from 'react';
import type { DiagramData, NoteData, Semantic } from '../controller/types';
import { ARROW_LENGTH, LABEL_INSET, cornerTagBoxes, litEdges, nodeFramePath, viewDiagram, wrapGreedy, type DiagramLayout, type EdgeLabel, type EdgeStub } from './diagramLayout';
import { GlowFilters, LABEL_HEIGHT, pathThrough } from './drawingKit';
import { DrawingViewport, useDrawingView } from './DrawingViewport';
import type { Viewport } from './drawingFit';
import { viewWithMap, type DrawingMap } from './drawingScroll';
import type { Point } from './geometry';
import { NoteMarker, markedPart } from './NoteMarker';
import type { Slot } from './slot';
import { SEMANTIC_COLOR } from '../design/tokens';

const SEMANTICS = Object.keys(SEMANTIC_COLOR) as Semantic[];

// The arrowhead at an edge's target is ARROW_LENGTH user units, which the
// layout keeps labels clear of: it scales with the drawing, as the node
// frames do, while the stroke itself does not.

// The callout box is 240 units wide with 14 units of inset each side: about
// 32 characters of its 11-unit body face, or 34 of its 9-unit tracked tag.
const CALLOUT_LINE_CHARS = 32;
const CALLOUT_TAG_CHARS = 34;

/**
 * An edge's label, or a stub's names, on a backing of its own. A stub's
 * names line up on the side its line meets, so its arrow sits by the line.
 */
function EdgeLabelText({ label, color, align, delay, quiet }: { label: EdgeLabel; color: string; align: EdgeStub['align']; delay: number; quiet?: boolean[] }) {
  const x = align === 'start' ? label.box.x + LABEL_INSET : align === 'end' ? label.box.x + label.box.width - LABEL_INSET : label.x;
  return (
    <g className={`diagram-edge-label-group${quiet ? ' diagram-edge-label-group--stub' : ''}`} style={{ animationDelay: `${delay}ms` }}>
      <rect className="diagram-edge-label__backing" {...label.box} />
      <text x={x} y={label.y} textAnchor={align} dominantBaseline="central" className="diagram-edge-label" fill={color}>
        {label.lines.map((line, lineIndex) => (
          <tspan
            key={lineIndex}
            x={x}
            dy={lineIndex === 0 ? `${-(label.lines.length - 1) * 0.5 * LABEL_HEIGHT}` : LABEL_HEIGHT}
            className={quiet?.[lineIndex] ? 'diagram-edge-label__note' : undefined}
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

export function DiagramPrimitive({
  data,
  slot = 'primary',
  id,
  note,
  onCalloutChange,
}: {
  data: DiagramData;
  /** Where the graph is drawn. Only in the main slot may the note ride on the drawing as a callout where it fits; in an aux cell the rail shows it, in focus a panel of its own. */
  slot?: Slot;
  /** This diagram's object id: an anchored note only belongs to it when its `anchor.target` matches. */
  id: string;
  note?: NoteData | null;
  onCalloutChange?: (placed: boolean) => void;
}) {
  const callout = slot === 'primary';
  const anchoredNodeId = markedPart(note, id).node;
  const hasAnchoredNode = Boolean(anchoredNodeId && data.nodes.some((n) => n.id === anchoredNodeId));
  const anchor = hasAnchoredNode ? anchoredNodeId : undefined;
  // The layout is chosen for the viewport: as drawn for the approved canvas
  // when that reads, otherwise recomposed for this viewport and scrolled;
  // one that scrolls far enough to carry a map is laid out beside the map's
  // strip. Layouts of this graph and anchor are kept across resizes: the
  // approved one does not depend on the size, and a frame's only on its step.
  const layouts = useMemo(() => new Map<string, DiagramLayout>(), [data, anchor]);
  const view = useCallback(
    (viewport: Viewport) => viewWithMap(viewport, (each) => viewDiagram(data, each, anchor, layouts), (each) => each.orientation),
    [data, anchor, layouts],
  );
  const { hostRef, layout, fit, orientation, strip } = useDrawingView(view);
  const portrait = orientation === 'portrait';
  // A drawing that scrolls opens on the node its note names, or else on
  // where it begins: its first layer.
  const lead = useMemo(() => {
    const anchored = layout.nodes.find((node) => node.node.id === anchor);
    if (anchored) return anchored.box;
    const first = layout.nodes.filter((node) => node.layer === 0).map((node) => node.box);
    if (!first.length) return null;
    const x = Math.min(...first.map((box) => box.x));
    const y = Math.min(...first.map((box) => box.y));
    return { x, y, width: Math.max(...first.map((box) => box.x + box.width)) - x, height: Math.max(...first.map((box) => box.y + box.height)) - y };
  }, [layout, anchor]);
  // What the viewport tells a reader of a graph that scrolls: its nodes,
  // counted past each edge and kept whole at rest; its edges, named for
  // the node at the far end where they leave the view; and the sketch its
  // map draws.
  const map = useMemo<DrawingMap>(() => {
    const indexOf = new Map(layout.nodes.map(({ node }, index) => [node.id, index]));
    const toneOf = (semantic?: Semantic) => SEMANTIC_COLOR[semantic ?? 'paper'];
    // An edge drawn as stubs is linked by its two stub lines: where one
    // leaves the view, the rim names the edge's far end, as its names do (a
    // line several edges share is a link for each, so each far end is
    // named). The map draws each line once.
    const links = layout.edges.flatMap(({ edge, points, stubs }) => {
      const from = indexOf.get(edge.from);
      const to = indexOf.get(edge.to);
      if (from === undefined || to === undefined) return [];
      return (stubs ? [stubs.from.points, stubs.to.points] : [points]).map((line) => ({ points: line, from, to, tone: toneOf(edge.semantic) }));
    });
    const drawnOnce = new Set<Point[]>();
    const stubNames = [...new Set(layout.edges.flatMap(({ stubs }) => (stubs ? [stubs.from.label, stubs.to.label] : [])))];
    return {
      parts: layout.nodes.map(({ node, box }) => ({ box, label: node.label })),
      noun: ['NODE', 'NODES'],
      marks: [...layout.edges.flatMap(({ label }) => (label ? [label.box] : [])), ...stubNames.map((label) => label.box)],
      links,
      sketch: {
        boxes: layout.nodes.map(({ node, box }) => ({ box, tone: node.id === anchor ? 'var(--orange)' : toneOf(node.semantic) })),
        lines: links.filter(({ points }) => !drawnOnce.has(points) && drawnOnce.add(points)).map(({ points, tone }) => ({ points, tone })),
      },
    };
  }, [layout, anchor]);
  // The callout box fits three wrapped lines and a one-line tag. A longer
  // note — or a word or tag too wide for the box — is not truncated or
  // spilled over the diagram: it is treated as not fitting, so the note
  // stays in the rail with the matching badge and nothing is silently lost.
  const calloutLines =
    hasAnchoredNode && note
      ? wrapGreedy(note.segments.map((segment) => segment.text).join('').split(/\s+/), CALLOUT_LINE_CHARS)
      : [];
  const calloutFits =
    calloutLines.length > 0 &&
    calloutLines.length <= 3 &&
    calloutLines.every((line) => line.length <= CALLOUT_LINE_CHARS) &&
    (note?.tag?.length ?? 0) <= CALLOUT_TAG_CHARS;
  // A callout rides on the drawing; on one that scrolls it could sit out of
  // view, so there the note stays in the rail and the node carries the marker.
  const calloutPlaced = Boolean(callout && !portrait && !fit.scrollX && !fit.scrollY && layout.callout && calloutFits);

  // The scene drops the note from the rail while the callout carries it. A
  // diagram that goes away (a new scene, or a render error that leaves its
  // surface unavailable) takes the callout with it, so it hands the note back.
  useEffect(() => {
    onCalloutChange?.(calloutPlaced);
    return () => onCalloutChange?.(false);
  }, [calloutPlaced, onCalloutChange]);

  const lit = litEdges(data);
  const edges = layout.edges.map((laidOut, index) => {
    const { edge } = laidOut;
    return { ...laidOut, key: `${edge.from}-${edge.to}-${index}`, index, active: lit(edge), color: SEMANTIC_COLOR[edge.semantic ?? 'paper'] };
  });
  // Stubs, each drawn once: the stubs leaving one side of a node share a
  // line and a label, and the layout shares them only between edges of one
  // colour, lit or not alike (litEdges). A stub fades in with its first
  // edge.
  const stubs = (() => {
    const drawn = new Map<EdgeStub, { key: string; index: number; points: Point[]; label: EdgeLabel; align: EdgeStub['align']; quiet: boolean[]; head: boolean; color: string; semantic: Semantic; active: boolean }>();
    for (const edge of edges) {
      if (!edge.stubs) continue;
      for (const [end, stub] of [['from', edge.stubs.from], ['to', edge.stubs.to]] as const) {
        if (drawn.has(stub)) continue;
        const semantic = edge.edge.semantic ?? 'paper';
        drawn.set(stub, { key: `${edge.key}-${end}`, index: edge.index, points: stub.points, label: stub.label, align: stub.align, quiet: stub.quiet, head: end === 'to', color: edge.color, semantic, active: edge.active });
      }
    }
    return [...drawn.values()];
  })();

  return (
    <div ref={hostRef} className={`diagram-primitive${slot === 'focus' ? ' diagram-primitive--focused' : ''}`} data-testid="diagram">
      <DrawingViewport drawing={layout} fit={fit} lead={lead} map={map} strip={strip} ariaLabel={data.title ?? 'System diagram'}>
        <defs>
          <GlowFilters line="active-edge-glow" frame="diagram-node-glow" />
          {/* One arrowhead per colour: a marker cannot take its fill from the
              path it ends, so each edge points at the marker of its own hue. */}
          {SEMANTICS.map((semantic) => (
            <marker
              key={semantic}
              id={`diagram-arrow-${semantic}`}
              className="diagram-arrow"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth={ARROW_LENGTH}
              markerHeight={ARROW_LENGTH}
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 Z" fill={SEMANTIC_COLOR[semantic]} />
            </marker>
          ))}
        </defs>
        <g className="diagram-edges">
          {edges.map((edge, index) =>
            edge.stubs ? null : (
              <path
                key={edge.key}
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
                markerEnd={`url(#diagram-arrow-${edge.edge.semantic ?? 'paper'})`}
              />
            ),
          )}
          {/* An edge too long to follow is drawn as two stubs. The one
              leaving its source ends at the names of its targets, so it
              carries no arrowhead; the one reaching its target does. */}
          {stubs.map((stub) => (
            <path
              key={stub.key}
              className={`diagram-edge diagram-edge--stub${stub.active ? ' diagram-edge--active' : ''}`}
              style={{ animationDelay: `${stub.index * 60}ms` }}
              d={pathThrough(stub.points)}
              fill="none"
              stroke={stub.color}
              strokeOpacity={stub.active ? 0.85 : 0.48}
              strokeWidth={stub.active ? 2 : 1.25}
              strokeDasharray={stub.active ? '10 8' : undefined}
              vectorEffect="non-scaling-stroke"
              filter={stub.active ? 'url(#active-edge-glow)' : undefined}
              markerEnd={stub.head ? `url(#diagram-arrow-${stub.semantic})` : undefined}
            />
          ))}
        </g>
        <g className="diagram-nodes">
          {layout.nodes.map(({ node, box, lines, ruleY }, index) => {
            const isAnchored = hasAnchoredNode && node.id === anchoredNodeId;
            const state = node.state ?? 'todo';
            const color = isAnchored ? 'var(--orange)' : SEMANTIC_COLOR[node.semantic ?? 'paper'];
            // A blocked node is framed in red even when a note anchors it: the
            // anchor still shows in the label, the glow, and the badge or
            // leader. The frame's stroke is set here only; the stylesheet
            // leaves it alone.
            const frameColor = state === 'blocked' ? 'var(--red)' : color;
            const lit = isAnchored || state === 'active';
            // The glyph and the NOTE marker stand in a row clear of the
            // frame's cut corner and of the label (cornerTagBoxes).
            const tags = cornerTagBoxes(box.width, {
              glyph: state === 'done' || state === 'blocked',
              marker: isAnchored && !calloutPlaced,
            });
            return (
              <g key={node.id} transform={`translate(${box.x} ${box.y})`} data-state={state}>
                <g
                  className={`diagram-node__body diagram-node__body--${state}${isAnchored ? ' diagram-node__body--anchored' : ''}`}
                  style={{ animationDelay: `${120 + index * 50}ms` }}
                >
                  <path
                    className="diagram-node__frame"
                    d={nodeFramePath(box.width, box.height)}
                    fill="var(--black, #000000)"
                    stroke={frameColor}
                    strokeOpacity={lit || state === 'blocked' ? '1' : '.64'}
                    strokeWidth={lit ? '2.2' : '1.3'}
                    vectorEffect="non-scaling-stroke"
                    filter={lit ? 'url(#diagram-node-glow)' : undefined}
                  />
                  <line
                    x1="16"
                    y1={ruleY}
                    x2={box.width - 16}
                    y2={ruleY}
                    stroke={frameColor}
                    strokeOpacity={lit ? '.45' : '.23'}
                    vectorEffect="non-scaling-stroke"
                  />
                  {lines.map((line, lineIndex) => (
                    <text key={lineIndex} x="18" y={line.y} className={`diagram-node-${line.kind}`} fill={line.kind === 'label' ? color : undefined}>
                      {line.text}
                    </text>
                  ))}
                  {tags.glyph ? (
                    <g className={`diagram-node__tag diagram-node__tag--${state}`} transform={`translate(${tags.glyph.x}, ${tags.glyph.y})`}>
                      <rect width={tags.glyph.width} height={tags.glyph.height} fill="#000" stroke={frameColor} strokeOpacity=".7" strokeWidth="1" />
                      {state === 'done' ? (
                        <polyline points="4,8 7.5,11.5 14,4" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="square" />
                      ) : (
                        <path d="M 5 4 L 13 11 M 13 4 L 5 11" fill="none" stroke="var(--red)" strokeWidth="1.6" strokeLinecap="square" />
                      )}
                    </g>
                  ) : null}
                  {tags.marker ? <NoteMarker box={tags.marker} className="diagram-node__marker" /> : null}
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
          {edges.map((edge) => (edge.label ? <EdgeLabelText key={edge.key} label={edge.label} color={edge.color} align="middle" delay={120 + edges.length * 50} /> : null))}
          {stubs.map((stub) => (
            <EdgeLabelText key={`${stub.key}-names`} label={stub.label} color={stub.color} align={stub.align} delay={120 + edges.length * 50} quiet={stub.quiet} />
          ))}
        </g>
      </DrawingViewport>
    </div>
  );
}
