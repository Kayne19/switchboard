import { useMemo, useRef } from 'react';
import type { NoteData, Semantic, SequenceDiagramData } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';
import { LABEL_HEIGHT, SUB_LINE_HEIGHT, layoutSequence, type LaidOutMessage, type Point } from './sequenceLayout';

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
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  // Until the host has been measured, the first frame must already pick the
  // right geometry: it falls back to the screen's own aspect ratio, so a
  // portrait phone never flashes the wide columns before the observer
  // reports the real size.
  const sizeMeasured = size.width > 0 && size.height > 0;
  const portrait = sizeMeasured
    ? size.height > size.width * 1.05
    : window.innerHeight > window.innerWidth * 1.05;
  const layout = useMemo(() => layoutSequence(data, portrait ? 'portrait' : 'landscape'), [data, portrait]);
  // The anchor's target is part of the protocol: a note aimed at another
  // object that happens to name one of these actors is not ours. The note
  // itself stays in the rail; the actor it names is marked.
  const anchoredActorId = note?.anchor && note.anchor.target === id ? note.anchor.node : undefined;
  // Messages resolve in order, but a long exchange is not made to wait on
  // them: the stagger shrinks so the last one is in within about a second.
  const stagger = Math.min(60, Math.floor(900 / Math.max(1, layout.messages.length)));

  return (
    <div ref={hostRef} className={`sequence-primitive${focused ? ' sequence-primitive--focused' : ''}`} data-testid="sequence">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={data.title ?? 'Sequence diagram'}
      >
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
        <g className="sequence-actors">
          {layout.actors.map(({ actor, box, subLines }, index) => {
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
                    filter={isAnchored ? 'url(#sequence-active-glow)' : undefined}
                  />
                  <text
                    x={width / 2}
                    y={actor.sub ? 22 : height / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="sequence-actor-label"
                    fontSize={layout.actorLabelSize}
                    fill={color}
                  >
                    {actor.label}
                  </text>
                  {subLines.length > 0 ? (
                    <text
                      x={width / 2}
                      y={39}
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
                </g>
              </g>
            );
          })}
        </g>
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
      </svg>
    </div>
  );
}
