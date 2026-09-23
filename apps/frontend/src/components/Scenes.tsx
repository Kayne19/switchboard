import { AnimatePresence, motion } from 'motion/react';
import type {
  ChartData,
  CodeData,
  ControllerState,
  DiagramData,
  DocumentData,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { buildCompositionModel, cast, objectsOfType, primaryObject } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DamoclesPresence } from '../primitives/DamoclesPresence';
import { DiagramPrimitive } from '../primitives/DiagramPrimitive';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { RichText } from '../primitives/RichText';
import { SceneFooter } from '../primitives/SceneFooter';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame } from '../primitives/TechFrame';

interface SceneProps {
  state: ControllerState;
  onToggleListening: () => void;
  onFocus: (id: string | null) => void;
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
}

function CornerMarks() {
  return (
    <>
      <svg className="corner-mark corner-mark--top" viewBox="0 0 420 120" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 0 118 V 18 H 248 L 286 0 H 420" />
      </svg>
      <svg className="corner-mark corner-mark--bottom" viewBox="0 0 360 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 360 0 V 78 H 118 L 82 100 H 0" />
      </svg>
    </>
  );
}

function noteFromSpeech(state: ControllerState, fallback?: SceneObject<NoteData>): NoteData | null {
  if (state.speech) {
    return { tag: 'DAMOCLES / EXPLANATION', segments: [{ text: state.speech.text }] };
  }
  return fallback?.data ?? null;
}

export function IdleScene({ state, onToggleListening }: Pick<SceneProps, 'state' | 'onToggleListening'>) {
  return (
    <motion.section className="scene scene--idle" data-scene="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <DamoclesPresence
        listening={state.listening}
        onToggleListening={onToggleListening}
        size="idle"
        showCaption={false}
      />
    </motion.section>
  );
}

export function ConversationScene({ state, onToggleListening, transcriptOpen, setTranscriptOpen }: SceneProps) {
  const comp = buildCompositionModel(state);
  const object =
    comp.runtimeConversation ??
    (comp.primary?.type === 'message' ? comp.primary : null) ??
    (state.objects['message'] as SceneObject<MessageData> | undefined) ??
    null;
  const fallbackMessage: MessageData = {
    context: 'OPERATOR LINE',
    tag: 'CURRENT RESPONSE / LIVE',
    segments: [{ text: 'Line open. Speak when ready.' }],
    channel: { name: 'VOICE', mode: 'PUSH-TO-TALK' },
    transcript: [],
  };
  const message = object ? cast.message(object).data : fallbackMessage;
  // Status/activity speech is rendered as an annotation elsewhere; it must not
  // replace the conversation's latest committed response.
  const segments = message.segments;

  return (
    <motion.section className="scene scene--conversation" data-scene="conversation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <CornerMarks />
      <div className="conversation-presence-band">
        <DamoclesPresence
          listening={state.listening}
          onToggleListening={onToggleListening}
          context={message.context ?? 'CONVERSATION'}
          size="conversation"
          showCaption={false}
        />
      </div>

      <ObjectMotion objectId={object?.id ?? "conversation"} className="conversation-answer">
        <TechFrame variant="panel" />
        <div className="conversation-answer__tag tech micro">{message.tag ?? 'CURRENT RESPONSE / 01'}</div>
        <div className="conversation-answer__text"><RichText segments={segments} /></div>
        <div className="conversation-answer__index tech micro">VOICE / 01</div>
      </ObjectMotion>

      <div className="conversation-channel tech micro">
        CHANNEL / {message.channel?.name ?? 'VOICE'}<br />MODE / {message.channel?.mode ?? 'HANDS-FREE'}
      </div>
      <button className="transcript-toggle tech micro" type="button" onClick={() => setTranscriptOpen(true)}>
        TRANSCRIPT HIDDEN
      </button>

      <AnimatePresence>
        {transcriptOpen ? (
          <motion.div className="transcript" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.24 }}>
            <div className="transcript__header tech micro">
              <span>CONVERSATION / HISTORY</span>
              <button type="button" onClick={() => setTranscriptOpen(false)}>RETURN / ESC</button>
            </div>
            <div className="transcript__body">
              {(message.transcript ?? []).map((line, index) => (
                <div className={`transcript-line${line.speaker === 'DAMOCLES' ? ' transcript-line--ai' : ''}`} key={`${index}-${line.speaker}`}>
                  <span className="transcript-line__speaker tech micro">{line.speaker}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
            <input className="transcript__input" placeholder="TYPE OR SPEAK" aria-label="Conversation input" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

export function TrainingScene({ state, onToggleListening, onFocus }: SceneProps) {
  const charts = objectsOfType<ChartData>(state, 'chart');
  const metrics = objectsOfType<MetricData>(state, 'metric');
  const progress = objectsOfType<ProgressData>(state, 'progress')[0];
  const noteObject = objectsOfType<NoteData>(state, 'note')[0];
  const note = noteFromSpeech(state, noteObject);
  const primary = charts.find((chart) => chart.role === 'primary') ?? charts[0];
  if (!primary) return <IdleScene state={state} onToggleListening={onToggleListening} />;

  return (
    <motion.section className="scene scene--content scene--training" data-scene="training" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <CornerMarks />
      <div className="scene-heading">
        <div className="scene-heading__title tech">{primary.data.title ?? 'TRAINING / RUN'}</div>
        <div className="scene-heading__sub tech micro">{primary.data.subtitle ?? 'LOSS TRACE / LIVE'}</div>
      </div>

      <div className="content-grid">
        <motion.div className="content-main training-main" layout>
          <div className={`training-charts${charts.length > 1 ? ' training-charts--compare' : ''}`}>
            <AnimatePresence mode="popLayout" initial={false}>
              {charts.map((chart) => (
                <ObjectMotion key={chart.id} objectId={chart.id} className="chart-object">
                  <TechFrame variant="panel" />
                  <FocusableSurface onActivate={() => onFocus(chart.id)} ariaLabel={`Expand ${chart.data.title ?? 'chart'}`}>
                    <ChartPrimitive data={chart.data} />
                  </FocusableSurface>
                  {chart.role === 'compare' ? <div className="compare-label tech micro">COMPARE / {chart.data.compareLabel ?? 'RUN'}</div> : null}
                </ObjectMotion>
              ))}
            </AnimatePresence>
          </div>
          {note ? (
            <motion.div className="training-note" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <AnnotationCard data={note} onFocus={noteObject ? () => onFocus(noteObject.id) : undefined} />
            </motion.div>
          ) : null}
          {progress ? (
            <ObjectMotion objectId={progress.id} className="training-progress">
              <FocusableSurface onActivate={() => onFocus(progress.id)} ariaLabel="Expand progress">
                <ProgressPrimitive data={progress.data} />
              </FocusableSurface>
            </ObjectMotion>
          ) : null}
        </motion.div>

        <motion.aside className="content-rail" layout>
          <DamoclesPresence
            listening={state.listening}
            onToggleListening={onToggleListening}
            context={primary.data.context ?? 'TRAINING RUN'}
            size="rail"
          />
          <MetricsPrimitive metrics={metrics} />
        </motion.aside>
      </div>
      <SceneFooter left="DISPLAY / COMPOSED" right="PRIMARY / LOSS TRACE" />
    </motion.section>
  );
}

export function ArchitectureScene({ state, onToggleListening, onFocus }: SceneProps) {
  const primaryObjectValue = primaryObject(state);
  if (!primaryObjectValue) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  const diagram = cast.diagram(primaryObjectValue);
  const noteObject = objectsOfType<NoteData>(state, 'note')[0];
  const note = noteFromSpeech(state, noteObject);

  return (
    <motion.section className="scene scene--content scene--architecture" data-scene="architecture" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <CornerMarks />
      <div className="scene-heading">
        <div className="scene-heading__title tech">{diagram.data.title ?? 'SYSTEM / DIAGRAM'}</div>
        <div className="scene-heading__sub tech micro">{diagram.data.subtitle ?? 'GRAPH / COMPOSED'}</div>
      </div>
      <div className="content-grid">
        <ObjectMotion objectId={diagram.id} className="content-main diagram-object">
          <TechFrame variant="open" />
          <FocusableSurface onActivate={() => onFocus(diagram.id)} ariaLabel="Expand diagram">
            <DiagramPrimitive data={diagram.data} />
          </FocusableSurface>
        </ObjectMotion>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence listening={state.listening} onToggleListening={onToggleListening} context={diagram.data.context ?? 'SYSTEM MAP'} size="rail" />
          {note ? <ObjectMotion objectId={noteObject?.id ?? 'speech-note'} className="rail-note"><AnnotationCard data={note} onFocus={noteObject ? () => onFocus(noteObject.id) : undefined} /></ObjectMotion> : null}
        </motion.aside>
      </div>
      <SceneFooter left="DISPLAY / SYSTEM MAP" right="TRACE / ACTIVE ROUTE" />
    </motion.section>
  );
}

export function DocumentScene({ state, onToggleListening, onFocus }: SceneProps) {
  const primaryObjectValue = primaryObject(state);
  if (!primaryObjectValue) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  const document = cast.document(primaryObjectValue);
  const noteObject = objectsOfType<NoteData>(state, 'note')[0];
  const note = noteFromSpeech(state, noteObject);

  return (
    <motion.section className="scene scene--content scene--document" data-scene="document" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <CornerMarks />
      <div className="scene-heading">
        <div className="scene-heading__title tech">DOCUMENT / {document.data.kind?.toUpperCase() ?? 'CONTENT'}</div>
        <div className="scene-heading__sub tech micro">CONTENT / ORIGINAL</div>
      </div>
      <div className="content-grid">
        <ObjectMotion objectId={document.id} className="content-main document-object">
          <FocusableSurface onActivate={() => onFocus(document.id)} ariaLabel="Expand document">
            <DocumentViewport data={document.data} />
          </FocusableSurface>
        </ObjectMotion>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence listening={state.listening} onToggleListening={onToggleListening} context={document.data.context ?? 'DOCUMENT'} size="rail" />
          {note ? <ObjectMotion objectId={noteObject?.id ?? 'speech-note'} className="rail-note"><AnnotationCard data={note} onFocus={noteObject ? () => onFocus(noteObject.id) : undefined} /></ObjectMotion> : null}
        </motion.aside>
      </div>
      <SceneFooter left="CONTENT / ORIGINAL EMAIL" right="CHROME / SWITCHBOARD" />
    </motion.section>
  );
}

export function CodeScene({ state, onToggleListening, onFocus }: SceneProps) {
  const primaryObjectValue = primaryObject(state);
  if (!primaryObjectValue) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  const code = cast.code(primaryObjectValue);
  const noteObject = objectsOfType<NoteData>(state, 'note')[0];
  const note = noteFromSpeech(state, noteObject);

  return (
    <motion.section className="scene scene--content scene--code" data-scene="code" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <CornerMarks />
      <div className="scene-heading">
        <div className="scene-heading__title tech">{code.data.title ?? 'SOURCE / LIVE'}</div>
        <div className="scene-heading__sub tech micro">{code.data.file ?? 'SOURCE'}</div>
      </div>
      <div className="content-grid">
        <ObjectMotion objectId={code.id} className="content-main code-object">
          <FocusableSurface onActivate={() => onFocus(code.id)} ariaLabel="Expand code">
            <CodeViewport data={code.data} />
          </FocusableSurface>
        </ObjectMotion>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence listening={state.listening} onToggleListening={onToggleListening} context={code.data.context ?? 'SOURCE'} size="rail" />
          {note ? <ObjectMotion objectId={noteObject?.id ?? 'speech-note'} className="rail-note"><AnnotationCard data={note} onFocus={noteObject ? () => onFocus(noteObject.id) : undefined} /></ObjectMotion> : null}
        </motion.aside>
      </div>
      <SceneFooter left="FRAME / INTERRUPTED RAILS" right="DISPLAY / SOURCE" />
    </motion.section>
  );
}

export function ComposedScene({ state, onToggleListening, onFocus }: SceneProps) {
  const comp = buildCompositionModel(state);
  const primary = comp.primary;
  if (!primary) return <IdleScene state={state} onToggleListening={onToggleListening} />;

  const noteObject = comp.allAgentObjects.find((o) => o.type === 'note') as SceneObject<NoteData> | undefined;
  const note = noteFromSpeech(state, noteObject);
  const metrics = comp.allAgentObjects.filter((o) => o.type === 'metric') as Array<SceneObject<MetricData>>;
  const progressList = comp.allAgentObjects.filter((o) => o.type === 'progress') as Array<SceneObject<ProgressData>>;

  const renderPrimaryPrimitive = () => {
    switch (primary.type) {
      case 'chart':
        return <ChartPrimitive data={(primary as SceneObject<ChartData>).data} />;
      case 'diagram':
        return <DiagramPrimitive data={(primary as SceneObject<DiagramData>).data} />;
      case 'document':
        return <DocumentViewport data={(primary as SceneObject<DocumentData>).data} />;
      case 'code':
        return <CodeViewport data={(primary as SceneObject<CodeData>).data} />;
      case 'metric':
        return <MetricsPrimitive metrics={[primary as SceneObject<MetricData>]} />;
      case 'progress':
        return <ProgressPrimitive data={(primary as SceneObject<ProgressData>).data} />;
      case 'note':
        return <AnnotationCard data={(primary as SceneObject<NoteData>).data} />;
      default:
        return null;
    }
  };

  const title = (primary.data as any)?.title ?? (primary.data as any)?.subject ?? (primary.data as any)?.label ?? 'COMPOSED WORKSPACE';
  const subtitle = (primary.data as any)?.subtitle ?? 'STRUCTURED SCENE';

  return (
    <motion.section className="scene scene--content scene--composed" data-scene="composed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <CornerMarks />
      <div className="scene-heading">
        <div className="scene-heading__title tech">{title}</div>
        <div className="scene-heading__sub tech micro">{subtitle}</div>
      </div>
      <div className="content-grid">
        <motion.div className="content-main composed-main" layout>
          <ObjectMotion objectId={primary.id} className="composed-primary-object">
            <TechFrame variant="panel" />
            <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
              {renderPrimaryPrimitive()}
            </FocusableSurface>
          </ObjectMotion>
          {comp.compare.map((cmp) => (
            <ObjectMotion key={cmp.id} objectId={cmp.id} className="composed-compare-object">
              <TechFrame variant="panel" />
              <FocusableSurface onActivate={() => onFocus(cmp.id)} ariaLabel={`Expand compare ${cmp.type}`}>
                {cmp.type === 'chart' ? <ChartPrimitive data={(cmp as SceneObject<ChartData>).data} /> : null}
                {cmp.type === 'diagram' ? <DiagramPrimitive data={(cmp as SceneObject<DiagramData>).data} /> : null}
                {cmp.type === 'document' ? <DocumentViewport data={(cmp as SceneObject<DocumentData>).data} /> : null}
                {cmp.type === 'code' ? <CodeViewport data={(cmp as SceneObject<CodeData>).data} /> : null}
                {cmp.type === 'metric' ? <MetricsPrimitive metrics={[cmp as SceneObject<MetricData>]} /> : null}
                {cmp.type === 'progress' ? <ProgressPrimitive data={(cmp as SceneObject<ProgressData>).data} /> : null}
                {cmp.type === 'note' ? <AnnotationCard data={(cmp as SceneObject<NoteData>).data} /> : null}
              </FocusableSurface>
            </ObjectMotion>
          ))}
          {progressList.filter(p => p.id !== primary.id && !comp.compare.some(c => c.id === p.id)).map(p => (
            <ObjectMotion key={p.id} objectId={p.id} className="composed-progress">
              <FocusableSurface onActivate={() => onFocus(p.id)} ariaLabel="Expand progress">
                <ProgressPrimitive data={p.data} />
              </FocusableSurface>
            </ObjectMotion>
          ))}
        </motion.div>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence
            listening={state.listening}
            onToggleListening={onToggleListening}
            context={(primary.data as any)?.context ?? 'COMPOSED'}
            size="rail"
          />
          {metrics.length > 0 && primary.type !== 'metric' ? (
            <MetricsPrimitive metrics={metrics} />
          ) : null}
          {note ? (
            <ObjectMotion objectId={noteObject?.id ?? 'speech-note'} className="rail-note">
              <AnnotationCard data={note} onFocus={noteObject ? () => onFocus(noteObject.id) : undefined} />
            </ObjectMotion>
          ) : null}
        </motion.aside>
      </div>
      <SceneFooter left="DISPLAY / COMPOSED" right="SYSTEM / ACTIVE" />
    </motion.section>
  );
}
