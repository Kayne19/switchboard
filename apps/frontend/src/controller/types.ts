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
  caption?: string;
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
  caption?: string;
}

export interface ProgressData {
  label: string;
  detail?: string;
  value: number;
  text?: string;
  caption?: string;
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
  caption?: string;
  mode: 'graph';
  /** @deprecated Deferred / rejected in v1 action contract */
  source?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DocumentData {
  kind?: 'email' | 'document';
  context?: string;
  caption?: string;
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
  caption?: string;
  source: CodeSourceData;
}

export interface MessageData {
  context?: string;
  tag?: string;
  caption?: string;
  segments: RichSegment[];
  channel?: { name: string; mode: string };
  transcript?: Array<{ speaker: string; text: string }>;
}

export interface NoteData {
  tag?: string;
  segments: RichSegment[];
  caption?: string;
  anchor?: {
    target: string;
    x?: number;
    series?: string;
    node?: string;
  };
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
  primaryClaimedAt?: number;
}

export interface SpeechState {
  text: string;
  target?: string | null;
  at?: { x?: number; series?: string } | null;
}

export const RUNTIME_ID_PREFIX = '__runtime/';
export const RUNTIME_CONVERSATION_ID = '__runtime/conversation';

/**
 * A tool the agent on the line is running, from the backend's `activity`
 * events. It is status, kept apart from speech: it never replaces what
 * Damocles last said.
 */
export interface ActivityState {
  label: string;
  tool: string;
  detail: string;
  /**
   * Which call this is, stamped by the reducer: every tool start gets a new
   * one, so a second call of the same tool reads as a second call rather
   * than as the first one still running.
   */
  call?: number;
  /**
   * The burst this call belongs to, counted by tool in the order each tool
   * first came, stamped by the reducer (#50). A call that starts while
   * another is still running, or just after the last one ended, joins the
   * burst before it, so twenty parallel reads read as twenty. A lone call's
   * burst is itself.
   */
  burst?: ToolCount[];
}

export interface ToolCount {
  tool: string;
  count: number;
}

/**
 * The tool calls under way, by tool, and the burst they make: what the
 * reducer measures the next start against. The backend's events carry no
 * call id, so calls are told apart by tool: an end retires one call of its
 * tool.
 */
export interface ToolRunState {
  running: Record<string, number>;
  burst: ToolCount[];
  /** When the burst's last call ended, on the runtime's clock; null while any runs. */
  endedAt: number | null;
}

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
  activity: ActivityState | null;
  toolRun: ToolRunState;
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
  /**
   * A tool call started (`activity`), or everything the agent was running
   * has settled (`null`). `at` is the runtime's clock, in milliseconds.
   */
  | { op: 'runtime_activity'; activity: ActivityState | null; at?: number }
  /** One call of `tool` ended. */
  | { op: 'runtime_activity_end'; tool: string; at?: number }
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

export type FixtureName = 'idle' | 'conversation' | 'training' | 'architecture' | 'email' | 'code';
