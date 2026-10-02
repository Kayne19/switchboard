import { useMemo, useState } from 'react';
import { clockTime, formatMs } from '../explain';
import type { DebugState } from '../reducer';
import type { PaneSelect } from '../AgentPane';

const WINDOWS = [
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: 'all', ms: Infinity },
];

const ROW = 30;
const LABEL = 120;
const WIDTH = 1400;

export function TimelinePanel({ state, select }: { state: DebugState; select: PaneSelect }) {
  const [window, setWindow] = useState(WINDOWS[1]);
  const { t0, t1 } = useMemo(() => {
    const stamps = [
      ...state.traceOrder.map((id) => state.traces[id]?.firstTs ?? 0),
      ...state.turns.flatMap((turn) => [turn.startTs, turn.endTs ?? turn.startTs]),
      ...state.floorOrder.map((id) => state.floors[id]?.lastTs ?? 0),
      ...state.rescues.map((rescue) => rescue.timestamp_ms),
    ].filter((ts) => ts > 0);
    const end = stamps.length ? Math.max(...stamps) + 1000 : Date.now();
    const start = stamps.length ? Math.min(...stamps) - 500 : end - 60_000;
    return { t0: Number.isFinite(window.ms) ? Math.max(start, end - window.ms) : start, t1: end };
  }, [state, window]);
  const x = (ts: number) => LABEL + ((ts - t0) / Math.max(1, t1 - t0)) * (WIDTH - LABEL - 10);
  const rows = ['caller', ...state.paneOrder];
  const height = rows.length * ROW + 30;
  const ticks = 8;
  return (
    <div className="panel">
      <div className="panel-bar">
        <h2 className="tech">Turn timeline</h2>
        <div className="seg">
          {WINDOWS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`tech micro${option === window ? ' on' : ''}`}
              aria-pressed={option === window}
              onClick={() => setWindow(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="tech micro muted">
          {state.turns.length} turns / {state.rescues.length} rescues
        </span>
      </div>
      <div className="timeline-wrap">
        <svg className="timeline" viewBox={`0 0 ${WIDTH} ${height}`} width="100%" preserveAspectRatio="xMinYMin meet">
          {Array.from({ length: ticks + 1 }, (_, index) => {
            const ts = t0 + ((t1 - t0) * index) / ticks;
            return (
              <g key={index}>
                <line className="tick" x1={x(ts)} x2={x(ts)} y1={0} y2={height - 20} />
                <text className="tick-label" x={x(ts)} y={height - 6} textAnchor="middle">
                  {clockTime(ts).slice(0, 8)}
                </text>
              </g>
            );
          })}
          {rows.map((row, index) => (
            <g key={row} transform={`translate(0, ${index * ROW})`}>
              <rect className="lane-bg" x={0} y={2} width={WIDTH} height={ROW - 4} />
              <text className="row-label" x={8} y={ROW / 2 + 4}>
                {row}
              </text>
            </g>
          ))}
          {state.traceOrder.map((id) => {
            const trace = state.traces[id];
            if (!trace || trace.firstTs < t0) return null;
            return (
              <g key={id} className="tl-utt" onClick={() => select.trace(id)}>
                <title>{`${id}: ${trace.text ?? ''}`}</title>
                <circle cx={x(trace.firstTs)} cy={ROW / 2} r={5} />
                {trace.routed.map((routed) => {
                  const row = rows.indexOf(routed.to_agent);
                  return row < 0 ? null : (
                    <line
                      key={routed.seq}
                      className="tl-route"
                      x1={x(trace.firstTs)}
                      y1={ROW / 2}
                      x2={x(routed.timestamp_ms)}
                      y2={row * ROW + ROW / 2}
                    />
                  );
                })}
              </g>
            );
          })}
          {state.turns.map((turn) => {
            const row = rows.indexOf(turn.agent);
            const end = turn.endTs ?? t1;
            if (row < 0 || end < t0) return null;
            const left = x(Math.max(turn.startTs, t0));
            return (
              <g key={`${turn.agent}-${turn.startSeq}`} onClick={turn.utteranceId ? () => select.trace(turn.utteranceId!) : undefined}>
                <title>{`${turn.agent} ${turn.turnId} gen ${turn.generation} · ${turn.endTs ? formatMs(turn.endTs - turn.startTs) : 'open'}`}</title>
                <rect
                  className={`tl-turn${turn.endTs ? '' : ' open'}`}
                  x={left}
                  y={row * ROW + 7}
                  width={Math.max(3, x(end) - left)}
                  height={ROW - 14}
                />
              </g>
            );
          })}
          {state.traceOrder.flatMap((id) =>
            (state.traces[id]?.utility ?? []).map((attempt, index) => {
              const row = rows.indexOf('utility');
              const start = attempt.request?.timestamp_ms ?? attempt.decision?.timestamp_ms;
              if (row < 0 || start === undefined || start < t0) return null;
              const end = attempt.decision?.timestamp_ms ?? t1;
              return (
                <g key={`${id}-${index}`} onClick={() => select.trace(id)}>
                  <title>{`${id} utility ${attempt.attempt}`}</title>
                  <rect
                    className={`tl-turn tl-utility${attempt.decision ? '' : ' open'}`}
                    x={x(start)}
                    y={row * ROW + 7}
                    width={Math.max(3, x(end) - x(start))}
                    height={ROW - 14}
                  />
                </g>
              );
            }),
          )}
          {state.floorOrder.map((id) => {
            const floor = state.floors[id];
            if (!floor || floor.lastTs < t0) return null;
            const row = rows.indexOf(floor.agent);
            return (
              <g key={id} className="tl-floor" onClick={() => select.floor(id)}>
                <title>{`floor ${floor.agent}: ${floor.message}`}</title>
                <line x1={x(floor.firstTs)} x2={x(floor.released?.timestamp_ms ?? floor.lastTs)} y1={row * ROW + ROW - 5} y2={row * ROW + ROW - 5} />
                {floor.released && <line x1={x(floor.released.timestamp_ms)} x2={x(floor.released.timestamp_ms)} y1={row * ROW + ROW - 5} y2={ROW / 2} />}
              </g>
            );
          })}
          {state.rescues.map((rescue) =>
            rescue.timestamp_ms < t0 ? null : (
              <g key={rescue.seq}>
                <title>{`rescue gen ${rescue.generation}: ${rescue.reason}`}</title>
                <line className="tl-rescue" x1={x(rescue.timestamp_ms)} x2={x(rescue.timestamp_ms)} y1={0} y2={height - 20} />
              </g>
            ),
          )}
          {state.calls.map((call) =>
            [call.startTs, call.endTs].map((ts, index) =>
              ts === undefined || ts < t0 ? null : <line key={`${call.callId}-${index}`} className="tl-call" x1={x(ts)} x2={x(ts)} y1={0} y2={height - 20} />,
            ),
          )}
        </svg>
      </div>
    </div>
  );
}
