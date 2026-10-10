import { memo, useMemo, useState } from 'react';
import { usePinnedScroll } from '../../hooks/usePinnedScroll';
import { clockTime } from '../explain';
import type { DebugLog } from '../protocol';
import type { DebugState } from '../reducer';

const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const;
const SHOWN = 600;

export interface LogFilter {
  levels: ReadonlySet<string>;
  target: string;
  text: string;
}

/** The log lines the filter admits, oldest first. */
export function filterLogs(logs: readonly DebugLog[], filter: LogFilter): DebugLog[] {
  const target = filter.target.trim().toLowerCase();
  const text = filter.text.trim().toLowerCase();
  return logs.filter((log) => {
    if (!filter.levels.has(log.level.toUpperCase())) return false;
    if (target && !log.target.toLowerCase().includes(target)) return false;
    if (text) {
      const haystack = `${log.message} ${JSON.stringify(log.fields)}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

const LogRow = memo(function LogRow({ log }: { log: DebugLog }) {
  const fields = Object.entries(log.fields);
  return (
    <div className={`log-row lv-${log.level.toLowerCase()}`}>
      <time>{clockTime(log.timestamp_ms)}</time>
      <span className="lv">{log.level}</span>
      <span className="target">{log.target}</span>
      <span className="msg">{log.message}</span>
      {log.clipped && (
        <span className="tag-clip" title="The service cut this line to the debug record bounds">
          clipped
        </span>
      )}
      {fields.map(([key, value]) => (
        <span key={key} className="field">
          {key}=<b>{typeof value === 'string' ? value : JSON.stringify(value)}</b>
        </span>
      ))}
    </div>
  );
});

export function LogPanel({ state }: { state: DebugState }) {
  const [levels, setLevels] = useState<Set<string>>(new Set(['ERROR', 'WARN', 'INFO', 'DEBUG']));
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<readonly DebugLog[]>(state.logs);
  const source = paused ? frozen : state.logs;
  const shown = useMemo(() => filterLogs(source, { levels, target, text }), [source, levels, target, text]);
  const tail = shown.length > SHOWN ? shown.slice(shown.length - SHOWN) : shown;
  const targets = useMemo(() => [...new Set(state.logs.map((log) => log.target))].sort(), [state.logs]);

  // Pinned to the newest line until scrolled up or paused; a paused log
  // stays where it is.
  const { ref: body, onScroll } = usePinnedScroll<HTMLDivElement>(tail, !paused);

  return (
    <div className="panel panel-log">
      <div className="panel-bar">
        <h2 className="tech">Raw log</h2>
        <div className="seg">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`tech micro${levels.has(level) ? ' on' : ''} lv-${level.toLowerCase()}`}
              aria-pressed={levels.has(level)}
              onClick={() => {
                const next = new Set(levels);
                if (next.has(level)) next.delete(level);
                else next.add(level);
                setLevels(next);
              }}
            >
              {level}
            </button>
          ))}
        </div>
        <input className="field-input" list="log-targets" placeholder="target" value={target} onChange={(event) => setTarget(event.target.value)} />
        <datalist id="log-targets">
          {targets.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <input className="field-input" placeholder="search text" value={text} onChange={(event) => setText(event.target.value)} />
        <button
          type="button"
          className={`tech micro${paused ? ' on' : ''}`}
          aria-pressed={paused}
          onClick={() => {
            if (!paused) setFrozen(state.logs);
            setPaused(!paused);
          }}
        >
          {paused ? 'resume' : 'pause'}
        </button>
        <span className="tech micro muted">
          {shown.length} / {state.logs.length} lines{state.unknown.length ? ` / ${state.unknown.length} unknown events` : ''}
        </span>
      </div>
      <div className="log-body" ref={body} onScroll={onScroll}>
        {tail.map((log) => (
          <LogRow key={log.seq} log={log} />
        ))}
        {state.unknown.length > 0 && (
          <details className="raw">
            <summary className="tech micro">{state.unknown.length} events of unknown kinds (newer backend)</summary>
            {state.unknown.slice(-50).map((event) => (
              <div key={event.seq} className="log-row">
                <time>{clockTime(event.timestamp_ms)}</time>
                <span className="lv">EVENT</span>
                <span className="target">{event.kind}</span>
                <span className="msg">{JSON.stringify(event.raw)}</span>
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
