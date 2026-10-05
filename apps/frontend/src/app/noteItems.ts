import type { CalendarData, ControllerState, InboxData, SceneObject, TasksData, TimerData, WeatherData } from '../controller/types';
import { cast } from './sceneModel';

// A note on one item (docs/display-tool.md, "A note on one item"): a note's
// `anchor.item` names an event, a task, a timer, a message, or a forecast
// hour or day inside the object it targets. Wherever that object is drawn
// (the main slot, an aux cell, focus) the item carries the NOTE badge, the
// twin of the one on the rail card, and the card's TARGET line names the
// item in the object's own words. Neither validator looks the item up, so
// a name the object does not hold marks nothing.

/** The item a note on stage names inside the object `objectId`: the first
 * note in show order whose anchor targets it and names an item. */
export function anchoredItem(state: ControllerState, objectId: string): string | undefined {
  for (const id of state.agentOrder) {
    const object = state.agentObjects[id];
    if (object?.type !== 'note') continue;
    const anchor = cast.note(object).data.anchor;
    if (anchor?.target === objectId && anchor.item !== undefined) return anchor.item;
  }
  return undefined;
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
  calendar: (data, item) => data.events.find((event) => event.id === item)?.title,

  tasks: (data, item) => data.items.find((task) => task.id === item)?.text,

  timer: (data, item) => data.timers.find((timer) => timer.id === item)?.label,

  weather: (data, item) => (data.hourly ?? []).find((hour) => hour.time === item)?.time ?? (data.daily ?? []).find((day) => day.date === item)?.date,

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
