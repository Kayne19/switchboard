// The chart scene (`training`): the primary chart and the charts beside
// it in one row, the notes laid over them, and the notes they leave to
// the rail.
import { AnimatePresence } from 'motion/react';
import type {
  ChartData,
  ControllerState,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { noteTarget } from '../app/noteItems';
import { besideVisuals, cast, objectsOfType } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { chartKind } from '../primitives/chartGeometry';
import { NOTES_PLACED_IN_FULL } from '../primitives/notePlacement';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame } from '../primitives/TechFrame';
import { ChartNotes, chartNoteAnchors, type ChartNote } from './ChartNotes';
import { SurfaceBoundary } from './SurfaceBoundary';
import { annotationForScene, liveChatMessage, ObjectSurface, sceneCaption, StageColumn, type SceneContent, type SceneProps } from './sceneContent';

// Which chart panel each note is shown on: the chart it names, a compare
// chart's included, and otherwise the primary. Every note is shown -- a
// second note on the chart is annotated beside the first, not dropped --
// and with no note object on stage, a spoken explanation stands in on the
// primary. A note that names a visual on stage that is not a chart (one in
// the aux row, say) is about that visual, not a chart: it is left for the
// rail, as many as there are.
function chartNotesByPanel(
  state: ControllerState,
  charts: Array<SceneObject<ChartData>>,
  primary: SceneObject<ChartData>,
): { byPanel: Map<string, ChartNote[]>; offCharts: ChartNote[] } {
  const byPanel = new Map<string, ChartNote[]>();
  const add = (chartId: string, note: ChartNote) => byPanel.set(chartId, [...(byPanel.get(chartId) ?? []), note]);
  const offCharts: ChartNote[] = [];
  const noteObjects = objectsOfType<NoteData>(state, 'note');
  for (const object of noteObjects) {
    const targetId = object.data.anchor?.target;
    const named = targetId ? state.agentObjects[targetId] : undefined;
    if (named && named.type !== 'chart' && named.id !== object.id) {
      offCharts.push({ key: object.id, data: object.data, object });
      continue;
    }
    const target = charts.find((chart) => chart.id === targetId) ?? primary;
    add(target.id, { key: object.id, data: object.data, object });
  }
  if (noteObjects.length === 0) {
    const spoken = annotationForScene(state, undefined, liveChatMessage(state));
    if (spoken) add(primary.id, { key: 'speech-note', data: spoken });
  }
  return { byPanel, offCharts };
}

/** The note a chart leaves out for the rail, and the chart that said so. */
export interface ChartRailNote {
  chart: string;
  note: string;
}

// `railNote` is the note a chart has said, through `onRailNote`, it leaves
// out for the rail; the rail shows it while that chart is the primary.
// `band` is the note the shell has moved from the rail to a band under the
// charts, where the rail stands under them (SceneShell).
export function trainingContent(
  { state, composition, onFocus, onOpenHistory }: SceneProps,
  railNote: ChartRailNote | null,
  onRailNote: (chartId: string, key: string, away: boolean) => void,
  band: ChartRailNote | null,
): SceneContent | null {
  const [firstProgress, ...railProgress] = objectsOfType<ProgressData>(state, 'progress');
  // The primary is the composition's, the one the screen state and view()
  // name: an ambient chart shown first is not it (sceneKind made it a chart).
  if (composition.primary?.type !== 'chart') return null;
  const primary = cast.chart(composition.primary);
  // The row is in the composition's order too: the primary leads, then its
  // compare, secondary and ambient charts, so a sparkline shown first does
  // not take the first panel (the top one on a portrait stage).
  const beside = besideVisuals(composition);
  const charts = [primary, ...beside.filter((object) => object.type === 'chart').map(cast.chart)];
  // Every chart is drawn here, the primary's neighbours beside it; any other
  // visual goes in the aux row under them. With visuals there, the progress
  // that sits under the charts joins them in the row, as progress does in
  // the composed workspace, so the charts keep the main slot's share of a
  // short stage instead of giving it to the bar and its steps.
  const besideCharts = beside.filter((object) => object.type !== 'chart');
  const progress = besideCharts.length > 0 ? undefined : firstProgress;
  // The notes lie over the panel of the chart they annotate rather than in a
  // band that shrinks it; the layer keeps them clear of one another, of the
  // points they name, and of the data the chart draws. Only the one note it
  // cannot hold so, where the rail stands under the charts, takes a band.
  const { byPanel: notesByPanel, offCharts } = chartNotesByPanel(state, charts, primary);
  // A chart lays at most `NOTES_PLACED_IN_FULL` notes over itself, the
  // first it was shown, each placed clear of the others and of its data;
  // the rest are read in the rail, where a card has room, rather than over
  // the data or one another (pr/issues.md, "where notes past five go").
  // The chart still marks the points they name.
  const laidOn = (chart: SceneObject<ChartData>) => (notesByPanel.get(chart.id) ?? []).slice(0, NOTES_PLACED_IN_FULL);
  const pastLaid = charts.flatMap((chart) => (notesByPanel.get(chart.id) ?? []).slice(NOTES_PLACED_IN_FULL));
  const primaryNotes = laidOn(primary);
  // A note the primary chart left out, held in a band under the charts:
  // the chart no longer places it, and the rail does not carry it.
  const banded = band?.chart === primary.id ? primaryNotes.find((note) => note.key === band.note) : undefined;
  // The rail's notes: those about a visual off the charts, the note the
  // primary chart leaves out so the rest have clear places, and the notes
  // past those a chart lays over itself, in that order.
  const handedOver = railNote?.chart === primary.id && railNote.note !== banded?.key ? primaryNotes.find((note) => note.key === railNote.note) : undefined;
  const inRail = [...offCharts, ...(handedOver ? [handedOver] : []), ...pastLaid];
  const [railLead, ...railMore] = inRail;
  // Frame text the chart leaves out names what it is -- its kind -- and
  // nothing more: a bar chart of test durations is not a training run.
  const kind = chartKind(primary.data).toUpperCase();
  return {
    title: primary.data.title ?? `CHART / ${kind}`,
    subtitle: primary.data.subtitle ?? 'SERIES / COMPOSED',
    context: primary.data.context ?? 'CHART',
    caption: sceneCaption(primary, `PRIMARY / ${kind} CHART`),
    metrics: objectsOfType<MetricData>(state, 'metric'),
    // The notes sit on the charts here; the rail carries the one the
    // primary leaves out, those about a visual that is not a chart, and
    // those past what a chart lays over itself.
    note: railLead?.data ?? null,
    noteObject: railLead?.object,
    moreNotes: railMore.flatMap((note) => (note.object ? [note.object] : [])),
    noteLeads: railLead !== undefined,
    progressList: railProgress,
    // A band is carved from one chart's slot. A compare pair on a portrait
    // stage already scrolls in its row, and a band would push the second
    // chart out of view: its note stays in the rail, leading it.
    chartNotes: charts.length === 1 ? { chart: primary.id, keys: primaryNotes.map((note) => note.key) } : undefined,
    aux: firstProgress && !progress ? [...besideCharts, firstProgress] : besideCharts,
    main: (
      <StageColumn className="content-main training-main">
        <div className={`training-charts${charts.length > 1 ? ' training-charts--compare' : ''}`}>
          <AnimatePresence mode="popLayout" initial={false}>
            {charts.map((chart) => {
              // Every note about the chart: the chart marks each one's point.
              const notes = notesByPanel.get(chart.id) ?? [];
              const laid = laidOn(chart);
              // Its bar or point stays marked; the card is in the band.
              const onChart = banded ? laid.filter((note) => note.key !== banded.key) : laid;
              // The notes whose leaders run to their points on the chart: not
              // the one in the band, nor the one the chart left for the rail.
              const away = railNote?.chart === chart.id ? railNote.note : undefined;
              const led = onChart.filter((note) => note.key !== away);
              return (
                <ObjectMotion key={chart.id} objectId={chart.id} className="chart-object" data-chart-id={chart.id}>
                  <TechFrame variant="panel" />
                  <ObjectSurface object={chart}>
                    <FocusableSurface onActivate={() => onFocus(chart.id)} ariaLabel={`Expand ${chart.data.title ?? 'chart'}`}>
                      <ChartPrimitive data={chart.data} named={chartNoteAnchors(chart, notes)} led={chartNoteAnchors(chart, led)} />
                    </FocusableSurface>
                  </ObjectSurface>
                  {onChart.length > 0 ? (
                    <ChartNotes
                      chart={chart}
                      objects={state.agentObjects}
                      notes={onChart}
                      named={chartNoteAnchors(chart, notes)}
                      onFocus={onFocus}
                      onOpenHistory={onOpenHistory}
                      onRailNote={chart.id === primary.id ? onRailNote : undefined}
                    />
                  ) : null}
                  {chart.role === 'compare' ? <div className="compare-label tech micro">COMPARE / {chart.data.compareLabel ?? 'RUN'}</div> : null}
                </ObjectMotion>
              );
            })}
          </AnimatePresence>
        </div>
        <AnimatePresence initial={false}>
          {banded ? (
            <ObjectMotion key="chart-note-band" objectId={banded.object?.id ?? banded.key} className="chart-note-band" data-note={banded.key} layout="position">
              <SurfaceBoundary surfaceId={banded.object?.id ?? banded.key} resetKey={banded.object ?? banded.data}>
                <AnnotationCard
                  data={banded.data}
                  onFocus={banded.object ? () => onFocus(banded.object!.id) : undefined}
                  onOpenHistory={banded.object ? undefined : onOpenHistory}
                  named={noteTarget(state.agentObjects, banded.data)}
                />
              </SurfaceBoundary>
            </ObjectMotion>
          ) : null}
        </AnimatePresence>
        {progress ? (
          <ObjectMotion objectId={progress.id} className="training-progress">
            <ObjectSurface object={progress}>
              <FocusableSurface onActivate={() => onFocus(progress.id)} ariaLabel="Expand progress">
                <ProgressPrimitive data={progress.data} />
              </FocusableSurface>
            </ObjectSurface>
          </ObjectMotion>
        ) : null}
      </StageColumn>
    ),
  };
}
