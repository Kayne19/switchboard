import { useCallback, useEffect, useMemo, useState } from 'react';
import { DamoclesGlyph } from '../primitives/DamoclesGlyph';
import { SceneFooter } from '../primitives/SceneFooter';
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
        <DamoclesGlyph className="brand-glyph" title="Damocles" />
        <div className="brand">
          <span className="brand-title tech">Switchboard / debug</span>
          <span className="brand-sub tech micro">
            {call ? `call ${call.callId} / ${call.endTs ? `ended${call.reason ? ` / ${call.reason}` : ''}` : 'live'}` : 'no call yet'}
          </span>
        </div>
        <div className={`status status-${status} tech micro`} title={statusDetail}>
          {STATUS_TEXT[status]}
        </div>
        {(state.missing.length > 0 || state.gaps > 0) && (
          <button type="button" className="meta warn tech micro" onClick={resync} title="resync from a fresh snapshot">
            gaps {state.gaps}
            {state.missing.length ? ` / ${state.missing.length} missing` : ''} / resync
          </button>
        )}
        {state.resyncs > 0 && <div className="meta tech micro">resyncs {state.resyncs}</div>}
        {state.rejected > 0 && (
          <div className="meta semantic-red tech micro" title={state.lastRejection}>
            rejected {state.rejected}
          </div>
        )}
        <nav className="tabs">
          {TABS.map((entry) => (
            <button key={entry.id} type="button" className={`tech micro${tab === entry.id ? ' on' : ''}`} aria-pressed={tab === entry.id} onClick={() => setTab(entry.id)}>
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
      <footer className="footer">
        <SceneFooter
          left={`seq ${state.maxSeq} / ${state.events.length} events / ${state.logs.length} log lines`}
          right={
            config
              ? `jev thresholds / for current agent ${config.jev_for_current_agent_lower}–${config.jev_for_current_agent_upper} / action ${config.jev_action_threshold}`
              : 'jev thresholds / not reported'
          }
        />
      </footer>
    </div>
  );
}
