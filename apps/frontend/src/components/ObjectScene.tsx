// The scene a visual primary other than a chart fills: a diagram,
// document, code, table, image, calendar, to-do list, inbox, timer or
// forecast in the main slot, and the frame's words for it.
import type {
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { besideVisuals, cast, objectsOfType } from '../app/sceneModel';
import { calendarFrame } from '../primitives/CalendarPrimitive';
import { countText } from '../primitives/countText';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame, type FrameVariant } from '../primitives/TechFrame';
import { renderObject } from './renderObject';
import { annotationForScene, liveChatMessage, noteForTarget, ObjectSurface, sceneCaption, type SceneContent, type SceneProps } from './sceneContent';

// A diagram, document, code, table, image, calendar, to-do list, inbox,
// timer or forecast fills the main slot, its note in the rail -- unless the
// diagram places the note as its own callout -- and every other visual in
// the aux row under it.
export function objectContent({ state, composition, onFocus }: SceneProps, onCalloutChange: (placed: boolean) => void): SceneContent | null {
  const primary = composition.primary;
  const frame = primary ? sceneFrame(primary) : null;
  if (!primary || !frame) return null;
  const noteObjects = objectsOfType<NoteData>(state, 'note');
  const noteObject = noteForTarget(noteObjects, primary.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  // The other notes on stage follow it in the rail: the page shows them all.
  const moreNotes = noteObjects.filter((object) => object.id !== noteObject?.id);
  const { outline, ...words } = frame;
  return {
    ...words,
    // What the shell places around the main slot: the aux row under it
    // (every visual beside the primary) and the rail beside it.
    aux: besideVisuals(composition),
    metrics: objectsOfType<MetricData>(state, 'metric'),
    note,
    noteObject,
    moreNotes,
    progressList: objectsOfType<ProgressData>(state, 'progress'),
    main: (
      <ObjectMotion objectId={primary.id} className={`content-main ${primary.type}-object`}>
        {outline ? <TechFrame variant={outline} /> : null}
        <ObjectSurface object={primary}>
          <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
            {renderObject(primary, 'primary', { onStage: state.agentObjects, notes: [...(note ? [note] : []), ...moreNotes.map((object) => object.data)], onCalloutChange })}
          </FocusableSurface>
        </ObjectSurface>
      </ObjectMotion>
    ),
  };
}

/** What the scene's frame says about a primary that fills the main slot, and the frame drawn round the slot where its primitive draws none of its own. */
type SceneFrame = Pick<SceneContent, 'title' | 'subtitle' | 'context' | 'caption'> & { outline?: FrameVariant };

// The frame's words for each type that fills the main slot: the agent's
// own where it sent them, else what the object is. The object itself is
// drawn by `renderObject`, as everywhere else.
function sceneFrame(primary: SceneObject): SceneFrame | null {
  switch (primary.type) {
    case 'diagram': {
      const { data } = cast.diagram(primary);
      const sequence = data.mode === 'sequence';
      return {
        title: data.title ?? (sequence ? 'SYSTEM / SEQUENCE' : 'SYSTEM / DIAGRAM'),
        subtitle: data.subtitle ?? (sequence ? 'SEQUENCE / COMPOSED' : 'GRAPH / COMPOSED'),
        context: data.context ?? (sequence ? 'SEQUENCE' : 'SYSTEM MAP'),
        caption: sceneCaption(primary, sequence ? 'TRACE / MESSAGE ORDER' : 'TRACE / ACTIVE ROUTE'),
        outline: 'rails',
      };
    }
    case 'document': {
      const { data } = cast.document(primary);
      return {
        title: `DOCUMENT / ${data.kind?.toUpperCase() ?? 'CONTENT'}`,
        subtitle: 'CONTENT / ORIGINAL',
        context: data.context ?? 'DOCUMENT',
        caption: sceneCaption(primary, 'CHROME / SWITCHBOARD'),
      };
    }
    case 'code': {
      const { data } = cast.code(primary);
      return {
        title: data.title ?? 'SOURCE / LIVE',
        subtitle: data.file ?? 'SOURCE',
        context: data.context ?? 'SOURCE',
        caption: sceneCaption(primary, 'DISPLAY / SOURCE'),
      };
    }
    case 'table': {
      const { data } = cast.table(primary);
      return {
        title: data.title ?? 'DATA / TABLE',
        subtitle: data.subtitle ?? 'ROWS / COLUMNS',
        context: data.context ?? 'TABLE',
        caption: sceneCaption(primary, 'DISPLAY / TABLE'),
      };
    }
    case 'image': {
      // The figure's own words head the scene; its alt text stands in for
      // a title it was not given.
      const { data } = cast.image(primary);
      return {
        title: data.title ?? data.alt,
        subtitle: data.subtitle ?? `IMAGE / ${data.format.toUpperCase()}`,
        context: data.context ?? 'FIGURE',
        caption: sceneCaption(primary, `FIGURE / ${data.format.toUpperCase()}`),
        outline: 'panel',
      };
    }
    case 'calendar': {
      const { data } = cast.calendar(primary);
      return {
        ...calendarFrame(data),
        caption: sceneCaption(primary, `CALENDAR / ${data.view.toUpperCase()}`),
        outline: 'panel',
      };
    }
    case 'tasks': {
      // A to-do list heads the scene with its own words, else its kind: the
      // list's meta line and its sections' heads say what it holds.
      const { data } = cast.tasks(primary);
      return {
        title: data.title ?? 'TASKS / TO DO',
        subtitle: data.subtitle ?? 'CHECKLIST',
        context: data.context ?? 'TASKS',
        caption: sceneCaption(primary, 'TASKS / TO DO'),
        outline: 'panel',
      };
    }
    case 'inbox': {
      const { data } = cast.inbox(primary);
      return {
        title: data.title ?? 'INBOX / MESSAGES',
        subtitle: data.subtitle ?? 'MESSAGES / AS SENT',
        context: data.context ?? 'INBOX',
        caption: sceneCaption(primary, 'INBOX / AS SENT'),
        outline: 'panel',
      };
    }
    case 'timer': {
      const { data } = cast.timer(primary);
      const paused = data.timers.filter((timer) => timer.state === 'paused').length;
      return {
        title: data.title ?? (data.timers.length === 1 ? data.timers[0].label : 'TIMERS'),
        subtitle: data.subtitle ?? [countText(data.timers.length, ['TIMER', 'TIMERS']), paused > 0 ? `${paused} PAUSED` : null].filter(Boolean).join(' / '),
        context: data.context ?? 'TIMERS',
        caption: sceneCaption(primary, 'TIMERS / PAGE CLOCK'),
        outline: 'panel',
      };
    }
    case 'weather': {
      const { data } = cast.weather(primary);
      return {
        title: data.title ?? `WEATHER / ${data.location}`,
        subtitle: data.subtitle ?? ['NOW', data.hourly?.length ? `${data.hourly.length} H` : null, data.daily?.length ? `${data.daily.length} DAYS` : null].filter(Boolean).join(' + '),
        context: data.context ?? 'FORECAST',
        caption: sceneCaption(primary, `FORECAST / DEGREES ${data.units}`),
        outline: 'panel',
      };
    }
    default:
      return null;
  }
}
