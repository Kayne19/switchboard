import { agentColor } from './colors';
import { answerRows, branchText, clockTime, decisionSummary, formatMs, ruleText, type AnswerRow } from './explain';
import { JsonView } from './Json';
import type { DebugConfig, JsonValue } from './protocol';
import { routePath, type DebugState, type FloorTrace, type RouteTrace } from './reducer';
import type { Selection } from './SwitchboardView';

function Section({ title, children, accent }: { title: string; children: React.ReactNode; accent?: string }) {
  return (
    <section className="dr-section" style={accent ? { ['--accent' as string]: accent } : undefined}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Bars({ row }: { row: AnswerRow }) {
  const single = row.bars.length === 0 && (row.noul !== undefined || row.confidence !== undefined);
  const bars = single ? [{ label: row.noul !== undefined ? 'noul' : 'confidence', value: (row.noul ?? row.confidence)!, selected: true }] : row.bars;
  return (
    <div className="answer">
      <div className="answer-head">
        <span className="answer-q">{row.question}</span>
        {row.selected !== undefined && <span className="answer-sel">→ {row.selected}</span>}
        {row.confidence !== undefined && !single && <span className="muted">conf {row.confidence.toFixed(2)}</span>}
      </div>
      {bars.map((bar) => (
        <div key={bar.label} className={`bar-row${bar.selected ? ' sel' : ''}`}>
          <span className="bar-label">{bar.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max(0, Math.min(1, bar.value)) * 100}%` }} />
            {row.markers.map((marker) => (
              <span key={marker.label} className="bar-mark" style={{ left: `${marker.value * 100}%` }} title={`${marker.label} ${marker.value}`} />
            ))}
          </span>
          <span className="bar-value">{bar.value.toFixed(2)}</span>
        </div>
      ))}
      {row.verdict && <div className="verdict">{row.verdict}</div>}
    </div>
  );
}

function Latency({ label, ms }: { label: string; ms: number | undefined }) {
  return (
    <div className="lat">
      <span>{label}</span>
      <b>{formatMs(ms)}</b>
    </div>
  );
}

function TraceDetail({ trace, state }: { trace: RouteTrace; state: DebugState }) {
  const path = routePath(trace);
  const config: DebugConfig | null = state.config;
  const firstRouted = trace.routed[0];
  const firstReply = firstRouted
    ? state.panes[firstRouted.to_agent]?.items.find(
        (item) => item.seq > firstRouted.seq && (item.type === 'text' || item.type === 'speech' || item.type === 'module'),
      )
    : undefined;
  return (
    <>
      <header className="dr-head">
        <div className="dr-kicker">utterance {trace.id}</div>
        <div className="dr-title">“{trace.text ?? '…'}”</div>
        <div className="muted">
          {clockTime(trace.firstTs)} · caller was talking to <b>{trace.talkingTo ?? '?'}</b>
        </div>
        <div className="ci-path">
          <span className="chip">caller</span>
          {path.stages.map((stage) => (
            <span key={stage} className={`chip chip-${stage}`}>
              {stage}
            </span>
          ))}
          {path.destinations.map((destination, index) => (
            <span key={index} className="chip chip-dest" style={{ color: agentColor(destination.agent, state.paneOrder) }}>
              ⇢ {destination.agent}
            </span>
          ))}
          {path.pending && <span className="chip chip-pending">routing…</span>}
        </div>
      </header>

      <Section title="Latency">
        <div className="lats">
          <Latency label="jev" ms={trace.jevResponse?.latency_ms} />
          {trace.utility.map((attempt, index) => (
            <Latency key={index} label={`utility ${attempt.attempt}`} ms={attempt.decision?.latency_ms} />
          ))}
          <Latency label="to first destination" ms={firstRouted ? firstRouted.timestamp_ms - trace.firstTs : undefined} />
          <Latency label="to first agent output" ms={firstReply ? firstReply.ts - trace.firstTs : undefined} />
        </div>
      </Section>

      <Section title="Jev" accent="var(--jev)">
        {trace.jevResponse ? (
          <>
            <div className={`kv ${trace.jevResponse.outcome === 'ok' ? '' : 'err'}`}>
              outcome <b>{trace.jevResponse.outcome}</b> in {formatMs(trace.jevResponse.latency_ms)}
              {trace.jevResponse.error ? ` — ${trace.jevResponse.error}` : ''}
            </div>
            {answerRows(trace.jevResponse.answers, config).map((row) => (
              <Bars key={row.question} row={row} />
            ))}
          </>
        ) : (
          <div className="muted">{trace.jevRequest ? 'waiting for Jev…' : 'Jev was not asked.'}</div>
        )}
        {config && (
          <div className="thresholds">
            thresholds: for_current_agent lower {config.jev_for_current_agent_lower} · upper {config.jev_for_current_agent_upper} · action{' '}
            {config.jev_action_threshold}
          </div>
        )}
        {trace.jevRequest && (
          <details className="raw">
            <summary>request state</summary>
            <JsonView value={trace.jevRequest.state} openDepth={1} />
          </details>
        )}
      </Section>

      {trace.decision && (
        <Section title="Rule fired" accent="var(--jev)">
          <div className="rule">
            <span className="tag">{trace.decision.rule}</span> decided by {trace.decision.decided_by}: <b>{trace.decision.action}</b>
            {trace.decision.target ? ` → ${trace.decision.target}` : ''} ({trace.decision.mode})
          </div>
          <p>{ruleText(trace.decision.rule)}</p>
          <p className="muted mono">{trace.decision.reason}</p>
        </Section>
      )}

      {trace.records
        .filter((record) => record.kind === 'pbx_branch')
        .map((record) =>
          record.kind === 'pbx_branch' ? (
            <Section key={record.seq} title="PBX branch">
              <div className="rule">
                <span className="tag">{record.branch}</span> {branchText(record.branch)}
              </div>
              <p className="muted">why: {record.reason}</p>
            </Section>
          ) : null,
        )}

      {trace.utility.length > 0 && (
        <Section title="Utility" accent="var(--utility)">
          {trace.utility.map((attempt, index) => (
            <div key={index} className="attempt">
              <div className="attempt-head">
                <span className="tag">{attempt.attempt}</span>
                <b>{decisionSummary(attempt.decision?.decision)}</b>
                <span className="muted">{formatMs(attempt.decision?.latency_ms)}</span>
              </div>
              {attempt.request && (
                <details className="raw">
                  <summary>request</summary>
                  <pre className="pre-wrap">{attempt.request.prompt}</pre>
                </details>
              )}
              {attempt.decision && (
                <details className="raw">
                  <summary>decision</summary>
                  <JsonView value={attempt.decision.decision} openDepth={3} />
                </details>
              )}
            </div>
          ))}
        </Section>
      )}

      {(trace.operatorHop || trace.operatorTool) && (
        <Section title="Operator" accent="var(--operator)">
          {trace.operatorHop && (
            <div className="kv">
              hop outcome <b>{trace.operatorHop.outcome}</b>: “{trace.operatorHop.text}”
            </div>
          )}
          {trace.operatorTool && (
            <div className="kv">
              route tool → <b>{trace.operatorTool.target}</b> · {trace.operatorTool.mode} · {trace.operatorTool.action}
            </div>
          )}
        </Section>
      )}

      <Section title="Destinations">
        {path.destinations.length === 0 && <div className="muted">none yet</div>}
        {path.destinations.map((destination, index) => (
          <div key={index} className="dest" style={{ borderColor: agentColor(destination.agent, state.paneOrder) }}>
            <b>{destination.agent}</b>{' '}
            <span className="muted">
              via {destination.via} · {destination.mode || '—'}
            </span>
            <div>“{destination.textPart}”</div>
          </div>
        ))}
      </Section>

      <Section title="Raw events">
        <details className="raw">
          <summary>{trace.records.length} events</summary>
          <JsonView value={trace.records as unknown as JsonValue} openDepth={1} />
        </details>
      </Section>
    </>
  );
}

function FloorDetail({ floor }: { floor: FloorTrace }) {
  const answers = floor.jev.filter((record) => record.kind === 'jev_response');
  return (
    <>
      <header className="dr-head">
        <div className="dr-kicker">floor message from {floor.agent}</div>
        <div className="dr-title">“{floor.message || '…'}”</div>
        <div className="muted">
          {clockTime(floor.firstTs)} · {floor.released ? `released (${floor.released.how})` : 'waiting'}
        </div>
      </header>
      <Section title="Path back to the caller" accent="var(--floor)">
        <ol className="floor-steps">
          <li className={floor.requested ? 'done' : ''}>request_to_speak {floor.requested ? '✓' : '—'}</li>
          <li className={floor.heldTs !== undefined ? 'done' : ''}>held {floor.heldTs !== undefined ? clockTime(floor.heldTs) : '—'}</li>
          {floor.gates.map((gate) => (
            <li key={gate.seq} className={gate.answer === 'yes' ? 'done' : 'no'}>
              good-moment gate: <b>{gate.answer}</b> in {formatMs(gate.latency_ms)} · {clockTime(gate.timestamp_ms)}
            </li>
          ))}
          {floor.rewrite && (
            <li className="done">
              rewrite in {formatMs(floor.rewrite.latency_ms)}: <s className="muted">{floor.rewrite.original}</s> → “{floor.rewrite.rewritten}”
            </li>
          )}
          <li className={floor.released ? 'done' : ''}>released {floor.released ? `(${floor.released.how})` : '—'}</li>
          {floor.speech && (
            <li className={floor.speech.delivered ? 'done' : 'no'}>
              spoken: {floor.speech.delivered ? 'delivered' : `not delivered${floor.speech.reason ? ` (${floor.speech.reason})` : ''}`}
            </li>
          )}
        </ol>
        <div className="lats">
          <Latency label="waited" ms={(floor.released?.timestamp_ms ?? floor.lastTs) - floor.firstTs} />
        </div>
      </Section>
      {answers.length > 0 && (
        <Section title="Jev good_moment answers" accent="var(--jev)">
          {answers.map((record) =>
            record.kind === 'jev_response' ? (
              <div key={record.seq}>
                {answerRows(record.answers, null).map((row) => (
                  <Bars key={row.question} row={row} />
                ))}
              </div>
            ) : null,
          )}
        </Section>
      )}
      <Section title="Raw events">
        <details className="raw">
          <summary>{floor.records.length} events</summary>
          <JsonView value={floor.records as unknown as JsonValue} openDepth={1} />
        </details>
      </Section>
    </>
  );
}

export function DetailDrawer({ selection, state, onClose }: { selection: Selection; state: DebugState; onClose(): void }) {
  if (!selection) return null;
  const trace = selection.type === 'trace' ? state.traces[selection.id] : undefined;
  const floor = selection.type === 'floor' ? state.floors[selection.id] : undefined;
  return (
    <aside className="drawer" aria-label="route detail">
      <button type="button" className="drawer-close" onClick={onClose} aria-label="close">
        ✕
      </button>
      <div className="drawer-body">
        {trace && <TraceDetail trace={trace} state={state} />}
        {floor && <FloorDetail floor={floor} />}
        {!trace && !floor && <div className="muted">This entry has left the ring.</div>}
      </div>
    </aside>
  );
}
