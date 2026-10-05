import type { ReactNode } from 'react';
import { NoteBadge } from './NoteMarker';

/*
 * TEMPORARY (pa-contract): the one stand-in renderer for the five
 * personal-assistant types -- calendar, tasks, timer, weather, inbox -- until
 * the render slice draws each with a primitive of its own. It is a plain
 * framed list of the fields the agent sent, so the page neither crashes on
 * nor drops an accepted object and the fixtures load. The timer has its
 * own primitive (TimerPrimitive).
 *
 * Replaced by the render slice. To retire it for a type, point that type's
 * cases at its own primitive (grep `TemporaryAssistantList` and
 * `temporaryAssistantFrame`: Scenes.tsx `composedPrimitive` and
 * `objectContent`, FocusLayer.tsx `FocusedObject`); when no type uses it,
 * delete this file and the `.temporary-assistant` block in
 * styles/index.css. Keep the `data-testid` (the type's name) on the new
 * primitive: the scene tests count objects by it.
 */

export type TemporaryAssistantType = 'calendar' | 'tasks' | 'weather' | 'inbox';

type Fields = Record<string, unknown>;

/** The list each type is mostly made of, for the frame's count. */
const MAIN_LIST: Record<TemporaryAssistantType, [string, string]> = {
  calendar: ['events', 'EVENTS'],
  tasks: ['items', 'TASKS'],
  weather: ['daily', 'DAYS'],
  inbox: ['messages', 'MESSAGES'],
};

/** The field an item is named by, first found. */
const NAME_KEYS = ['title', 'text', 'label', 'from', 'time', 'date'];
/** Drawn by the scene frame, not in the list. */
const FRAME_KEYS = new Set(['title', 'subtitle', 'context', 'caption']);

function fieldsOf(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};
}

function plain(value: unknown): string {
  if (Array.isArray(value)) return value.map(plain).join(', ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Fields).map(([key, inner]) => `${key} ${plain(inner)}`).join(' / ');
  }
  return String(value);
}

/** What a note's `anchor.item` names an item by: a forecast hour or day by
 * its time or date, anything else by its id. */
function itemKey(type: TemporaryAssistantType, fields: Fields): string | undefined {
  const key = type === 'weather' ? (fields.time ?? fields.date) : fields.id;
  return typeof key === 'string' ? key : undefined;
}

function Item({ fields, itemKey: key, marked }: { fields: Fields; itemKey?: string; marked: boolean }) {
  const nameKey = NAME_KEYS.find((name) => typeof fields[name] === 'string');
  const rest = Object.entries(fields).filter(([name]) => name !== nameKey);
  return (
    <li className="temporary-assistant__item" data-item={key}>
      {marked ? <NoteBadge /> : null}
      {nameKey ? <span className="temporary-assistant__name">{fields[nameKey] as string}</span> : null}
      {rest.map(([key, value]) => (
        <span key={key} className="temporary-assistant__pair">
          <span className="temporary-assistant__key tech micro">{key}</span> {plain(value)}
        </span>
      ))}
    </li>
  );
}

/** The scene frame's text for a primary drawn by this stand-in. */
export function temporaryAssistantFrame(type: TemporaryAssistantType, data: unknown): { title: string; subtitle: string; context: string } {
  const fields = fieldsOf(data);
  const [listKey, noun] = MAIN_LIST[type];
  const list = fields[listKey];
  const kind = type.toUpperCase();
  const said = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string) : undefined);
  return {
    title: said('title') ?? (type === 'weather' && said('location') ? `${kind} / ${said('location')}` : kind),
    subtitle: said('subtitle') ?? (Array.isArray(list) ? `${list.length} ${noun}` : kind),
    context: said('context') ?? kind,
  };
}

export function TemporaryAssistantList({ type, data, marked }: { type: TemporaryAssistantType; data: unknown; marked?: string }) {
  const fields = fieldsOf(data);
  const scalars: ReactNode[] = [];
  const lists: ReactNode[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (FRAME_KEYS.has(key)) continue;
    if (Array.isArray(value) && value.some((item) => item !== null && typeof item === 'object')) {
      lists.push(
        <section key={key} className="temporary-assistant__list">
          <div className="temporary-assistant__list-head tech micro">{key.toUpperCase()} / {value.length}</div>
          <ol>
            {value.map((item, index) => {
              const fields = fieldsOf(item);
              const key = itemKey(type, fields);
              return <Item key={index} fields={fields} itemKey={key} marked={key !== undefined && key === marked} />;
            })}
          </ol>
        </section>,
      );
    } else {
      scalars.push(
        <div key={key} className="temporary-assistant__field">
          <dt className="tech micro">{key}</dt>
          <dd>{plain(value)}</dd>
        </div>,
      );
    }
  }
  return (
    <div className="temporary-assistant" data-testid={type}>
      {/* The title here too: in an aux cell or in focus no frame shows it. */}
      <div className="temporary-assistant__head tech micro">
        {typeof fields.title === 'string' ? fields.title : `${type.toUpperCase()} / FIELDS AS SENT`}
      </div>
      {scalars.length > 0 ? <dl className="temporary-assistant__fields">{scalars}</dl> : null}
      {lists}
    </div>
  );
}
