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
  /** Validated Mermaid source supplied by the Switchboard backend. */
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

export type SceneObjectType =
  | 'chart'
  | 'metric'
  | 'progress'
  | 'diagram'
  | 'document'
  | 'code'
  | 'message'
  | 'note';

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

export interface ControllerState {
  objects: Record<string, SceneObject>;
  order: string[];
  speech: SpeechState | null;
  listening: boolean;
  focusId: string | null;
  revision: number;
}

export type ControllerAction =
  | { op: 'show'; id: string; type: SceneObjectType; role?: SceneObjectRole; data: unknown }
  | { op: 'hide'; id: string }
  | { op: 'say'; text: string; target?: string | null; at?: SpeechState['at'] }
  | { op: 'focus'; id?: string | null }
  | { op: 'listen'; on: boolean }
  | { op: 'clear' };

export type FixtureName = 'idle' | 'conversation' | 'training' | 'architecture' | 'email' | 'code';
