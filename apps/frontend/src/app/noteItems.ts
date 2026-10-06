import type { DiagramObjectData, NoteData, SceneObject, SceneObjectType } from '../controller/types';
import type { NoteTarget } from '../primitives/AnnotationCard';
import { markedPart } from '../primitives/NoteMarker';
import { weatherItemName } from '../primitives/weatherLayout';
import { eventTarget } from '../primitives/calendarLayout';
import { chartTargetText } from '../primitives/chartGeometry';
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

/** The item of a list the drawn note names (`markedPart`). */
export function markedItem(note: NoteData | null | undefined, objectId: string): string | undefined {
  return markedPart(note, objectId).item;
}

/** An item in its object's words, and whether the object marks it: it draws every item it holds but a calendar's events past its view. */
interface ItemTarget {
  text: string;
  marked: boolean;
}

// An item a list draws wherever it holds it: marked with the badge.
const drawn = (text: string | undefined): ItemTarget | undefined => (text === undefined ? undefined : { text, marked: true });

// How each type with items names one of them on a card's TARGET line, or
// undefined when it holds no item of that name (the card then names the
// object, and carries no badge). One entry per type, kept apart.
const ITEM_NAMES: Partial<Record<SceneObjectType, (object: SceneObject, item: string) => ItemTarget | undefined>> = {
  // An event the view does not reach is named, but nothing on screen marks it.
  calendar: (object, item) => {
    const event = eventTarget(cast.calendar(object).data, item);
    return event ? { text: event.text, marked: event.inView } : undefined;
  },

  tasks: (object, item) => drawn(cast.tasks(object).data.items.find((task) => task.id === item)?.text),

  timer: (object, item) => drawn(cast.timer(object).data.timers.find((timer) => timer.id === item)?.label),

  // A small slot that draws neither list draws the item on its spot line.
  weather: (object, item) => drawn(weatherItemName(cast.weather(object).data, item)),

  inbox: (object, item) => {
    const message = cast.inbox(object).data.messages.find((candidate) => candidate.id === item);
    return drawn(message ? [message.from, message.subject].filter(Boolean).join(' / ') : undefined);
  },
};

/** The item `item` of `object` in the object's own words, and whether the
 * object marks it; undefined when the object is not a type with items or
 * holds no item of that name. */
function itemTarget(object: SceneObject, item: string): ItemTarget | undefined {
  return ITEM_NAMES[object.type]?.(object, item);
}

/** The item `item` of `object` in the object's own words, for a card's
 * TARGET line; undefined when the object is not a type with items or holds
 * no item of that name. */
export function itemTargetText(object: SceneObject, item: string): string | undefined {
  return itemTarget(object, item)?.text;
}

/** A diagram's node or a sequence's actor by its label; undefined when it holds none of that id. */
function nodeLabel(data: DiagramObjectData, id: string): string | undefined {
  return data.mode === 'sequence' ? data.actors.find((actor) => actor.id === id)?.label : data.nodes.find((node) => node.id === id)?.label;
}

// The fields an object is named by, in the order the scene frame and the
// agent's view take them (`summary` in apps/backend/src/display.rs): a
// title, a document's subject, a metric's or a progress's label, an
// image's alt text, a forecast's place.
const NAME_FIELDS = ['title', 'subject', 'label', 'alt', 'location'] as const;

/** What the page shows of an object that carries none of NAME_FIELDS, in their stead: code's file (its frame's subtitle), a note's tag, a sequence's kind. */
function shownName(object: SceneObject): string | undefined {
  switch (object.type) {
    case 'code':
      return cast.code(object).data.file;
    case 'note':
      return cast.note(object).data.tag;
    case 'diagram':
      return cast.diagram(object).data.mode === 'sequence' ? 'SEQUENCE' : undefined;
    default:
      return undefined;
  }
}

const said = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * An object in its own words, where a card's TARGET line names the object
 * itself: the first of its title, subject, label, alt text or place it
 * carries that is not blank; where it carries none, what the page shows of
 * it instead (code's file, a note's tag, `SEQUENCE`); else its type's name
 * (`TABLE`, `CHART`). Never its id: an id is the agent's handle, and a
 * caller does not read it.
 */
export function objectName(object: SceneObject): string {
  const data = object.data as Partial<Record<(typeof NAME_FIELDS)[number], unknown>> | null;
  for (const field of NAME_FIELDS) {
    const value = said(data?.[field]);
    if (value) return value;
  }
  return said(shownName(object)) ?? object.type.toUpperCase();
}

/**
 * What a drawn note's card names on its TARGET line, in the words of the
 * object its anchor names (`objects` are the objects on stage, by id), and
 * whether that object marks it with the NOTE badge:
 * - the part the anchor names, where the object holds it: on a chart the
 *   point (`chartTargetText`: its category or x, then its series; the chart
 *   outlines a bar and prints its value, and rings a point no leader on it
 *   reaches; no badge); on a diagram the
 *   node's or actor's label; in a list the item (`itemTargetText`: an
 *   event's title and start, a task's text, a message's sender and
 *   subject, a timer's label, a forecast's day or hour). A node, an actor
 *   and an item are marked with the badge, but for a calendar's event the
 *   view does not reach, which nothing on screen marks;
 * - otherwise the object itself (`objectName`), with no badge.
 * Nothing for a note about no object on stage, or with no anchor: an id
 * names nothing a caller can see, so no card ever shows one. Every card
 * reads this: the rail's, the band's, those on a chart, those focus keeps,
 * and a note drawn as an object of its own (`standingNoteTarget`).
 */
export function noteTarget(objects: Readonly<Record<string, SceneObject | undefined>>, note: NoteData | null | undefined): NoteTarget {
  const anchor = note?.anchor;
  const object = anchor ? objects[anchor.target] : undefined;
  if (!anchor || !object) return { marked: false };
  const named = (text: string | undefined, marked: boolean): NoteTarget | undefined => (text === undefined ? undefined : { target: text, marked });
  const item = anchor.item === undefined ? undefined : itemTarget(object, anchor.item);
  const part =
    object.type === 'chart'
      ? named(chartTargetText(anchor, cast.chart(object).data), false)
      : object.type === 'diagram'
        ? named(anchor.node === undefined ? undefined : nodeLabel(cast.diagram(object).data, anchor.node), true)
        : named(item?.text, item?.marked ?? false);
  return part ?? { target: objectName(object), marked: false };
}

/**
 * The card of a note drawn as an object of its own (in a composed slot, or
 * focused): its TARGET line reads as any card's (`noteTarget`), but it is
 * not the note drawn for what it names, which therefore marks nothing, so
 * it carries no badge.
 */
export function standingNoteTarget(objects: Readonly<Record<string, SceneObject | undefined>>, note: NoteData): NoteTarget {
  return { target: noteTarget(objects, note).target, marked: false };
}
