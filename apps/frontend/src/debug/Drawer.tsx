import type { ReactNode } from 'react';
import type { MetricData, SceneObject } from '../controller/types';
import { CodeViewport } from '../primitives/CodeViewport';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { answerRows, branchText, clockTime, decisionSummary, formatMs, ruleText, type AnswerRow } from './explain';
import { JsonView } from './Json';
import type { DebugConfig } from './protocol';
import { routePath, type DebugState, type FloorTrace, type RouteTrace } from './reducer';
import { RoutePathLine, type Selection } from './SwitchboardView';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dr-section">
      <h3 className="tech micro">{title}</h3>
      {children}
    </section>
  );
}

/** Latencies as the main page's metric rows: label left, value right. */
function Latencies({ rows }: { rows: { label: string; ms: number | undefined }[] }) {
  const metrics: SceneObject<MetricData>[] = rows.map((row, index) => ({
    id: `latency-${index}`,
    type: 'metric',
    data: { label: row.label, value: formatMs(row.ms), semantic: row.ms === undefined ? 'muted' : 'paper' },
    createdAt: 0,
    updatedAt: 0,
  }));
  return (
    <div className="lats">
      <MetricsPrimitive metrics={metrics} />
    </div>
  );
}

/** Records as JSON in the main page's code viewport. */
function RawRecords({ records }: { records: unknown[] }) {
  return (
    <details className="raw">
      <summary className="tech micro">{records.length} events</summary>
      <div className="raw-code">
        <CodeViewport data={{ source: { text: JSON.stringify(records, null, 2) } }} />
      </div>
    </details>
  );
}

function Bars({ row }: { row: AnswerRow }) {
  const single = row.bars.length === 0 && (row.noul !== undefined || row.confidence !== undefined);
  const bars = single ? [{ label: row.noul !== undefined ? 'noul' : 'confidence', value: (row.noul ?? row.confidence)!, selected: true }] : row.bars;
  return (
    <div className="answer">
      <div className="answer-head">
        <span className="answer-q tech">{row.question}</span>
        {row.selected !== undefined && <span className="answer-sel tech micro">→ {row.selected}</span>}
        {row.confidence !== undefined && !single && <span className="tech micro muted">conf {row.confidence.toFixed(2)}</span>}
      </div>
      {bars.map((bar) => (
        <div key={bar.label} className={`bar-row${bar.selected ? ' sel' : ''}`}>
          <span className="bar-label tech micro">{bar.label}</span>
          {/* The main page's progress track; the marks are the thresholds. */}
          <span className="bar-track progress-primitive__track">
            <span className="progress-primitive__fill" style={{ width: `${Math.max(0, Math.min(1, bar.value)) * 100}%` }} />
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
        <div className="dr-kicker tech micro">utterance / {trace.id}</div>
        <div className="dr-title">“{trace.text ?? '…'}”</div>
        <div className="dr-sub tech micro">
          {clockTime(trace.firstTs)} / caller was talking to {trace.talkingTo ?? '?'}
        </div>
        <RoutePathLine trace={trace} />
      </header>

      <Section title="Latency">
        <Latencies
          rows={[
            { label: 'jev', ms: trace.jevResponse?.latency_ms },
            ...trace.utility.map((attempt) => ({ label: `utility ${attempt.attempt}`, ms: attempt.decision?.latency_ms })),
            { label: 'to first destination', ms: firstRouted ? firstRouted.timestamp_ms - trace.firstTs : undefined },
            { label: 'to first agent output', ms: firstReply ? firstReply.ts - trace.firstTs : undefined },
          ]}
        />
      </Section>

      <Section title="Jev">
        {trace.jevResponse ? (
          <>
            <div className={`kv${trace.jevResponse.outcome === 'ok' ? '' : ' semantic-red'}`}>
              outcome <b>{trace.jevResponse.outcome}</b> in {formatMs(trace.jevResponse.latency_ms)}
              {trace.jevResponse.error ? ` — ${trace.jevResponse.error}` : ''}
            </div>
            {answerRows(trace.jevResponse.answers, config).map((row) => (
              <Bars key={row.question} row={row} />
            ))}
          </>
        ) : (
          <div className="muted">{trace.jevRequest ? (path.ended ? 'Jev did not answer before the trace ended.' : 'waiting for Jev…') : 'Jev was not asked.'}</div>
        )}
        {config && (
          <div className="thresholds tech micro">
            thresholds / for_current_agent lower {config.jev_for_current_agent_lower} / upper {config.jev_for_current_agent_upper} / action{' '}
            {config.jev_action_threshold}
          </div>
        )}
        {trace.jevRequest && (
          <details className="raw">
            <summary className="tech micro">request state</summary>
            <JsonView value={trace.jevRequest.state} openDepth={1} />
          </details>
        )}
      </Section>

      {trace.decision && (
        <Section title="Rule fired">
          <div className="rule">
            <span className="tag tech micro">{trace.decision.rule}</span> decided by {trace.decision.decided_by}: <b>{trace.decision.action}</b>
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
                <span className="tag tech micro">{record.branch}</span> {branchText(record.branch)}
              </div>
              <p className="muted">why: {record.reason}</p>
            </Section>
          ) : null,
        )}

      {trace.utility.length > 0 && (
        <Section title="Utility">
          {trace.utility.map((attempt, index) => (
            <div key={index} className="attempt">
              <div className="attempt-head">
                <span className="tag tech micro">{attempt.attempt}</span>
                <b>{decisionSummary(attempt.decision?.decision)}</b>
                <span className="muted">{formatMs(attempt.decision?.latency_ms)}</span>
              </div>
              {attempt.request && (
                <details className="raw">
                  <summary className="tech micro">request</summary>
                  <pre className="rich-text__code-block">{attempt.request.prompt}</pre>
                </details>
              )}
              {attempt.decision && (
                <details className="raw">
                  <summary className="tech micro">decision</summary>
                  <JsonView value={attempt.decision.decision} openDepth={3} />
                </details>
              )}
            </div>
          ))}
        </Section>
      )}

      {(trace.operatorHop || trace.operatorTool) && (
        <Section title="Operator">
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
        {path.refused.map((refusal) => (
          <div key={refusal.seq} className="dest dest-ended">
            <b>✕ refused</b> <span className="muted">{refusal.reason}</span>
          </div>
        ))}
        {path.ended && path.destinations.length === 0 && (
          <div className="dest dest-ended">
            <b>✕ {path.ended.label}</b> <span className="muted">no destination: {path.ended.reason}</span>
          </div>
        )}
        {!path.ended && path.destinations.length === 0 && <div className="muted">none yet</div>}
        {path.destinations.map((destination, index) => (
          <div key={index} className="dest">
            <b>{destination.agent}</b>{' '}
            <span className="muted">
              via {destination.via} · {destination.mode || '—'}
            </span>
            <div>“{destination.textPart}”</div>
          </div>
        ))}
        {path.ended && path.destinations.length > 0 && (
          <div className="dest dest-ended">
            <b>✕ {path.ended.label}</b> <span className="muted">after routing: {path.ended.reason}</span>
          </div>
        )}
      </Section>

      <Section title="Raw events">
        <RawRecords records={trace.records} />
      </Section>
    </>
  );
}

function FloorDetail({ floor }: { floor: FloorTrace }) {
  const answers = floor.jev.filter((record) => record.kind === 'jev_response');
  return (
    <>
      <header className="dr-head">
        <div className="dr-kicker tech micro">floor message / {floor.agent}</div>
        <div className="dr-title">“{floor.message || '…'}”</div>
        <div className="dr-sub tech micro">
          {clockTime(floor.firstTs)} / {floor.released ? `released (${floor.released.how})` : 'waiting'}
        </div>
      </header>
      <Section title="Path back to the caller">
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
        <Latencies rows={[{ label: 'waited', ms: (floor.released?.timestamp_ms ?? floor.lastTs) - floor.firstTs }]} />
      </Section>
      {answers.length > 0 && (
        <Section title="Jev good_moment answers">
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
        <RawRecords records={floor.records} />
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
      <button type="button" className="drawer-close tech micro" onClick={onClose} aria-label="close">
        close
      </button>
      <div className="drawer-body">
        {trace && <TraceDetail trace={trace} state={state} />}
        {floor && <FloorDetail floor={floor} />}
        {!trace && !floor && <div className="muted">This entry has left the ring.</div>}
      </div>
    </aside>
  );
}
