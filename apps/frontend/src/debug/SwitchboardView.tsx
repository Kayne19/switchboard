import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { TechFrame } from '../primitives/TechFrame';
import { AgentPane, type PaneSelect } from './AgentPane';
import { clockTime, decisionSummary, formatMs } from './explain';
import { clampToClip, leftMid, rightMid, wire, wireMid, type Box, type Point } from './geometry';
import type { CallerItem, DebugState, FloorTrace, RouteTrace, Stage } from './reducer';
import { newestTraceId, routePath } from './reducer';

export type Selection = { type: 'trace'; id: string } | { type: 'floor'; id: string } | null;

const DRAWN_TRACES = 28;
const DRAWN_FLOORS = 8;
const CALLER_PAGE = 200;

// --- Caller lane -------------------------------------------------------------

/** The hops a trace took, as one line: `jev / utility → alpha / beta`. */
export function RoutePathLine({ trace }: { trace: RouteTrace }) {
  const path = routePath(trace);
  return (
    <div className="ci-path tech micro">
      <span className="ci-hops">{['caller', ...path.stages].join(' / ')}</span>
      {path.destinations.length > 0 && (
        <span className="ci-dest">→ {path.destinations.map((destination) => destination.agent).join(' / ')}</span>
      )}
      {path.pending && <span className="ci-pending">routing…</span>}
      {path.ended && (
        <span className="ci-ended" title={path.ended.reason}>
          ✕ {path.ended.label}
        </span>
      )}
    </div>
  );
}

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
        className={`ci ci-utt${active ? ' active' : ''}${path.pending ? ' pending' : ''}${path.ended ? ' ended' : ''}`}
        data-anchor={`utt-${trace.id}`}
        onClick={() => select.trace(trace.id)}
      >
        <div className="ci-meta tech micro">
          <span>to {trace.talkingTo ?? '?'}</span>
          <span className="ci-id">{trace.id}</span>
          <time>{clockTime(trace.firstTs)}</time>
        </div>
        <div className="ci-text">{trace.text ?? <span className="muted">(no transcript)</span>}</div>
        <RoutePathLine trace={trace} />
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
        <div className="ci-meta tech micro">
          <span className="ci-floor-tag">floor / {floor.agent}</span>
          <span>{status}</span>
          <time>{clockTime(floor.firstTs)}</time>
        </div>
        <div className="ci-text">{text}</div>
      </button>
    );
  }
  if (item.type === 'call') {
    return (
      <div className={`ci ci-call call-${item.phase} tech micro`}>
        call {item.phase} / {item.callId}
        {item.reason ? ` / ${item.reason}` : ''} / {clockTime(item.ts)}
      </div>
    );
  }
  return (
    <div className={`ci ci-speech${item.delivered ? '' : ' undelivered'}`}>
      <div className="ci-meta tech micro">
        <span>{item.agent}</span>
        <span className={item.delivered ? '' : 'semantic-red'}>
          {item.delivered ? 'spoken' : `not spoken${item.reason ? `: ${item.reason}` : ''}`}
        </span>
        <time>{clockTime(item.ts)}</time>
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
  const newest = newestTraceId(state);
  const talkingTo = newest ? state.traces[newest]?.talkingTo : undefined;
  useLayoutEffect(() => {
    if (body.current && pinned.current) body.current.scrollTop = body.current.scrollHeight;
  }, [state.callerLane]);
  return (
    <section className="card lane">
      <header className="card-head">
        <span className="card-title tech">Caller</span>
        {talkingTo && <span className="card-index tech micro">on {talkingTo}</span>}
      </header>
      <div
        className="card-body lane-body"
        ref={body}
        data-clip="caller"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
        }}
      >
        {state.callerLane.length > items.length && (
          <button type="button" className="earlier tech micro" onClick={() => setLimit(limit + CALLER_PAGE)}>
            show earlier
          </button>
        )}
        {items.length === 0 && <div className="empty tech micro">waiting for the caller</div>}
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

function StageNode({ id, title, active, children }: { id: string; title: string; active: boolean; children: ReactNode }) {
  return (
    <div className={`node${active ? ' active' : ''}`} data-anchor={`node-${id}`}>
      <TechFrame variant="panel" />
      <div className="node-title tech">{title}</div>
      <div className="node-body tech micro">{children}</div>
    </div>
  );
}

function Stages({ state, focus, floorFocus }: { state: DebugState; focus?: RouteTrace; floorFocus?: FloorTrace }) {
  const path = focus ? routePath(focus) : null;
  const visited = (stage: Stage) => path?.stages.includes(stage) ?? false;
  const openFloors = state.floorOrder.filter((id) => !state.floors[id]?.released).length;
  const lastGate = floorFocus?.gates[floorFocus.gates.length - 1];
  return (
    <section className="stages">
      <div className="band band-route">
        <div className="band-label tech micro">
          <span>Route</span>
          <span className="muted">{focus ? focus.id : 'no utterance yet'}</span>
        </div>
        <div className="band-nodes">
          <StageNode id="jev" title="Jev" active={visited('jev')}>
            {focus?.jevResponse ? (
              <>
                <div className={focus.jevResponse.outcome === 'ok' ? '' : 'semantic-red'}>
                  {focus.jevResponse.outcome} / {formatMs(focus.jevResponse.latency_ms)}
                </div>
                {focus.decision && <div className="node-value">{focus.decision.action}</div>}
                {focus.decision && <div className="muted">{focus.decision.rule}</div>}
              </>
            ) : focus?.jevRequest && path?.ended ? (
              <div className="muted">no answer / {path.ended.label}</div>
            ) : focus?.jevRequest ? (
              <div className="semantic-orange">asking…</div>
            ) : (
              <div className="muted">idle</div>
            )}
          </StageNode>
          <StageNode id="utility" title="Utility" active={visited('utility')}>
            {focus && focus.utility.length > 0 ? (
              focus.utility.map((attempt, index) => (
                <div key={index}>
                  <span className="muted">{attempt.attempt}</span>{' '}
                  <span className="node-value">{attempt.decision ? decisionSummary(attempt.decision.decision).split(' ')[0] : '…'}</span>
                </div>
              ))
            ) : (
              <div className="muted">not asked</div>
            )}
          </StageNode>
          <StageNode id="operator" title="Operator" active={visited('operator')}>
            {focus?.operatorHop ? <div className="node-value">{focus.operatorHop.outcome}</div> : <div className="muted">not used</div>}
            {focus?.operatorTool && (
              <div>
                route → {focus.operatorTool.target} / {focus.operatorTool.mode}
              </div>
            )}
          </StageNode>
        </div>
      </div>
      <div className="band band-floor">
        <div className="band-label tech micro">
          <span>Floor</span>
          <span className="muted">{openFloors} waiting</span>
        </div>
        <div className="band-nodes">
          <StageNode id="rewrite" title="Rewrite" active={Boolean(floorFocus?.rewrite)}>
            {floorFocus?.rewrite ? <div className="node-value">{formatMs(floorFocus.rewrite.latency_ms)}</div> : <div className="muted">—</div>}
            <div className="muted">utility</div>
          </StageNode>
          <StageNode id="gate" title="Good moment" active={Boolean(lastGate)}>
            {floorFocus && floorFocus.gates.length > 0 ? (
              floorFocus.gates.slice(-3).map((gate) => (
                <div key={gate.seq} className={`gate-${gate.answer}`}>
                  {gate.answer} / {formatMs(gate.latency_ms)}
                </div>
              ))
            ) : (
              <div className="muted">—</div>
            )}
            <div className="muted">jev gate</div>
          </StageNode>
          <StageNode id="hold" title="Hold" active={openFloors > 0}>
            <div className="node-value">{openFloors} waiting</div>
            {floorFocus && <div className="muted">{floorFocus.agent}</div>}
          </StageNode>
        </div>
      </div>
    </section>
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
  label?: { at: Point; text: string };
  /** The far end lies outside the visible panes: drawn dashed. */
  clipped?: boolean;
}

interface DrawnRoute {
  id: string;
  kind: 'trace' | 'floor';
  wires: Wire[];
  /** Where the route stops while it is still in flight, or where it ended. */
  end?: Point;
  /** Each destination pane the route reached. */
  arrivals: Point[];
  pending: boolean;
  /** A trace the service ended with no destination: drawn with a stop mark. */
  ended?: string;
}

function traceRoute(trace: RouteTrace, g: Geometry, lane: number): DrawnRoute | null {
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
  let last = origin;
  for (const segment of path.segments) {
    const from = ports.get(segment.from);
    const to = ports.get(segment.to);
    if (!from || !to) continue;
    // Between two nodes the gap is narrower than a label, so the label sits
    // above the gap, clear of both nodes.
    const node = g.anchors.get(`node-${segment.to}`);
    const labelAt =
      segment.from === 'caller' ? { x: to.in.x - 40, y: to.in.y - 12 } : node ? { x: (from.out.x + to.in.x) / 2, y: node.y - 12 } : wireMid(from.out, to.in);
    wires.push({
      key: `${segment.from}-${segment.to}`,
      d: wire(from.out, to.in),
      label: segment.label ? { at: labelAt, text: segment.label } : undefined,
    });
    last = to.in;
  }
  const arrivals: Point[] = [];
  for (const [index, destination] of path.destinations.entries()) {
    const from = ports.get(destination.from) ?? ports.get('caller')!;
    const port = paneEntry(g, `port-in-${destination.agent}`, dy);
    if (!port) continue;
    const d = `${wire(from.out, port.entry)} H${port.end.x.toFixed(1)}`;
    wires.push({ key: `dest-${index}`, d, clipped: port.clipped, label: { at: { x: port.end.x - 70, y: port.end.y }, text: destination.label } });
    arrivals.push(port.end);
  }
  return { id: trace.id, kind: 'trace', wires, arrivals, end: path.pending || path.ended ? last : undefined, pending: path.pending, ended: path.ended?.label };
}

/**
 * Where a line meets a pane: it enters the strip above (or below) the pane
 * row at its left edge and runs along it to the pane, so a route to the
 * fourth pane never crosses the first three.
 */
function paneEntry(g: Geometry, anchor: string, dy: number): { entry: Point; end: Point; clipped: boolean } | null {
  const port = g.anchors.get(anchor);
  const panes = g.clips.get('panes');
  if (!port || !panes) return null;
  const y = port.y + port.h / 2 + dy;
  const left = panes.x;
  const right = panes.x + panes.w - 8;
  const x = Math.min(right, Math.max(left + 8, port.x));
  return { entry: { x: left, y }, end: { x, y }, clipped: x !== port.x };
}

function floorRoute(floor: FloorTrace, g: Geometry, lane: number): DrawnRoute | null {
  const port = paneEntry(g, `port-out-${floor.agent}`, ((lane % 5) - 2) * 3);
  if (!port) return null;
  const points: { at: Point; out: Point; box: Box; label: string }[] = [];
  const hop = (id: string, label: string) => {
    const node = g.anchors.get(`node-${id}`);
    if (node) points.push({ at: rightMid(node), out: leftMid(node), box: node, label });
  };
  hop('hold', floor.heldTs !== undefined ? 'held' : 'requested');
  if (floor.gates.length > 0) {
    const last = floor.gates[floor.gates.length - 1];
    hop('gate', `${floor.gates.map((gate) => gate.answer).join('→')} ${formatMs(last.latency_ms)}`);
  }
  if (floor.rewrite) hop('rewrite', `rewrite ${formatMs(floor.rewrite.latency_ms)}`);
  const wires: Wire[] = [];
  wires.push({
    key: 'f-out',
    d: `M${port.end.x.toFixed(1)},${port.end.y.toFixed(1)} H${port.entry.x.toFixed(1)}`,
    clipped: port.clipped,
    label: { at: { x: port.end.x - 56, y: port.end.y }, text: floor.agent },
  });
  let from = port.entry;
  for (const [index, point] of points.entries()) {
    wires.push({
      key: `f-${index}`,
      d: wire(from, point.at),
      // Above the gap between the two nodes, clear of both.
      label: index === 0 ? undefined : { at: { x: (from.x + point.at.x) / 2, y: point.box.y - 12 }, text: points[index - 1].label },
    });
    from = point.out;
  }
  const target = g.anchors.get(`floor-dst-${floor.id}`);
  const arrivals: Point[] = [];
  if (floor.released && target) {
    const end = clampToClip(rightMid(target), g.clips.get('caller')).point;
    const lastHop = points[points.length - 1];
    const label = lastHop ? `${lastHop.label} · ${floor.released.how}` : floor.released.how;
    // On the line's vertical run, below the last node.
    const at = lastHop ? { x: (from.x + end.x) / 2, y: lastHop.box.y + lastHop.box.h + 14 } : wireMid(from, end);
    wires.push({ key: 'f-end', d: wire(from, end), label: { at, text: label } });
    arrivals.push(end);
  }
  return { id: floor.id, kind: 'floor', wires, arrivals, end: floor.released ? undefined : from, pending: !floor.released };
}

/** An edge label as the main page's diagram draws one: mono text on a black backing. */
function WireLabel({ at, text }: { at: Point; text: string }) {
  const width = text.length * 7.3 + 12;
  return (
    <g className="wire-label diagram-edge-label-group" transform={`translate(${at.x.toFixed(1)},${at.y.toFixed(1)})`}>
      <rect className="diagram-edge-label__backing" x={-width / 2} y={-9} width={width} height={18} />
      <text className="diagram-edge-label" textAnchor="middle" dy={4}>
        {text}
      </text>
    </g>
  );
}

function RouteOverlay({
  state,
  geometry,
  highlight,
  select,
}: {
  state: DebugState;
  geometry: Geometry | null;
  highlight: Set<string>;
  select: PaneSelect;
}) {
  const routes = useMemo(() => {
    if (!geometry) return [];
    const drawn: DrawnRoute[] = [];
    const traceIds = state.traceOrder.slice(-DRAWN_TRACES);
    for (const [lane, id] of traceIds.entries()) {
      const trace = state.traces[id];
      const route = trace && traceRoute(trace, geometry, lane);
      if (route) drawn.push(route);
    }
    for (const [lane, id] of state.floorOrder.slice(-DRAWN_FLOORS).entries()) {
      const floor = state.floors[id];
      const route = floor && floorRoute(floor, geometry, lane);
      if (route) drawn.push(route);
    }
    for (const id of highlight) {
      if (drawn.some((route) => route.id === id)) continue;
      const route = state.traces[id] ? traceRoute(state.traces[id], geometry, 3) : state.floors[id] ? floorRoute(state.floors[id], geometry, 2) : null;
      if (route) drawn.push(route);
    }
    // Highlighted routes draw last, on top.
    return drawn.sort((a, b) => Number(highlight.has(a.id)) - Number(highlight.has(b.id)));
  }, [geometry, state.traceOrder, state.traces, state.floorOrder, state.floors, highlight]);

  if (!geometry) return null;
  const viewBox = `0 0 ${geometry.width} ${geometry.height}`;
  // Lines run under the nodes and panes; their labels sit above everything.
  return (
    <>
      <svg className="overlay" width={geometry.width} height={geometry.height} viewBox={viewBox}>
        {routes.map((route) => {
          const lit = highlight.has(route.id);
          const open = () => (route.kind === 'trace' ? select.trace(route.id) : select.floor(route.id));
          return (
            <g
              key={`${route.kind}-${route.id}`}
              className={`route route-${route.kind}${lit ? ' lit' : ''}${lit && route.pending ? ' in-flight' : ''}`}
              onClick={open}
            >
              {route.wires.map((segment) => (
                <g key={segment.key}>
                  <path className="hit" d={segment.d} />
                  <path className={`wire${segment.clipped ? ' clipped' : ''}`} d={segment.d} />
                </g>
              ))}
              {lit && route.arrivals.map((point, index) => <circle key={index} className="arrival" cx={point.x} cy={point.y} r={2.5} />)}
              {route.pending && route.end && <circle className="pending-mark" cx={route.end.x} cy={route.end.y} r={4} />}
              {route.ended && route.end && (
                <g className="end-mark" transform={`translate(${route.end.x.toFixed(1)},${route.end.y.toFixed(1)})`}>
                  <title>{route.ended}</title>
                  <path d="M-4,-4 L4,4 M4,-4 L-4,4" />
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <svg className="overlay overlay-labels" width={geometry.width} height={geometry.height} viewBox={viewBox}>
        {routes
          .filter((route) => highlight.has(route.id))
          .map((route) => (
            <g key={`${route.kind}-${route.id}`} className={`route-${route.kind}`}>
              {route.wires.map((segment) => (segment.label ? <WireLabel key={`${segment.key}-label`} {...segment.label} /> : null))}
            </g>
          ))}
      </svg>
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

  const agentStates = useMemo(() => new Map(state.agents.map((agent) => [agent.project, agent.state])), [state.agents]);

  return (
    <div className="board" ref={container}>
      <RouteOverlay state={state} geometry={geometry} highlight={highlight} select={select} />
      <CallerLane state={state} selection={selection} select={select} />
      <Stages state={state} focus={focus} floorFocus={floorFocus} />
      <div className="panes" data-clip="panes">
        {state.paneOrder.map((agent) => {
          const pane = state.panes[agent];
          return pane ? <AgentPane key={agent} pane={pane} state={agentStates.get(agent)} select={select} lit={highlight} /> : null;
        })}
      </div>
    </div>
  );
}
