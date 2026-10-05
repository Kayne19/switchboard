import type { CalendarData, InboxData, NoteData, SceneObject, SceneObjectType, TasksData, TimerData, WeatherData } from '../controller/types';
import { weatherItemName } from '../primitives/weatherLayout';
import { eventTargetText } from '../primitives/calendarLayout';
import { cast } from './sceneModel';

// A note on one item (docs/display-tool.md, "A note on one item"): a note's
// `anchor.item` names an event, a task, a timer, a message, or a forecast
// hour or day inside the object it targets. While that note is the one the
// page draws for the object (the rail's note, or the note focus keeps
// beside it), the item carries the NOTE badge wherever the object is drawn
// (the main slot, an aux cell, focus), the twin of the badge on the card,
// and the card's TARGET line names the item in the object's own words: a
// diagram marks the node its shown note names the same way. A note the
// page does not draw marks nothing, so a badge always has its card on
// screen. Neither validator looks the item up, so a name the object does
// not hold marks nothing either.

/** The types whose objects hold items a note can name. */
export const ITEM_TYPES: ReadonlySet<SceneObjectType> = new Set<SceneObjectType>(['calendar', 'tasks', 'timer', 'weather', 'inbox']);

/** The item the drawn note `note` names inside the object `objectId`, which
 * that object marks; nothing when the note is about another object or names
 * no item. */
export function markedItem(note: NoteData | null | undefined, objectId: string): string | undefined {
  const anchor = note?.anchor;
  return anchor?.target === objectId ? anchor.item : undefined;
}

type ItemName<T> = (data: T, item: string) => string | undefined;

// How each type names one of its items on the rail card's TARGET line, or
// undefined when it holds no item of that name (the card then shows the
// anchor as sent, and no badge). One entry per type, kept apart.
const ITEM_NAMES: {
  calendar: ItemName<CalendarData>;
  tasks: ItemName<TasksData>;
  timer: ItemName<TimerData>;
  weather: ItemName<WeatherData>;
  inbox: ItemName<InboxData>;
} = {
  calendar: (data, item) => eventTargetText(data, item),

  tasks: (data, item) => data.items.find((task) => task.id === item)?.text,

  timer: (data, item) => data.timers.find((timer) => timer.id === item)?.label,

  weather: weatherItemName,

  inbox: (data, item) => {
    const message = data.messages.find((candidate) => candidate.id === item);
    return message ? [message.from, message.subject].filter(Boolean).join(' / ') : undefined;
  },
};

/** The item `item` of `object` in the object's own words, for the rail
 * card's TARGET line; undefined when the object is not a type with items or
 * holds no item of that name. */
export function itemTargetText(object: SceneObject, item: string): string | undefined {
  switch (object.type) {
    case 'calendar':
      return ITEM_NAMES.calendar(cast.calendar(object).data, item);
    case 'tasks':
      return ITEM_NAMES.tasks(cast.tasks(object).data, item);
    case 'timer':
      return ITEM_NAMES.timer(cast.timer(object).data, item);
    case 'weather':
      return ITEM_NAMES.weather(cast.weather(object).data, item);
    case 'inbox':
      return ITEM_NAMES.inbox(cast.inbox(object).data, item);
    default:
      return undefined;
  }
}

/** The item a note's card names on its TARGET line, in its object's words:
 * set only when the note is about `object` and the object holds the item it
 * names, which is when the item is marked and the card carries the badge. */
export function noteItemTarget(object: SceneObject | null | undefined, note: NoteData | null | undefined): string | undefined {
  const item = markedItem(note, object?.id ?? '');
  return object && item !== undefined ? itemTargetText(object, item) : undefined;
}
