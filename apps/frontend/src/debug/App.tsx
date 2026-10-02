import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaneSelect } from './AgentPane';
import { DetailDrawer } from './Drawer';
import { AgentsPanel } from './panels/AgentsPanel';
import { FloorPanel } from './panels/FloorPanel';
import { LogPanel } from './panels/LogPanel';
import { TimelinePanel } from './panels/TimelinePanel';
import { SwitchboardView, type Selection } from './SwitchboardView';
import { feedOptions, useDebugFeed } from './useFeed';

const TABS = [
  { id: 'board', label: 'Switchboard' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'floor', label: 'Floor gate' },
  { id: 'agents', label: 'Agents & hosts' },
  { id: 'log', label: 'Raw log' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const STATUS_TEXT = { connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', fixture: 'fixture' } as const;

export function DebugApp() {
  const options = useMemo(() => feedOptions(window.location.search), []);
  const { state, status, statusDetail, resync } = useDebugFeed(options);
  const initialTab = (new URLSearchParams(window.location.search).get('tab') as Tab | null) ?? 'board';
  const [tab, setTab] = useState<Tab>(TABS.some((entry) => entry.id === initialTab) ? initialTab : 'board');
  const [selection, setSelection] = useState<Selection>(null);
  const select: PaneSelect = useMemo(
    () => ({
      trace: (id: string) => setSelection((current) => (current?.type === 'trace' && current.id === id ? null : { type: 'trace', id })),
      floor: (id: string) => setSelection((current) => (current?.type === 'floor' && current.id === id ? null : { type: 'floor', id })),
    }),
    [],
  );
  const close = useCallback(() => setSelection(null), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Fixture screenshots can open a trace from the URL: ?select=u-103.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('select');
    if (!wanted || selection) return;
    if (state.traces[wanted]) setSelection({ type: 'trace', id: wanted });
    else if (state.floors[wanted]) setSelection({ type: 'floor', id: wanted });
  }, [state.traces, state.floors, selection]);

  const call = state.calls[state.calls.length - 1];
  const config = state.config;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◢◤</span> SWITCHBOARD <span className="brand-sub">// debug</span>
        </div>
        <div className={`status status-${status}`} title={statusDetail}>
          <span className="status-dot" />
          {STATUS_TEXT[status]}
        </div>
        {call && (
          <div className="meta">
            call <b>{call.callId}</b> {call.endTs ? `ended${call.reason ? ` · ${call.reason}` : ''}` : 'live'}
          </div>
        )}
        <div className="meta">
          seq <b>{state.maxSeq}</b> · {state.events.length} ev · {state.logs.length} log
        </div>
        {config && (
          <div className="meta thresholds-top" title="Jev thresholds">
            fca <b>{config.jev_for_current_agent_lower}</b>–<b>{config.jev_for_current_agent_upper}</b> · act <b>{config.jev_action_threshold}</b>
          </div>
        )}
        {(state.missing.length > 0 || state.gaps > 0) && (
          <button type="button" className="meta warn" onClick={resync} title="resync from a fresh snapshot">
            gaps {state.gaps}
            {state.missing.length ? ` · ${state.missing.length} missing` : ''}
          </button>
        )}
        {state.resyncs > 0 && <div className="meta">resyncs {state.resyncs}</div>}
        {state.rejected > 0 && (
          <div className="meta err" title={state.lastRejection}>
            rejected {state.rejected}
          </div>
        )}
        <nav className="tabs">
          {TABS.map((entry) => (
            <button key={entry.id} type="button" className={tab === entry.id ? 'on' : ''} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="main">
        {tab === 'board' && <SwitchboardView state={state} selection={selection} select={select} />}
        {tab === 'timeline' && <TimelinePanel state={state} select={select} />}
        {tab === 'floor' && <FloorPanel state={state} select={select} />}
        {tab === 'agents' && <AgentsPanel state={state} />}
        {tab === 'log' && <LogPanel state={state} />}
        <DetailDrawer selection={selection} state={state} onClose={close} />
      </main>
    </div>
  );
}
