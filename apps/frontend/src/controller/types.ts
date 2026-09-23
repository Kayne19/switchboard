export type Semantic = 'red' | 'orange' | 'green' | 'cyan' | 'amber' | 'paper' | 'muted';

export interface RichSegment {
  text: string;
  accent?: boolean;
  bold?: boolean;
  semantic?: Semantic;
}

export interface ChartSeries {
  name: string;
  semantic?: Semantic;
  values: number[];
}

export interface ChartData {
  title?: string;
  subtitle?: string;
  context?: string;
  xLabel?: string;
  yLabel?: string;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  series: ChartSeries[];
  marker?: { x: number; series?: string };
  compareLabel?: string;
}

export interface MetricData {
  label: string;
  value: string;
  semantic?: Semantic;
}

export interface ProgressData {
  label: string;
  detail?: string;
  value: number;
  text?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  sub?: string;
  detail?: string;
  semantic?: Semantic;
  state?: 'done' | 'active' | 'todo' | 'blocked';
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  semantic?: Semantic;
  active?: boolean;
}

export interface DiagramData {
  title?: string;
  subtitle?: string;
  context?: string;
  mode: 'graph';
  /** @deprecated Deferred / rejected in v1 action contract */
  source?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DocumentData {
  kind?: 'email' | 'document';
  context?: string;
  source?: string;
  from?: string;
  timestamp?: string;
  subject: string;
  paragraphs: string[];
}

export interface CodeSourceData {
  language?: string;
  text: string;
  highlight?: number[];
}

export interface CodeData {
  title?: string;
  file?: string;
  context?: string;
  source: CodeSourceData;
}

export interface MessageData {
  context?: string;
  tag?: string;
  segments: RichSegment[];
  channel?: { name: string; mode: string };
  transcript?: Array<{ speaker: string; text: string }>;
}

export interface NoteData {
  tag?: string;
  segments: RichSegment[];
}

export type AgentObjectType =
  | 'chart'
  | 'metric'
  | 'progress'
  | 'diagram'
  | 'document'
  | 'code'
  | 'note';

export type SceneObjectType = AgentObjectType | 'message';

export type SceneObjectRole = 'primary' | 'compare' | 'secondary' | 'ambient';

export interface SceneObject<T = unknown> {
  id: string;
  type: SceneObjectType;
  role?: SceneObjectRole;
  data: T;
  createdAt: number;
  updatedAt: number;
}

export interface SpeechState {
  text: string;
  target?: string | null;
  at?: { x?: number; series?: string } | null;
}

export const RUNTIME_ID_PREFIX = '__runtime/';
export const RUNTIME_CONVERSATION_ID = '__runtime/conversation';
export const RUNTIME_LIVE_VISUAL_ID = '__runtime/live-visual';
export const RUNTIME_LIVE_PROGRESS_ID = '__runtime/live-progress';
export const RUNTIME_SPEECH_ID = '__runtime/speech';

export const RESERVED_RUNTIME_IDS = [
  RUNTIME_CONVERSATION_ID,
  RUNTIME_LIVE_VISUAL_ID,
  RUNTIME_LIVE_PROGRESS_ID,
  RUNTIME_SPEECH_ID,
] as const;

export interface WorkspaceState {
  requestedView: string | null;
  effectiveView: string;
  callerPinned: boolean;
  stale: boolean;
}

export interface ScreenStateReport {
  view: string;
  pinned: boolean;
  has_visual: boolean;
  visual_kind: AgentObjectType | null;
  object_ids: string[];
  title: string;
  stale: boolean;
  generation: number;
  applied_seq?: number;
  rejected?: { seq: number; reason: string };
}

export interface ControllerState {
  agentObjects: Record<string, SceneObject>;
  agentOrder: string[];
  agentSpeech: SpeechState | null;

  runtimeObjects: Record<string, SceneObject>;
  runtimeOrder: string[];
  runtimeSpeech: SpeechState | null;

  objects: Record<string, SceneObject>;
  order: string[];
  speech: SpeechState | null;

  workspace: WorkspaceState;
  listening: boolean;
  focusId: string | null;
  revision: number;
}

export type DisplayAction =
  | { op: 'show'; id: string; type: 'chart'; role?: SceneObjectRole; data: ChartData }
  | { op: 'show'; id: string; type: 'metric'; role?: SceneObjectRole; data: MetricData }
  | { op: 'show'; id: string; type: 'progress'; role?: SceneObjectRole; data: ProgressData }
  | { op: 'show'; id: string; type: 'diagram'; role?: SceneObjectRole; data: DiagramData }
  | { op: 'show'; id: string; type: 'document'; role?: SceneObjectRole; data: DocumentData }
  | { op: 'show'; id: string; type: 'code'; role?: SceneObjectRole; data: CodeData }
  | { op: 'show'; id: string; type: 'note'; role?: SceneObjectRole; data: NoteData }
  | { op: 'hide'; id: string }
  | { op: 'say'; text: string; target?: string | null; at?: SpeechState['at'] }
  | { op: 'focus'; id: string }
  | { op: 'clear' };

export type RuntimeAction =
  | { op: 'runtime_show'; id: string; type: SceneObjectType; role?: SceneObjectRole; data: unknown }
  | { op: 'runtime_hide'; id: string }
  | { op: 'runtime_say'; text: string; target?: string | null; at?: SpeechState['at'] }
  | { op: 'runtime_reset' }
  | { op: 'epoch_reset' }
  | { op: 'set_view'; view: string | null }
  | { op: 'pin_view'; view: string }
  | { op: 'unpin_view' }
  | { op: 'auto_view' }
  | { op: 'set_stale'; stale: boolean }
  | { op: 'listen'; on: boolean };

export type ControllerAction =
  | DisplayAction
  | RuntimeAction
  | { op: 'show'; id: string; type: SceneObjectType; role?: SceneObjectRole; data: unknown }
  | { op: 'focus'; id?: string | null }
  | { op: 'listen'; on: boolean };

export interface DisplayEnvelope {
  token: string;
  action: DisplayAction;
}

export type FixtureName = 'idle' | 'conversation' | 'training' | 'architecture' | 'email' | 'code';
