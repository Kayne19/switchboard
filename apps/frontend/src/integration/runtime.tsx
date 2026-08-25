import { useCallback, useEffect, useRef, useState } from 'react';
import { useController } from '../controller/context';
import type {
  CodeData,
  ControllerAction,
  DiagramData,
  MessageData,
  ProgressData,
  Semantic,
} from '../controller/types';

const LEGACY_SOURCE = 'switchboard-legacy-runtime';
const V17_SOURCE = 'switchboard-v17';

interface SelectOption {
  value: string;
  label: string;
}

interface RuntimeState {
  connected: boolean;
  recording: boolean;
  status: string;
  handsFree: boolean;
  handsFreeStatus: string;
  handsFreeLease: string;
  route: string;
  routes: SelectOption[];
  model: string;
  models: SelectOption[];
  thinking: string;
  thinkingLevels: SelectOption[];
  onProject: boolean;
  modelDisabled: boolean;
  thinkingDisabled: boolean;
}

interface TranscriptLine {
  speaker: string;
  text: string;
  id?: string;
}

type ServerMessage = Record<string, unknown> & { type?: string };

const initialRuntime: RuntimeState = {
  connected: false,
  recording: false,
  status: 'Connecting…',
  handsFree: false,
  handsFreeStatus: 'Standby',
  handsFreeLease: '',
  route: 'operator',
  routes: [{ value: 'operator', label: 'Operator' }],
  model: '',
  models: [],
  thinking: '',
  thinkingLevels: [],
  onProject: false,
  modelDisabled: true,
  thinkingDisabled: true,
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function semanticForState(value: unknown): Semantic {
  if (value === 'done') return 'green';
  if (value === 'active') return 'cyan';
  if (value === 'blocked') return 'amber';
  return 'muted';
}

function normalizeHistory(raw: unknown): TranscriptLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const body = text(item.text);
    if (!body) return [];
    return [{
      speaker: item.role === 'caller' ? 'CALLER' : 'DAMOCLES',
      text: body,
      id: text(item.id) || undefined,
    }];
  });
}

function linearDiagram(message: ServerMessage): DiagramData {
  const items = Array.isArray(message.items)
    ? message.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
  const nodes = items.map((item, index) => ({
    id: `step-${index + 1}`,
    label: text(item.label) || `STEP ${index + 1}`,
    sub: text(item.detail),
    detail: typeof item.ms === 'number' ? `${item.ms}ms` : undefined,
    semantic: semanticForState(item.state),
  }));
  return {
    title: text(message.title) || (message.kind === 'timeline' ? 'CALL PATH / TIMELINE' : 'PLAN / LIVE'),
    subtitle: message.kind === 'timeline' ? 'SEQUENCE / LIVE' : 'EXECUTION / LIVE',
    context: text(message.notes) || 'LIVE WORK',
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index].id,
      to: node.id,
      semantic: node.semantic,
      active: node.semantic === 'cyan',
    })),
  };
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return Boolean(value && typeof value === 'object');
}

export function RuntimeIntegration() {
  const { dispatch } = useController();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const currentResponseRef = useRef('');
  const visualActionRef = useRef<ControllerAction | null>(null);
  const visualActiveRef = useRef(false);
  const [runtime, setRuntime] = useState<RuntimeState>(initialRuntime);

  const command = useCallback((name: string, value?: string) => {
    frameRef.current?.contentWindow?.postMessage(
      { source: V17_SOURCE, command: name, value },
      window.location.origin,
    );
  }, []);

  const showConversation = useCallback((response?: string) => {
    if (response !== undefined) currentResponseRef.current = response;
    const message: MessageData = {
      context: runtime.route === 'operator' ? 'OPERATOR LINE' : `PROJECT / ${runtime.route.toUpperCase()}`,
      tag: 'CURRENT RESPONSE / LIVE',
      segments: [{ text: currentResponseRef.current || 'Line open. Speak when ready.' }],
      channel: { name: 'VOICE', mode: runtime.handsFree ? 'HANDS-FREE' : 'PUSH-TO-TALK' },
      transcript: transcriptRef.current,
    };
    visualActiveRef.current = false;
    dispatch({ op: 'hide', id: 'live-visual' });
    dispatch({ op: 'hide', id: 'live-progress' });
    dispatch({ op: 'show', id: 'conversation', type: 'message', role: 'primary', data: message });
  }, [dispatch, runtime.handsFree, runtime.route]);

  useEffect(() => {
    const appendTranscript = (line: TranscriptLine) => {
      const existing = line.id
        ? transcriptRef.current.findIndex((entry) => entry.id === line.id)
        : -1;
      if (existing >= 0) {
        transcriptRef.current = transcriptRef.current.map((entry, index) => index === existing ? line : entry);
      } else {
        transcriptRef.current = [...transcriptRef.current, line].slice(-200);
      }
    };

    const handleServer = (message: ServerMessage) => {
      switch (message.type) {
        case 'epoch':
          transcriptRef.current = [];
          currentResponseRef.current = '';
          visualActionRef.current = null;
          visualActiveRef.current = false;
          dispatch({ op: 'clear' });
          break;
        case 'history': {
          transcriptRef.current = normalizeHistory(message.entries);
          const latest = [...transcriptRef.current].reverse().find((entry) => entry.speaker === 'DAMOCLES');
          currentResponseRef.current = latest?.text ?? '';
          if (transcriptRef.current.length > 0) showConversation();
          break;
        }
        case 'transcript': {
          const body = text(message.text);
          if (!body) break;
          appendTranscript({ speaker: 'CALLER', text: body, id: text(message.id) || undefined });
          if (!visualActiveRef.current) showConversation();
          break;
        }
        case 'spoken': {
          const entry = message.entry;
          if (!entry || typeof entry !== 'object') break;
          const item = entry as Record<string, unknown>;
          const body = text(item.text);
          if (!body) break;
          appendTranscript({ speaker: 'DAMOCLES', text: body, id: text(item.id) || undefined });
          currentResponseRef.current = body;
          if (visualActiveRef.current) dispatch({ op: 'say', target: 'live-visual', text: body });
          else showConversation(body);
          break;
        }
        case 'reply': {
          const body = text(message.text) || '(No spoken response.)';
          appendTranscript({ speaker: 'DAMOCLES', text: body });
          currentResponseRef.current = body;
          if (visualActiveRef.current) dispatch({ op: 'say', target: 'live-visual', text: body });
          else showConversation(body);
          break;
        }
        case 'thinking':
          dispatch({ op: 'listen', on: false });
          break;
        case 'activity': {
          const detail = [text(message.label), text(message.detail)].filter(Boolean).join(' / ');
          if (detail) dispatch({ op: 'say', text: detail });
          break;
        }
        case 'diagram': {
          const kind = text(message.kind) || 'mermaid';
          if (kind === 'diff') {
            const data: CodeData = {
              title: text(message.title) || 'CHANGESET / LIVE',
              file: 'UNIFIED DIFF',
              context: text(message.notes) || 'LIVE WORK',
              source: { language: 'diff', text: text(message.source) },
            };
            const action: ControllerAction = { op: 'show', id: 'live-visual', type: 'code', role: 'primary', data };
            visualActionRef.current = action;
            visualActiveRef.current = true;
            dispatch({ op: 'hide', id: 'conversation' });
            dispatch(action);
          } else {
            const data: DiagramData = kind === 'plan' || kind === 'timeline'
              ? linearDiagram(message)
              : {
                  title: text(message.title) || 'SYSTEM / DIAGRAM',
                  subtitle: 'MERMAID / LIVE',
                  context: text(message.notes) || 'LIVE WORK',
                  source: text(message.source),
                  nodes: [],
                  edges: [],
                };
            const action: ControllerAction = { op: 'show', id: 'live-visual', type: 'diagram', role: 'primary', data };
            visualActionRef.current = action;
            visualActiveRef.current = true;
            dispatch({ op: 'hide', id: 'conversation' });
            dispatch(action);
            if ((kind === 'plan' || kind === 'timeline') && Array.isArray(message.items)) {
              const active = message.items.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).state === 'active');
              const activeIndex = active ? message.items.indexOf(active) : message.items.length;
              const progress: ProgressData = {
                label: kind === 'timeline' ? 'ACTIVE HOP' : 'PLAN PROGRESS',
                detail: active && typeof active === 'object' ? text((active as Record<string, unknown>).label) : 'COMPLETE',
                value: message.items.length ? Math.min(1, Math.max(0, activeIndex / message.items.length)) : 0,
                text: `${activeIndex}/${message.items.length}`,
              };
              dispatch({ op: 'show', id: 'live-progress', type: 'progress', role: 'secondary', data: progress });
            }
          }
          if (text(message.notes)) dispatch({ op: 'say', target: 'live-visual', text: text(message.notes) });
          break;
        }
        case 'view': {
          const target = text(message.target);
          if (target === 'comms') {
            showConversation();
          } else if ((target === 'visual' || target === 'theater') && visualActionRef.current) {
            visualActiveRef.current = true;
            dispatch({ op: 'hide', id: 'conversation' });
            dispatch(visualActionRef.current);
            dispatch({ op: 'focus', id: target === 'theater' ? 'live-visual' : null });
          } else {
            dispatch({ op: 'focus', id: null });
          }
          break;
        }
        case 'error': {
          const body = text(message.message) || 'The line reported an error.';
          if (currentResponseRef.current) dispatch({ op: 'say', text: body });
          else showConversation(body);
          break;
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const packet = event.data as { source?: string; kind?: string; payload?: unknown };
      if (packet?.source !== LEGACY_SOURCE) return;
      if (packet.kind === 'state' && isRuntimeState(packet.payload)) {
        const state = packet.payload;
        setRuntime((current) => ({ ...current, ...state }));
        dispatch({ op: 'listen', on: Boolean(state.recording || state.handsFree) });
      } else if (packet.kind === 'server' && packet.payload && typeof packet.payload === 'object') {
        handleServer(packet.payload as ServerMessage);
      } else if (packet.kind === 'ready') {
        command('state');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [command, dispatch, showConversation]);

  return (
    <>
      <iframe
        ref={frameRef}
        className="runtime-frame"
        src={import.meta.env.DEV ? 'about:blank' : '/legacy/index.html?runtime=1'}
        title="Switchboard voice runtime"
        allow="microphone; autoplay"
        aria-hidden="true"
        tabIndex={-1}
      />
      <aside className="runtime-controls" aria-label="Call controls">
        <div className="runtime-controls__state tech micro">
          <span className={runtime.connected ? 'runtime-online' : 'runtime-offline'}>
            {runtime.connected ? 'LINK / ONLINE' : 'LINK / RECOVERING'}
          </span>
          <span>{runtime.status}</span>
        </div>
        <div className="runtime-controls__voice">
          {runtime.recording ? (
            <>
              <button type="button" onClick={() => command('cancel')}>DISCARD</button>
              <button className="runtime-primary" type="button" onClick={() => command('send')}>TRANSMIT</button>
            </>
          ) : (
            runtime.connected
              ? <button className="runtime-primary" type="button" onClick={() => command('talk')}>SPEAK</button>
              : <button className="runtime-primary" type="button" onClick={() => command('retry')}>RETRY LINK</button>
          )}
          <button type="button" aria-pressed={runtime.handsFree} disabled={!runtime.connected} onClick={() => command('hands-free')}>
            {runtime.handsFree ? 'HANDS-FREE / ON' : 'HANDS-FREE / OFF'}
          </button>
        </div>
        <details className="runtime-controls__line">
          <summary className="tech micro">LINE / {runtime.route.toUpperCase()}</summary>
          <label>
            <span>ROUTE</span>
            <select value={runtime.route} onChange={(event) => command('route', event.target.value)}>
              {runtime.routes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>MODEL</span>
            <select value={runtime.model} disabled={runtime.modelDisabled} onChange={(event) => command('model', event.target.value)}>
              {runtime.models.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>THINKING</span>
            <select value={runtime.thinking} disabled={runtime.thinkingDisabled} onChange={(event) => command('thinking', event.target.value)}>
              {runtime.thinkingLevels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {runtime.onProject ? <button type="button" onClick={() => command('hangup')}>RETURN TO OPERATOR</button> : null}
        </details>
        {runtime.handsFree ? <div className="runtime-controls__handsfree tech micro">{runtime.handsFreeLease || runtime.handsFreeStatus}</div> : null}
      </aside>
    </>
  );
}
