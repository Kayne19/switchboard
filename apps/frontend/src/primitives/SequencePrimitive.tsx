import { useMemo } from 'react';
import type { NoteData, Semantic, SequenceDiagramData } from '../controller/types';
import { DrawingViewport, useDrawingViewport } from './DrawingViewport';
import type { DrawingMap } from './drawingScroll';
import { NoteMarker } from './NoteMarker';
import { LABEL_HEIGHT, SUB_LINE_HEIGHT, viewSequence, type LaidOutMessage, type Point } from './sequenceLayout';

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

const ARROW_LENGTH = 10;
// The pinned headers keep this much of the drawing under them.
const PINNED_MARGIN = 6;
const ARROW_HALF = 4.5;

// The arrowhead at a message's tip. A call's is a filled triangle; an
// async message's is open, two strokes meeting at the tip; a return keeps
// the filled head and is told apart by its dashed line.
function Arrowhead({ message, color }: { message: LaidOutMessage; color: string }) {
  const tip = message.points[message.points.length - 1];
  const back = message.direction === 'right' ? tip.x - ARROW_LENGTH : tip.x + ARROW_LENGTH;
  if (message.kind === 'async') {
    return (
      <path
        className="sequence-arrowhead sequence-arrowhead--open"
        d={`M ${back} ${tip.y - ARROW_HALF} L ${tip.x} ${tip.y} L ${back} ${tip.y + ARROW_HALF}`}
        fill="none"
        stroke={color}
        strokeWidth={message.message.active ? 2 : 1.4}
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  return (
    <path
      className="sequence-arrowhead"
      d={`M ${tip.x} ${tip.y} L ${back} ${tip.y - ARROW_HALF} L ${back} ${tip.y + ARROW_HALF} Z`}
      fill={color}
    />
  );
}

export function SequencePrimitive({
  data,
  focused = false,
  id,
  note,
}: {
  data: SequenceDiagramData;
  focused?: boolean;
  /** This diagram's object id: an anchored note only belongs to it when its `anchor.target` matches. */
  id: string;
  note?: NoteData | null;
}) {
  const { hostRef, width, height, scrollbar } = useDrawingViewport();
  // The anchor's target is part of the protocol: a note aimed at another
  // object that happens to name one of these actors is not ours. The note
  // itself stays in the rail; the actor it names carries the NOTE marker,
  // the rail badge's twin, in its header.
  const anchoredActorId = note?.anchor && note.anchor.target === id ? note.anchor.node : undefined;
  // The geometry follows the viewport's shape, and the drawing is fitted to
  // it, or scrolled in it once fitting would make it too small to read.
  const { layout, fit } = useMemo(
    () => viewSequence(data, { width, height, scrollbar }, anchoredActorId),
    [data, width, height, scrollbar, anchoredActorId],
  );
  // What the viewport tells a reader of an exchange that scrolls: its
  // messages, counted past each edge and kept whole at rest, and the
  // sketch its map draws (headers, lifelines, the arrows).
  const map = useMemo<DrawingMap>(() => {
    const parts = layout.messages.map((item) => {
      const xs = [...item.points.map((point) => point.x), item.label.box.x, item.label.box.x + item.label.box.width];
      const ys = [...item.points.map((point) => point.y), item.label.box.y, item.label.box.y + item.label.box.height];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { box: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, label: item.message.label };
    });
    return {
      parts,
      noun: { one: 'MESSAGE', many: 'MESSAGES' },
      marks: [],
      links: [],
      sketch: {
        boxes: layout.actors.map(({ actor, box }) => ({ box, tone: actor.id === anchoredActorId ? 'var(--orange)' : colors[actor.semantic ?? 'paper'] })),
        lines: [
          ...layout.actors.map(({ actor, x, box, lifelineEnd }) => ({ points: [{ x, y: box.y + box.height }, { x, y: lifelineEnd }], tone: colors[actor.semantic ?? 'paper'] })),
          ...layout.messages.map((item) => ({ points: item.points, tone: item.message.active ? 'var(--orange)' : 'var(--paper)' })),
        ],
      },
    };
  }, [layout, anchoredActorId]);
  // Messages resolve in order, but a long exchange is not made to wait on
  // them: the stagger shrinks so the last one is in within about a second.
  const stagger = Math.min(60, Math.floor(900 / Math.max(1, layout.messages.length)));

  // The headers are drawn twice when the exchange scrolls: in place, and
  // pinned over the viewport's top once the drawing scrolls under them.
  const actors = (
    <g className="sequence-actors">
      {layout.actors.map(({ actor, box, labelLines, labelY, subY, subLines, marker }, index) => {
        const isAnchored = anchoredActorId !== undefined && actor.id === anchoredActorId;
        const color = isAnchored ? 'var(--orange)' : colors[actor.semantic ?? 'paper'];
        const { width, height } = box;
        return (
          <g key={actor.id} transform={`translate(${box.x} ${box.y})`}>
            <g className={`sequence-actor__body${isAnchored ? ' sequence-actor__body--anchored' : ''}`} style={{ animationDelay: `${index * 50}ms` }}>
              <path
                className="sequence-actor__frame"
                d={`M 0 10 L 10 0 H ${width - 14} L ${width} 14 V ${height} H 12 L 0 ${height - 12} Z`}
                fill="var(--black, #000000)"
                stroke={color}
                strokeOpacity={isAnchored ? '1' : '.64'}
                strokeWidth={isAnchored ? '2.2' : '1.3'}
                vectorEffect="non-scaling-stroke"
                filter={isAnchored ? 'url(#sequence-anchor-glow)' : undefined}
              />
              <text
                x={width / 2}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="central"
                className="sequence-actor-label"
                fontSize={layout.actorLabelSize}
                fill={color}
              >
                {labelLines.length === 1
                  ? labelLines[0]
                  : labelLines.map((line, lineIndex) => (
                      <tspan key={lineIndex} x={width / 2} dy={lineIndex === 0 ? 0 : layout.actorLabelLineHeight}>
                        {line}
                      </tspan>
                    ))}
              </text>
              {subLines.length > 0 ? (
                <text
                  x={width / 2}
                  y={subY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="sequence-actor-sub"
                  fontSize={layout.actorSubSize}
                >
                  {subLines.map((line, lineIndex) => (
                    <tspan key={lineIndex} x={width / 2} dy={lineIndex === 0 ? 0 : SUB_LINE_HEIGHT}>
                      {line}
                    </tspan>
                  ))}
                </text>
              ) : null}
              {marker ? <NoteMarker box={marker} className="sequence-actor__marker" /> : null}
            </g>
          </g>
        );
      })}
    </g>
  );
  const headerBottom = Math.max(0, ...layout.actors.map((actor) => actor.box.y + actor.box.height));

  return (
    <div ref={hostRef} className={`sequence-primitive${focused ? ' sequence-primitive--focused' : ''}`} data-testid="sequence">
      <DrawingViewport drawing={layout} fit={fit} pinned={{ height: headerBottom + PINNED_MARGIN, content: actors }} map={map} ariaLabel={data.title ?? 'Sequence diagram'}>
        <defs>
          {/* The region is the whole drawing, not each message's bounding box:
              a straight message has a zero-height box, and a filter region
              derived from it would erase the message entirely. */}
          <filter id="sequence-active-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* An anchored actor's frame is drawn inside its header's
              translated group, where the drawing-wide region above would
              begin at the frame's own corner and cut the glow, and half the
              stroke, off its top and left edges. A frame has a real box, so
              this region is that box with room on every side. */}
          <filter id="sequence-anchor-glow" x="-25%" y="-50%" width="150%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="sequence-lifelines">
          {layout.actors.map(({ actor, x, box, lifelineEnd }) => (
            <line
              key={actor.id}
              className="sequence-lifeline"
              x1={x}
              y1={box.y + box.height}
              x2={x}
              y2={lifelineEnd}
              stroke={colors[actor.semantic ?? 'paper']}
              strokeOpacity="0.28"
              strokeDasharray="4 6"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {actors}
        <g className="sequence-messages">
          {layout.messages.map((item) => {
            const active = Boolean(item.message.active);
            const color = active ? 'var(--orange)' : 'var(--paper)';
            return (
              <g key={item.index} className={`sequence-message${active ? ' sequence-message--active' : ''}`} style={{ animationDelay: `${120 + item.index * stagger}ms` }}>
                <path
                  className="sequence-message__line"
                  d={pathThrough(item.points)}
                  fill="none"
                  stroke={color}
                  strokeOpacity={active ? 0.95 : 0.6}
                  strokeWidth={active ? 2 : 1.25}
                  strokeDasharray={item.kind === 'return' ? '7 5' : undefined}
                  vectorEffect="non-scaling-stroke"
                  filter={active ? 'url(#sequence-active-glow)' : undefined}
                />
                <Arrowhead message={item} color={color} />
              </g>
            );
          })}
        </g>
        {/* Labels paint last, each on a backing of its own, so no lifeline
            or loop can cover the words on a message. */}
        <g className="sequence-message-labels">
          {layout.messages.map((item) => (
            <g key={item.index} className="sequence-message-label-group" style={{ animationDelay: `${120 + layout.messages.length * stagger}ms` }}>
              <rect className="sequence-message-label__backing" {...item.label.box} />
              <text
                x={item.label.x}
                y={item.label.y}
                textAnchor={item.label.anchor}
                dominantBaseline="central"
                className="sequence-message-label"
                fill={item.message.active ? 'var(--orange)' : 'var(--paper)'}
              >
                {item.label.lines.map((line, lineIndex) => (
                  <tspan key={lineIndex} x={item.label.x} dy={lineIndex === 0 ? 0 : LABEL_HEIGHT}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          ))}
        </g>
      </DrawingViewport>
    </div>
  );
}
