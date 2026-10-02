import { memo, useLayoutEffect, useRef, useState } from 'react';
import { clockTime, decisionSummary, formatMs, preview } from './explain';
import { JsonView } from './Json';
import type { JsonValue } from './protocol';
import type { AgentPane as Pane, PaneItem } from './reducer';

const PAGE = 250;
// Context the agent was given rather than words from the caller: folded.
const COLLAPSED_SOURCES = new Set(['intro', 'brief', 'call_state', 'autonomous', 'routing_request', 'floor_rewrite', 'model_change']);
const MODULE_GLYPHS: Record<string, string> = { speak: '◉', display: '▣', request_to_speak: '⚑', view: '◎' };

export interface PaneSelect {
  trace(id: string): void;
  floor(id: string): void;
}

function moduleHeadline(name: string, args: JsonValue): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of ['text', 'message', 'title', 'path', 'kind']) {
      const value = args[key];
      if (typeof value === 'string') return value;
    }
  }
  return preview(args, 90) || name;
}

const Item = memo(function Item({ item, color, select, lit }: { item: PaneItem; color: string; select: PaneSelect; lit: boolean }) {
  switch (item.type) {
    case 'input': {
      const time = <time>{clockTime(item.ts)}</time>;
      if (COLLAPSED_SOURCES.has(item.source)) {
        return (
          <details className="pi pi-context">
            <summary>
              <span className="tag">{item.source}</span>
              <span className="muted">{preview(item.text, 70)}</span>
              {time}
            </summary>
            <pre className="pre-wrap">{item.text}</pre>
          </details>
        );
      }
      return (
        <div className="pi pi-input" onClick={item.utteranceId ? () => select.trace(item.utteranceId!) : undefined}>
          <div className="pi-meta">
            <span className="tag tag-in">{item.source}</span>
            {item.turnId && <span className="muted">{item.turnId}</span>}
            {time}
          </div>
          <div className="pi-text">{item.text}</div>
        </div>
      );
    }
    case 'text':
      return (
        <div
          className={`pi pi-text-out${item.final || item.superseded ? '' : ' streaming'}${item.superseded ? ' superseded' : ''}`}
          style={{ borderColor: color }}
        >
          <div className="pi-meta">
            <span className="tag" style={{ color }}>
              reply
            </span>
            {item.superseded ? (
              <span className="tag">piece · replaced by final</span>
            ) : (
              !item.final && <span className="tag tag-live">streaming · {item.parts}</span>
            )}
            <time>{clockTime(item.ts)}</time>
          </div>
          <div className="pi-text">
            {item.text}
            {!item.final && !item.superseded && <span className="cursor">▍</span>}
          </div>
        </div>
      );
    case 'tool':
      return (
        <details className={`pi pi-tool st-${item.status}`}>
          <summary>
            <span className="tool-glyph">{item.status === 'running' ? '◌' : item.status === 'ok' ? '✓' : '✕'}</span>
            <span className="tool-name">{item.tool}</span>
            <span className="muted tool-args">{preview(item.args, 64)}</span>
            <span className="tool-time">{item.endTs !== undefined ? formatMs(item.endTs - item.ts) : 'running'}</span>
          </summary>
          <div className="pi-body">
            {item.callId && <div className="muted">call {item.callId}</div>}
            <div className="sub">args</div>
            {item.args === undefined ? <div className="muted">not forwarded</div> : <JsonView value={item.args} openDepth={2} />}
            {item.result !== undefined && (
              <>
                <div className="sub">result</div>
                <JsonView value={item.result} openDepth={2} />
              </>
            )}
            {item.error && (
              <>
                <div className="sub err">error</div>
                <pre className="pre-wrap err">{item.error}</pre>
              </>
            )}
          </div>
        </details>
      );
    case 'module':
      return (
        <details className={`pi pi-module mod-${item.name}${item.ok === false ? ' st-error' : ''}`}>
          <summary>
            <span className="mod-glyph">{MODULE_GLYPHS[item.name] ?? '◆'}</span>
            <span className="mod-name">{item.name}</span>
            <span className="mod-head">{moduleHeadline(item.name, item.args)}</span>
            <span className="tool-time">{item.ok === undefined ? '…' : item.ok ? 'ok' : 'failed'}</span>
          </summary>
          <div className="pi-body">
            <div className="sub">args</div>
            <JsonView value={item.args} openDepth={2} />
            {item.detail !== undefined && (
              <>
                <div className="sub">result</div>
                <JsonView value={item.detail} openDepth={2} />
              </>
            )}
          </div>
        </details>
      );
    case 'turn':
      return (
        <div className={`pi pi-turn turn-${item.edge}`}>
          <span>
            {item.edge === 'start' ? '▶ turn' : '■ end'} {item.turnId} · gen {item.generation}
            {item.edge === 'end' && item.startTs !== undefined ? ` · ${formatMs(item.ts - item.startTs)}` : ''}
          </span>
        </div>
      );
    case 'speech':
      return (
        <div className={`pi pi-speech${item.delivered ? '' : ' undelivered'}`}>
          <span className="tag">{item.delivered ? '◉ spoken' : '✕ not spoken'}</span>
          <span className="pi-text">“{item.text}”</span>
          {item.reason && <span className="muted"> {item.reason}</span>}
        </div>
      );
    case 'routed':
      return (
        <button type="button" className={`pi pi-routed${lit ? ' lit' : ''}`} data-anchor={`routed-${item.seq}`} onClick={() => select.trace(item.utteranceId)}>
          <div className="pi-meta">
            <span className="tag tag-route">
              ⇢ {item.via} · {item.mode}
            </span>
            <span className="muted">{item.utteranceId}</span>
            <time>{clockTime(item.ts)}</time>
          </div>
          <div className="pi-text">{item.textPart}</div>
        </button>
      );
    case 'floor':
      return (
        <button
          type="button"
          className={`pi pi-floor${lit ? ' lit' : ''}`}
          data-anchor={`floor-src-${item.floorId}`}
          onClick={() => select.floor(item.floorId)}
        >
          <span className="tag tag-floor">⇠ floor request</span>
          <span className="pi-text">{item.message}</span>
        </button>
      );
    case 'rescue':
      return (
        <div className="pi pi-rescue">
          ⚠ rescue · gen {item.generation} · {item.reason}
        </div>
      );
    case 'utility':
      return (
        <div className={`pi pi-utility${item.done ? '' : ' streaming'}`} onClick={item.utteranceId ? () => select.trace(item.utteranceId!) : undefined}>
          <div className="pi-meta">
            <span className="tag tag-util">{item.purpose === 'rewrite' ? '» floor rewrite' : `» ${item.attempt}`}</span>
            {item.utteranceId && <span className="muted">{item.utteranceId}</span>}
            <span className="tool-time">{item.done ? formatMs(item.latencyMs) : 'thinking…'}</span>
          </div>
          {item.purpose === 'rewrite' ? (
            <div className="pi-text">
              <s className="muted">{item.prompt}</s>
              <br />→ {typeof item.decision === 'string' ? item.decision : preview(item.decision)}
            </div>
          ) : (
            <>
              {item.prompt && (
                <details className="pi-prompt">
                  <summary className="muted">{preview(item.prompt, 60)}</summary>
                  <pre className="pre-wrap">{item.prompt}</pre>
                </details>
              )}
              {item.done && <div className="pi-text">→ {decisionSummary(item.decision)}</div>}
            </>
          )}
        </div>
      );
  }
});

export const AgentPane = memo(function AgentPane({
  pane,
  color,
  state,
  select,
  lit,
}: {
  pane: Pane;
  color: string;
  state?: string;
  select: PaneSelect;
  lit: ReadonlySet<string>;
}) {
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [limit, setLimit] = useState(PAGE);
  const items = pane.items.length > limit ? pane.items.slice(pane.items.length - limit) : pane.items;

  useLayoutEffect(() => {
    const element = body.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [pane.items]);

  return (
    <section className="pane" style={{ ['--agent' as string]: color }} data-anchor={`pane-${pane.agent}`}>
      <div className="jack-strip jack-top">
        <span className="jack" data-anchor={`jack-in-${pane.agent}`} />
      </div>
      <header className="pane-head">
        <span className="dot" />
        <span className="pane-name">{pane.agent}</span>
        {state && <span className={`badge state-${state}`}>{state}</span>}
        {pane.openTurn && <span className="badge state-busy">turn {pane.openTurn}</span>}
        <span className="muted pane-count">
          {pane.tools} tools · {pane.items.length} items
        </span>
      </header>
      <div
        className="pane-body"
        ref={body}
        data-clip={`pane-${pane.agent}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
        }}
      >
        {pane.items.length > items.length && (
          <button type="button" className="earlier" onClick={() => setLimit(limit + PAGE)}>
            show {Math.min(PAGE, pane.items.length - items.length)} earlier
          </button>
        )}
        {items.length === 0 && <div className="empty">no activity yet</div>}
        {items.map((item) => (
          <Item
            key={item.seq}
            item={item}
            color={color}
            select={select}
            lit={(item.type === 'routed' && lit.has(item.utteranceId)) || (item.type === 'floor' && lit.has(item.floorId))}
          />
        ))}
      </div>
      <div className="jack-strip jack-bottom">
        <span className="jack jack-floor" data-anchor={`jack-out-${pane.agent}`} />
      </div>
    </section>
  );
});
