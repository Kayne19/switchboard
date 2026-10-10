import { memo, useState } from 'react';
import { usePinnedScroll } from '../hooks/usePinnedScroll';
import { RichText } from '../primitives/RichText';
import { clockTime, decisionSummary, formatMs, preview } from './explain';
import { JsonView } from './Json';
import type { JsonValue } from './protocol';
import type { AgentPane as Pane, PaneItem } from './reducer';

const PAGE = 250;
// Context the agent was given rather than words from the caller: folded.
export const COLLAPSED_SOURCES = new Set(['intro', 'brief', 'routing_request', 'floor_rewrite', 'model_change']);

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

const CLIP_TITLE = 'The service cut this to the debug record bounds; the cut text ends with …[clipped]';

/** Marks an item whose record the service cut to the debug record bounds. */
function ClipTag({ clipped }: { clipped?: boolean }) {
  return clipped ? (
    <span className="tag-clip" title={CLIP_TITLE}>
      clipped
    </span>
  ) : null;
}

/** Agent prose, read as the main page reads it: the conversation Markdown subset. */
function Prose({ text }: { text: string }) {
  return (
    <div className="pi-text">
      <RichText segments={[{ text }]} />
    </div>
  );
}

/** The args and result of a call, folded under its summary line. */
function CallBody({ args, result, error, callId }: { args: JsonValue | undefined; result?: JsonValue; error?: string; callId?: string }) {
  return (
    <div className="pi-body">
      {callId && <div className="sub tech micro">call {callId}</div>}
      <div className="sub tech micro">args</div>
      {args === undefined ? <div className="muted">not forwarded</div> : <JsonView value={args} openDepth={2} />}
      {result !== undefined && (
        <>
          <div className="sub tech micro">result</div>
          <JsonView value={result} openDepth={2} />
        </>
      )}
      {error && (
        <>
          <div className="sub tech micro semantic-red">error</div>
          <pre className="rich-text__code-block semantic-red">{error}</pre>
        </>
      )}
    </div>
  );
}

const Item = memo(function Item({ item, select, lit }: { item: PaneItem; select: PaneSelect; lit: boolean }) {
  switch (item.type) {
    case 'input': {
      const time = <time>{clockTime(item.ts)}</time>;
      if (COLLAPSED_SOURCES.has(item.source)) {
        return (
          <details className="pi pi-context">
            <summary className="pi-meta tech micro">
              <span>{item.source}</span>
              <span className="pi-preview">{preview(item.text, 70)}</span>
              <ClipTag clipped={item.clipped} />
              {time}
            </summary>
            <pre className="rich-text__code-block">{item.text}</pre>
          </details>
        );
      }
      return (
        <div
          className={`pi pi-input${item.utteranceId ? ' clickable' : ''}`}
          onClick={item.utteranceId ? () => select.trace(item.utteranceId!) : undefined}
        >
          <div className="pi-meta tech micro">
            <span className="pi-tag">{item.source}</span>
            {item.turnId && <span>{item.turnId}</span>}
            <ClipTag clipped={item.clipped} />
            {time}
          </div>
          <div className="pi-text">{item.text}</div>
        </div>
      );
    }
    case 'text':
      return (
        <div className={`pi pi-reply${item.final || item.superseded ? '' : ' streaming'}${item.superseded ? ' superseded' : ''}`}>
          <div className="pi-meta tech micro">
            <span className="pi-tag">reply</span>
            {item.superseded ? (
              <span>piece / replaced by final</span>
            ) : (
              !item.final && <span className="semantic-orange">streaming / {item.parts}</span>
            )}
            <ClipTag clipped={item.clipped} />
            <time>{clockTime(item.ts)}</time>
          </div>
          <Prose text={item.text} />
        </div>
      );
    case 'tool': {
      const status =
        item.status === 'running' ? '● running' : `■ ${item.status === 'ok' ? 'done' : 'failed'} ${item.endTs !== undefined ? formatMs(item.endTs - item.ts) : ''}`;
      return (
        <details className={`pi pi-tool st-${item.status}`}>
          <summary className="pi-call">
            <span className="tool-activity__tool tech">{item.tool}</span>
            <span className="tool-activity__detail tech micro muted">{preview(item.args, 64)}</span>
            <ClipTag clipped={item.clipped} />
            <span
              className={`tool-activity__status tech micro tool-activity__status--${item.status === 'running' ? 'running' : 'done'}${item.status === 'error' ? ' semantic-red' : ''}`}
            >
              {status}
            </span>
          </summary>
          <CallBody args={item.args} result={item.result} error={item.error} callId={item.callId} />
        </details>
      );
    }
    case 'module':
      return (
        <details className={`pi pi-module mod-${item.name}${item.ok === false ? ' st-error' : ''}`}>
          <summary className="pi-call">
            <span className="pi-module-name tech">{item.name}</span>
            <span className="tool-activity__detail tech micro muted">{moduleHeadline(item.name, item.args)}</span>
            <ClipTag clipped={item.clipped} />
            <span className={`tool-activity__status tech micro${item.ok === false ? ' semantic-red' : ' tool-activity__status--done'}`}>
              {item.ok === undefined ? '…' : item.ok ? 'ok' : 'failed'}
            </span>
          </summary>
          <CallBody args={item.args} result={item.detail} />
        </details>
      );
    case 'turn':
      return (
        <div className={`pi pi-turn turn-${item.edge} tech micro`}>
          <span>
            {item.edge === 'start' ? 'turn' : 'end'} {item.turnId} / gen {item.generation}
            {item.edge === 'end' && item.startTs !== undefined ? ` / ${formatMs(item.ts - item.startTs)}` : ''}
          </span>
        </div>
      );
    case 'speech':
      return (
        <div className={`pi pi-speech${item.delivered ? '' : ' undelivered'}`}>
          <div className="pi-meta tech micro">
            <span className={item.delivered ? 'pi-tag' : 'semantic-red'}>{item.delivered ? 'spoken' : 'not spoken'}</span>
            {item.reason && <span>{item.reason}</span>}
          </div>
          <div className="pi-text">“{item.text}”</div>
        </div>
      );
    case 'routed':
      return (
        <button type="button" className={`pi pi-routed${lit ? ' lit' : ''}`} data-anchor={`routed-${item.seq}`} onClick={() => select.trace(item.utteranceId)}>
          <div className="pi-meta tech micro">
            <span className="pi-tag">
              routed / {item.via} / {item.mode}
            </span>
            <span>{item.utteranceId}</span>
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
          <div className="pi-meta tech micro">
            <span className="pi-tag semantic-cyan">floor request</span>
          </div>
          <div className="pi-text">{item.message}</div>
        </button>
      );
    case 'rescue':
      return (
        <div className="pi pi-rescue tech micro">
          rescue / gen {item.generation} / {item.reason}
        </div>
      );
    case 'utility':
      return (
        <div
          className={`pi pi-utility${item.done ? '' : ' streaming'}${item.utteranceId ? ' clickable' : ''}`}
          onClick={item.utteranceId ? () => select.trace(item.utteranceId!) : undefined}
        >
          <div className="pi-meta tech micro">
            <span className="pi-tag">{item.purpose === 'rewrite' ? 'floor rewrite' : item.attempt}</span>
            {item.utteranceId && <span>{item.utteranceId}</span>}
            <span className={item.done ? '' : 'semantic-orange'}>{item.done ? formatMs(item.latencyMs) : 'thinking…'}</span>
          </div>
          {item.purpose === 'rewrite' ? (
            <>
              <div className="pi-text">
                <s className="muted">{item.prompt}</s>
                <br />→ {typeof item.decision === 'string' ? item.decision : preview(item.decision)}
              </div>
              {item.input && (
                <details className="pi-prompt">
                  <summary className="tech micro muted">prompt</summary>
                  <pre className="rich-text__code-block">{item.input}</pre>
                </details>
              )}
            </>
          ) : (
            <>
              {item.prompt && (
                <details className="pi-prompt">
                  <summary className="muted">{preview(item.prompt, 60)}</summary>
                  <pre className="rich-text__code-block">{item.prompt}</pre>
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
  state,
  select,
  lit,
}: {
  pane: Pane;
  state?: string;
  select: PaneSelect;
  lit: ReadonlySet<string>;
}) {
  const [limit, setLimit] = useState(PAGE);
  const items = pane.items.length > limit ? pane.items.slice(pane.items.length - limit) : pane.items;

  const { ref: body, onScroll } = usePinnedScroll<HTMLDivElement>(pane.items);

  return (
    <section className="card pane" data-anchor={`pane-${pane.agent}`}>
      {/* Where route lines meet the pane: in above it, floor requests out below. */}
      <span className="pane-port pane-port-in" data-anchor={`port-in-${pane.agent}`} />
      <header className="card-head pane-head">
        <span className="card-title tech pane-name">{pane.agent}</span>
        {state && <span className={`pane-state tech micro state-${state}`}>{state}</span>}
        {pane.openTurn && <span className="pane-state tech micro state-busy">turn {pane.openTurn}</span>}
        <span className="card-index tech micro">{pane.tools} tools</span>
      </header>
      <div
        className="card-body pane-body"
        ref={body}
        data-clip={`pane-${pane.agent}`}
        onScroll={onScroll}
      >
        {pane.items.length > items.length && (
          <button type="button" className="earlier tech micro" onClick={() => setLimit(limit + PAGE)}>
            show {Math.min(PAGE, pane.items.length - items.length)} earlier
          </button>
        )}
        {items.length === 0 && <div className="empty tech micro">no activity yet</div>}
        {items.map((item) => (
          <Item
            key={item.seq}
            item={item}
            select={select}
            lit={(item.type === 'routed' && lit.has(item.utteranceId)) || (item.type === 'floor' && lit.has(item.floorId))}
          />
        ))}
      </div>
      <span className="pane-port pane-port-out" data-anchor={`port-out-${pane.agent}`} />
    </section>
  );
});
