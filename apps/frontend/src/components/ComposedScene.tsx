// The composed workspace: a metric, progress or note primary, or a
// cluster of primary metrics, over an aux row of everything else.
import type {
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { besideVisuals, nameFields } from '../app/sceneModel';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame } from '../primitives/TechFrame';
import { renderObject } from './renderObject';
import { SurfaceBoundary } from './SurfaceBoundary';
import { annotationForScene, liveChatMessage, noteForTarget, ObjectSurface, sceneCaption, type SceneContent, type SceneProps } from './sceneContent';

/** A text field an object's data may carry for the scene frame, or undefined
 * when that shape has none. */
function frameText(data: unknown, field: 'subtitle' | 'context'): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

// Any mix of objects: the primary, or a cluster of primary metrics, over an
// aux row of everything the rail does not carry.
export function composedContent({ state, composition: comp, onFocus }: SceneProps): SceneContent | null {
  const primary = comp.primary;
  if (!primary) return null;

  const primaryMetrics = comp.primaryMetrics;
  const isMetricPrimary = primary.type === 'metric' || primaryMetrics.length > 0;

  const noteObjects = comp.allAgentObjects.filter((object) => object.type === 'note') as Array<SceneObject<NoteData>>;
  const noteObject = noteForTarget(noteObjects, primary.id);
  const noteIsPrimary = noteObject?.id === primary.id;
  const metrics = comp.allAgentObjects.filter((o) => o.type === 'metric') as Array<SceneObject<MetricData>>;
  const progressList = comp.allAgentObjects.filter((o) => o.type === 'progress') as Array<SceneObject<ProgressData>>;
  const primaryMetricIds = new Set(primaryMetrics.map((m) => m.id));
  const note = noteIsPrimary ? null : annotationForScene(state, noteObject, liveChatMessage(state));
  // Everything the rail does not carry shares one visible aux row below the
  // primary -- compare objects, the other visuals beside it, and progress --
  // so an accepted object is never lost to the layout. Metrics and the note
  // stay in the rail; a compare metric or the rail's note is not drawn twice.
  const auxObjects: SceneObject[] = [
    ...comp.compare.filter((o) => o.type !== 'metric' && o.id !== noteObject?.id),
    ...besideVisuals(comp).filter((o) => o.role !== 'compare'),
    ...progressList.filter((p) => p.id !== primary.id && !comp.compare.some((c) => c.id === p.id)),
  ];
  // The other notes, neither the primary nor drawn in the aux row, follow
  // the rail's note: the page shows them all.
  const moreNotes = noteObjects.filter((object) => object.id !== noteObject?.id && object.id !== primary.id && !auxObjects.some((aux) => aux.id === object.id));

  return {
    // Named by the same fields, in the same order, as the agent's view (`nameFields`).
    title: nameFields(primary.data)[0] ?? 'COMPOSED WORKSPACE',
    subtitle: frameText(primary.data, 'subtitle') ?? 'STRUCTURED SCENE',
    context: frameText(primary.data, 'context') ?? 'COMPOSED',
    caption: sceneCaption(primary, 'SYSTEM / ACTIVE'),
    metrics: isMetricPrimary ? metrics.filter((metric) => !primaryMetricIds.has(metric.id)) : metrics,
    note,
    noteObject: noteIsPrimary ? undefined : noteObject,
    moreNotes,
    progressList: [],
    aux: auxObjects,
    mainVariant: isMetricPrimary ? 'composed-main--metric-primary' : undefined,
    main: (
      <ObjectMotion
        // The object's identity, shared with its focus as every object's is
        // (ObjectMotion's switchboard-object-<id>); a cluster is named by its
        // own id, so focusing one of its metrics grows from nothing in it.
        objectId={primaryMetrics.length > 1 ? 'primary-metric-cluster' : primary.id}
        className={`composed-primary-object composed-primary-object--${primary.type}${primaryMetrics.length > 1 ? ' composed-primary-object--cluster' : ''}`}
      >
        <TechFrame variant="panel" />
        {primaryMetrics.length > 1 ? (
          <SurfaceBoundary surfaceId="primary-metric-cluster" resetKey={state.agentObjects}>
            <div className="focusable-content">
              <MetricsPrimitive
                metrics={primaryMetrics}
                slot="primary"
                onFocus={onFocus}
              />
            </div>
          </SurfaceBoundary>
        ) : (
          <ObjectSurface object={primary}>
            <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
              {isMetricPrimary ? (
                <MetricsPrimitive
                  metrics={primaryMetrics.length > 0 ? primaryMetrics : [primary as SceneObject<MetricData>]}
                  slot="primary"
                  onFocus={onFocus}
                />
              ) : (
                // A progress or a note: sceneKind gives every visual primary a scene of its own.
                renderObject(primary, 'primary', { onStage: state.agentObjects, notes: [...(note ? [note] : []), ...moreNotes.map((object) => object.data)] })
              )}
            </FocusableSurface>
          </ObjectSurface>
        )}
      </ObjectMotion>
    ),
  };
}
