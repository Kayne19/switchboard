import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AgentPane, type PaneSelect } from './AgentPane';
import { agentColor, STAGE_COLORS } from './colors';
import { clockTime, decisionSummary, formatMs } from './explain';
import { chain, clampToClip, leftMid, rightMid, wire, wireMid, type Box, type Point } from './geometry';
import type { CallerItem, DebugState, FloorTrace, RouteTrace, Stage } from './reducer';
import { newestTraceId, routePath } from './reducer';

export type Selection = { type: 'trace'; id: string } | { type: 'floor'; id: string } | null;

const DRAWN_TRACES = 28;
const DRAWN_FLOORS = 8;
const CALLER_PAGE = 200;

// --- Caller lane -------------------------------------------------------------

const CallerEntry = memo(function CallerEntry({
  item,
  trace,
  floor,
  active,
  select,
}: {
  item: CallerItem;
  trace?: RouteTrace;
  floor?: FloorTrace;
  active: boolean;
  select: PaneSelect;
}) {
  if (item.type === 'utterance') {
    if (!trace) return null;
    const path = routePath(trace);
    return (
      <button
        type="button"
        className={`ci ci-utt${active ? ' active' : ''}${path.pending ? ' pending' : ''}`}
        data-anchor={`utt-${trace.id}`}
        onClick={() => select.trace(trace.id)}
      >
        <div className="ci-meta">
          <time>{clockTime(trace.firstTs)}</time>
          <span className="muted">→ {trace.talkingTo ?? '?'}</span>
          <span className="ci-id">{trace.id}</span>
        </div>
        <div className="ci-text">{trace.text ?? <span className="muted">(no transcript)</span>}</div>
        <div className="ci-path">
          {path.stages.map((stage) => (
            <span key={stage} className={`chip chip-${stage}`}>
              {stage}
            </span>
          ))}
          {path.destinations.map((destination, index) => (
            <span key={`${destination.agent}-${index}`} className="chip chip-dest">
              ⇢ {destination.agent}
            </span>
          ))}
          {path.pending && <span className="chip chip-pending">routing…</span>}
        </div>
      </button>
    );
  }
  if (item.type === 'floor') {
    if (!floor) return null;
    const text = floor.speech?.text ?? floor.rewrite?.rewritten ?? floor.message;
    const status = floor.released
      ? floor.released.how
      : floor.gates.length
        ? `gate ${floor.gates[floor.gates.length - 1].answer}`
        : floor.heldTs
          ? 'held'
          : 'requested';
    return (
      <button
        type="button"
        className={`ci ci-floor${active ? ' active' : ''}${floor.released ? '' : ' pending'}`}
        data-anchor={`floor-dst-${floor.id}`}
        onClick={() => select.floor(floor.id)}
      >
        <div className="ci-meta">
          <time>{clockTime(floor.firstTs)}</time>
          <span className="tag tag-floor">⇠ {floor.agent}</span>
          <span className="muted">{status}</span>
        </div>
        <div className="ci-text">{text}</div>
      </button>
    );
  }
  if (item.type === 'call') {
    return (
      <div className={`ci ci-call call-${item.phase}`}>
        ☎ call {item.phase} · {item.callId}
        {item.reason ? ` · ${item.reason}` : ''} · {clockTime(item.ts)}
      </div>
    );
  }
  return (
    <div className={`ci ci-speech${item.delivered ? '' : ' undelivered'}`}>
      <div className="ci-meta">
        <time>{clockTime(item.ts)}</time>
        <span className="muted">⇠ {item.agent}</span>
        <span className="muted">{item.delivered ? 'spoken' : `not spoken${item.reason ? `: ${item.reason}` : ''}`}</span>
      </div>
      <div className="ci-text">{item.text}</div>
    </div>
  );
});

function CallerLane({ state, selection, select }: { state: DebugState; selection: Selection; select: PaneSelect }) {
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [limit, setLimit] = useState(CALLER_PAGE);
  const items = state.callerLane.length > limit ? state.callerLane.slice(state.callerLane.length - limit) : state.callerLane;
  useLayoutEffect(() => {
    if (body.current && pinned.current) body.current.scrollTop = body.current.scrollHeight;
  }, [state.callerLane]);
  return (
    <section className="lane">
      <header className="col-head">
        <span className="col-num">00</span> CALLER
      </header>
      <div
        className="lane-body"
        ref={body}
        data-clip="caller"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
        }}
      >
        {state.callerLane.length > items.length && (
          <button type="button" className="earlier" onClick={() => setLimit(limit + CALLER_PAGE)}>
            show earlier
          </button>
        )}
        {items.length === 0 && <div className="empty">waiting for the caller</div>}
        {items.map((item) => {
          const trace = item.type === 'utterance' ? state.traces[item.traceId] : undefined;
          const floor = item.type === 'floor' ? state.floors[item.floorId] : undefined;
          const active =
            (selection?.type === 'trace' && item.type === 'utterance' && selection.id === item.traceId) ||
            (selection?.type === 'floor' && item.type === 'floor' && selection.id === item.floorId);
          return <CallerEntry key={item.seq} item={item} trace={trace} floor={floor} active={active} select={select} />;
        })}
      </div>
    </section>
  );
}

// --- Stage nodes ---------------------------------------------------------------

function StageNode({
  id,
  title,
  num,
  color,
  active,
  children,
}: {
  id: string;
  title: string;
  num: string;
  color: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`node${active ? ' active' : ''}`} data-anchor={`node-${id}`} style={{ ['--node' as string]: color }}>
      <div className="node-title">
        <span className="node-num">{num}</span>
        {title}
      </div>
      <div className="node-body">{children}</div>
    </div>
  );
}

function StageColumns({ state, focus, floorFocus }: { state: DebugState; focus?: RouteTrace; floorFocus?: FloorTrace }) {
  const path = focus ? routePath(focus) : null;
  const visited = (stage: Stage) => path?.stages.includes(stage) ?? false;
  const jevCalls = state.traceOrder.length;
  const openFloors = state.floorOrder.filter((id) => !state.floors[id]?.released).length;
  const lastGate = floorFocus?.gates[floorFocus.gates.length - 1];
  return (
    <>
      <section className="stage-col stage-first">
        <header className="col-head">
          <span className="col-num">01</span> JEV
        </header>
        <div className="band band-route">
          <StageNode id="jev" title="Jev router" num="R1" color={STAGE_COLORS.jev} active={visited('jev')}>
            {focus?.jevResponse ? (
              <>
                <div className={`kv ${focus.jevResponse.outcome === 'ok' ? '' : 'err'}`}>
                  {focus.jevResponse.outcome} · {formatMs(focus.jevResponse.latency_ms)}
                </div>
                {focus.decision && <div className="kv">{focus.decision.action}</div>}
                {focus.decision && <div className="kv dim">{focus.decision.rule}</div>}
              </>
            ) : focus?.jevRequest ? (
              <div className="kv blink">asking…</div>
            ) : (
              <div className="kv dim">idle</div>
            )}
            <div className="kv dim">{jevCalls} routed</div>
          </StageNode>
        </div>
        <div className="band band-floor">
          <StageNode id="rewrite" title="Rewrite" num="F3" color={STAGE_COLORS.floor} active={Boolean(floorFocus?.rewrite)}>
            {floorFocus?.rewrite ? <div className="kv">{formatMs(floorFocus.rewrite.latency_ms)}</div> : <div className="kv dim">—</div>}
            <div className="kv dim">utility</div>
          </StageNode>
        </div>
      </section>
      <section className="stage-col">
        <header className="col-head">
          <span className="col-num">02</span> UTILITY
        </header>
        <div className="band band-route">
          <StageNode id="utility" title="Utility LLM" num="R2" color={STAGE_COLORS.utility} active={visited('utility')}>
            {focus && focus.utility.length > 0 ? (
              focus.utility.map((attempt, index) => (
                <div key={index} className="kv">
                  <span className="dim">{attempt.attempt}</span> {attempt.decision ? decisionSummary(attempt.decision.decision).split(' ')[0] : '…'}
                </div>
              ))
            ) : (
              <div className="kv dim">not asked</div>
            )}
          </StageNode>
        </div>
        <div className="band band-floor">
          <StageNode id="gate" title="Good moment" num="F2" color={STAGE_COLORS.floor} active={Boolean(lastGate)}>
            {floorFocus && floorFocus.gates.length > 0 ? (
              floorFocus.gates.slice(-3).map((gate) => (
                <div key={gate.seq} className={`kv gate-${gate.answer}`}>
                  {gate.answer} · {formatMs(gate.latency_ms)}
                </div>
              ))
            ) : (
              <div className="kv dim">—</div>
            )}
            <div className="kv dim">jev gate</div>
          </StageNode>
        </div>
      </section>
      <section className="stage-col">
        <header className="col-head">
          <span className="col-num">03</span> OPERATOR
        </header>
        <div className="band band-route">
          <StageNode id="operator" title="Operator" num="R3" color={STAGE_COLORS.operator} active={visited('operator')}>
            {focus?.operatorHop ? <div className="kv">{focus.operatorHop.outcome}</div> : <div className="kv dim">not used</div>}
            {focus?.operatorTool && (
              <div className="kv">
                route → {focus.operatorTool.target} · {focus.operatorTool.mode}
              </div>
            )}
          </StageNode>
        </div>
        <div className="band band-floor">
          <StageNode id="hold" title="Floor hold" num="F1" color={STAGE_COLORS.floor} active={openFloors > 0}>
            <div className="kv">{openFloors} waiting</div>
            {floorFocus && <div className="kv dim">{floorFocus.agent}</div>}
          </StageNode>
        </div>
      </section>
    </>
  );
}

// --- Overlay -----------------------------------------------------------------

interface Geometry {
  anchors: Map<string, Box>;
  clips: Map<string, Box>;
  width: number;
  height: number;
}

function measure(container: HTMLElement): Geometry {
  const origin = container.getBoundingClientRect();
  const box = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height };
  };
  const anchors = new Map<string, Box>();
  for (const element of container.querySelectorAll('[data-anchor]')) anchors.set(element.getAttribute('data-anchor')!, box(element));
  const clips = new Map<string, Box>();
  for (const element of container.querySelectorAll('[data-clip]')) clips.set(element.getAttribute('data-clip')!, box(element));
  return { anchors, clips, width: origin.width, height: origin.height };
}

function useGeometry(container: RefObject<HTMLElement | null>, version: unknown): Geometry | null {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const frame = useRef(0);
  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (container.current) setGeometry(measure(container.current));
    });
  }, [container]);
  useLayoutEffect(() => {
    schedule();
  }, [version, schedule]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener('scroll', schedule, true);
    element.addEventListener('toggle', schedule, true);
    window.addEventListener('resize', schedule);
    const timer = setInterval(schedule, 1000);
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', schedule, true);
      element.removeEventListener('toggle', schedule, true);
      window.removeEventListener('resize', schedule);
      clearInterval(timer);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [container, schedule]);
  return geometry;
}

interface Wire {
  key: string;
  d: string;
  color: string;
  label?: { at: Point; text: string };
  dashed?: boolean;
}

interface DrawnRoute {
  id: string;
  kind: 'trace' | 'floor';
  wires: Wire[];
  motion: string[];
  end?: Point;
  pending: boolean;
}

function stageColor(stage: 'caller' | Stage): string {
  return STAGE_COLORS[stage];
}

function traceRoute(trace: RouteTrace, g: Geometry, lane: number, order: readonly string[]): DrawnRoute | null {
  const start = g.anchors.get(`utt-${trace.id}`);
  if (!start) return null;
  const path = routePath(trace);
  const dy = ((lane % 7) - 3) * 3;
  const origin = clampToClip(rightMid(start), g.clips.get('caller')).point;
  const ports = new Map<'caller' | Stage, { in: Point; out: Point }>();
  ports.set('caller', { in: origin, out: origin });
  for (const stage of path.stages) {
    const node = g.anchors.get(`node-${stage}`);
    if (node) ports.set(stage, { in: leftMid(node, dy), out: rightMid(node, dy) });
  }
  const wires: Wire[] = [];
  const spine: Point[] = [origin];
  for (const segment of path.segments) {
    const from = ports.get(segment.from);
    const to = ports.get(segment.to);
    if (!from || !to) continue;
    wires.push({
      key: `${segment.from}-${segment.to}`,
      d: wire(from.out, to.in),
      color: stageColor(segment.to),
      label: segment.label
        ? { at: segment.from === 'caller' ? { x: to.in.x - 30, y: to.in.y - 14 } : wireMid(from.out, to.in), text: segment.label }
        : undefined,
    });
    spine.push(to.in, to.out);
  }
  const motion: string[] = [];
  for (const [index, destination] of path.destinations.entries()) {
    const from = ports.get(destination.from) ?? ports.get('caller')!;
    const jack = busJack(g, `jack-in-${destination.agent}`, dy);
    if (!jack) continue;
    const color = agentColor(destination.agent, order);
    const d = `${wire(from.out, jack.entry)} L${jack.end.x.toFixed(1)},${jack.end.y.toFixed(1)}`;
    wires.push({ key: `dest-${index}`, d, color, dashed: jack.clipped, label: { at: { x: jack.end.x - 64, y: jack.end.y }, text: destination.label } });
    const reached = spine.indexOf(from.out);
    motion.push(`${chain(reached >= 0 ? spine.slice(0, reached + 1) : [origin, from.out])} ${d.replace(/^M/, 'L')}`);
  }
  const last = spine[spine.length - 1];
  if (path.pending) motion.push(chain(spine));
  return { id: trace.id, kind: 'trace', wires, motion, end: path.pending ? last : undefined, pending: path.pending };
}

/**
 * Where a wire meets a pane: it enters the patch bus at the left edge of the
 * pane row and runs along it to the pane's jack, so a route to the fourth
 * pane never crosses the first three.
 */
function busJack(g: Geometry, anchor: string, dy: number): { entry: Point; end: Point; clipped: boolean } | null {
  const jack = g.anchors.get(anchor);
  const panes = g.clips.get('panes');
  if (!jack || !panes) return null;
  const y = jack.y + jack.h / 2 + dy;
  const left = panes.x;
  const right = panes.x + panes.w - 8;
  const x = Math.min(right, Math.max(left + 8, jack.x));
  return { entry: { x: left, y }, end: { x, y }, clipped: x !== jack.x };
}

function floorRoute(floor: FloorTrace, g: Geometry, lane: number): DrawnRoute | null {
  const jack = busJack(g, `jack-out-${floor.agent}`, ((lane % 5) - 2) * 3);
  if (!jack) return null;
  const points: { at: Point; out: Point; label: string }[] = [];
  const hop = (id: string, label: string) => {
    const node = g.anchors.get(`node-${id}`);
    if (node) points.push({ at: rightMid(node), out: leftMid(node), label });
  };
  hop('hold', floor.heldTs !== undefined ? 'held' : 'requested');
  if (floor.gates.length > 0) {
    const last = floor.gates[floor.gates.length - 1];
    hop('gate', `${floor.gates.map((gate) => gate.answer).join('→')} ${formatMs(last.latency_ms)}`);
  }
  if (floor.rewrite) hop('rewrite', `rewrite ${formatMs(floor.rewrite.latency_ms)}`);
  const wires: Wire[] = [];
  const start = { x: jack.end.x + 5, y: jack.end.y };
  wires.push({
    key: 'f-bus',
    d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${jack.entry.x.toFixed(1)},${jack.entry.y.toFixed(1)}`,
    color: STAGE_COLORS.floor,
    dashed: jack.clipped,
    label: { at: { x: start.x - 56, y: start.y }, text: floor.agent },
  });
  const spine: Point[] = [start, jack.entry];
  let from = jack.entry;
  for (const [index, point] of points.entries()) {
    wires.push({
      key: `f-${index}`,
      d: wire(from, point.at),
      color: STAGE_COLORS.floor,
      label: index === 0 ? undefined : { at: wireMid(from, point.at), text: points[index - 1].label },
    });
    spine.push(point.at, point.out);
    from = point.out;
  }
  const target = g.anchors.get(`floor-dst-${floor.id}`);
  if (floor.released && target) {
    const end = clampToClip(rightMid(target), g.clips.get('caller')).point;
    const label = points.length ? `${points[points.length - 1].label} · ${floor.released.how}` : floor.released.how;
    wires.push({ key: 'f-end', d: wire(from, end), color: STAGE_COLORS.floor, label: { at: wireMid(from, end), text: label } });
    spine.push(end);
  }
  const motion = `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${jack.entry.x.toFixed(1)},${jack.entry.y.toFixed(1)} ${chain(spine.slice(1)).replace(/^M/, 'L')}`;
  return { id: floor.id, kind: 'floor', wires, motion: [motion], end: floor.released ? undefined : from, pending: !floor.released };
}

function RouteOverlay({
  state,
  geometry,
  highlight,
  animate,
  select,
}: {
  state: DebugState;
  geometry: Geometry | null;
  highlight: Set<string>;
  animate: Set<string>;
  select: PaneSelect;
}) {
  const routes = useMemo(() => {
    if (!geometry) return [];
    const drawn: DrawnRoute[] = [];
    const traceIds = state.traceOrder.slice(-DRAWN_TRACES);
    for (const [lane, id] of traceIds.entries()) {
      const trace = state.traces[id];
      const route = trace && traceRoute(trace, geometry, lane, state.paneOrder);
      if (route) drawn.push(route);
    }
    for (const [lane, id] of state.floorOrder.slice(-DRAWN_FLOORS).entries()) {
      const floor = state.floors[id];
      const route = floor && floorRoute(floor, geometry, lane);
      if (route) drawn.push(route);
    }
    for (const id of highlight) {
      if (drawn.some((route) => route.id === id)) continue;
      const route = state.traces[id]
        ? traceRoute(state.traces[id], geometry, 3, state.paneOrder)
        : state.floors[id]
          ? floorRoute(state.floors[id], geometry, 2)
          : null;
      if (route) drawn.push(route);
    }
    // Highlighted routes draw last, on top.
    return drawn.sort((a, b) => Number(highlight.has(a.id)) - Number(highlight.has(b.id)));
  }, [geometry, state.traceOrder, state.traces, state.floorOrder, state.floors, state.paneOrder, highlight]);

  if (!geometry) return null;
  // Wires run under the nodes and panes; their labels sit above everything.
  const labels = (
    <svg className="overlay overlay-labels" width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
      {routes
        .filter((route) => highlight.has(route.id))
        .map((route) => (
          <g key={`${route.kind}-${route.id}`}>
            {route.wires.map((segment) =>
              segment.label ? (
                <g
                  key={`${segment.key}-label`}
                  className="wire-label"
                  transform={`translate(${segment.label.at.x.toFixed(1)},${segment.label.at.y.toFixed(1)})`}
                >
                  <rect
                    x={-(segment.label.text.length * 3.3 + 6)}
                    y={-8}
                    width={segment.label.text.length * 6.6 + 12}
                    height={16}
                    rx={2}
                    stroke={segment.color}
                  />
                  <text textAnchor="middle" dy={4} fill={segment.color}>
                    {segment.label.text}
                  </text>
                </g>
              ) : null,
            )}
          </g>
        ))}
    </svg>
  );
  return (
    <>
      <svg className="overlay" width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {routes.map((route) => {
          const lit = highlight.has(route.id);
          const live = animate.has(route.id);
          const open = () => (route.kind === 'trace' ? select.trace(route.id) : select.floor(route.id));
          return (
            <g key={`${route.kind}-${route.id}`} className={`route${lit ? ' lit' : ''}${live ? ' live' : ''} route-${route.kind}`} onClick={open}>
              {route.wires.map((segment) => (
                <g key={segment.key}>
                  <path className="hit" d={segment.d} />
                  <path className={`wire${segment.dashed ? ' dashed' : ''}`} d={segment.d} stroke={segment.color} filter={lit ? 'url(#glow)' : undefined} />
                </g>
              ))}
              {live &&
                route.motion.map((motion, index) =>
                  motion ? (
                    <circle key={index} r={3.5} className="pulse-dot">
                      <animateMotion dur="1.6s" repeatCount="indefinite" path={motion} />
                    </circle>
                  ) : null,
                )}
              {route.pending && route.end && <circle className="pending-ring" cx={route.end.x} cy={route.end.y} r={6} />}
            </g>
          );
        })}
      </svg>
      {labels}
    </>
  );
}

// --- View --------------------------------------------------------------------

export function SwitchboardView({ state, selection, select }: { state: DebugState; selection: Selection; select: PaneSelect }) {
  const container = useRef<HTMLDivElement>(null);
  const geometry = useGeometry(container, state);
  const newest = newestTraceId(state);
  const newestFloor = state.floorOrder[state.floorOrder.length - 1];
  const focusTraceId = selection?.type === 'trace' ? selection.id : newest;
  const focus = focusTraceId ? state.traces[focusTraceId] : undefined;
  const floorFocusId = selection?.type === 'floor' ? selection.id : newestFloor;
  const floorFocus = floorFocusId ? state.floors[floorFocusId] : undefined;

  // While the newest utterance is still routing, keep the last finished
  // route lit too, so there is always one complete path on screen.
  const lastRouted = useMemo(() => {
    for (let index = state.traceOrder.length - 1; index >= 0; index -= 1) {
      const trace = state.traces[state.traceOrder[index]];
      if (trace && !routePath(trace).pending) return trace.id;
    }
    return undefined;
  }, [state.traceOrder, state.traces]);
  const liveFloor = newestFloor && !state.floors[newestFloor]?.released ? newestFloor : undefined;
  const highlight = useMemo(() => {
    const set = new Set<string>();
    if (selection) set.add(selection.id);
    else for (const id of [newest, lastRouted, liveFloor]) if (id) set.add(id);
    return set;
  }, [selection, newest, lastRouted, liveFloor]);
  const animate = useMemo(() => {
    const set = new Set<string>();
    for (const id of [newest, lastRouted, liveFloor, selection?.id]) if (id) set.add(id);
    return set;
  }, [newest, lastRouted, liveFloor, selection]);

  const agentStates = useMemo(() => new Map(state.agents.map((agent) => [agent.project, agent.state])), [state.agents]);

  return (
    <div className="board" ref={container}>
      <RouteOverlay state={state} geometry={geometry} highlight={highlight} animate={animate} select={select} />
      <CallerLane state={state} selection={selection} select={select} />
      <StageColumns state={state} focus={focus} floorFocus={floorFocus} />
      <div className="panes" data-clip="panes">
        <div className="bus-label bus-top">PATCH ▶</div>
        <div className="bus-label bus-bottom">◀ FLOOR</div>
        {state.paneOrder.map((agent) => {
          const pane = state.panes[agent];
          return pane ? (
            <AgentPane key={agent} pane={pane} color={agentColor(agent, state.paneOrder)} state={agentStates.get(agent)} select={select} lit={highlight} />
          ) : null;
        })}
      </div>
    </div>
  );
}
