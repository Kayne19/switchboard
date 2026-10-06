import { describe, expect, it } from 'vitest';
import Ajv, { type ValidateFunction } from 'ajv';
import schema from '../../../../docs/display-action-v1.schema.json';
import { nonFiniteActions } from '../fixtures/nonFiniteActions';
import { corpusCases, expandCorpusValue, type CorpusCase } from '../fixtures/validatorCorpus';

// docs/display-action-v1.schema.json is described (docs/display-tool.md) as
// the canonical DisplayAction contract. Nothing previously checked the schema
// itself, so it could (and did) drift from the two validators that actually
// run: the TypeScript controller (src/controller/validation.ts) and the Rust
// backend (apps/backend/src/visual_protocol.rs). This test holds it to the
// shared validator corpus (validator-corpus.json), the record of what both
// validators make of an action, and to the actions JSON cannot hold
// (display-actions.json: a NaN or an infinity).
//
// The schema declares draft-07 ("$schema": "http://json-schema.org/draft-07/schema#"),
// so it is compiled with plain `ajv`, not the draft 2019-09/2020-12 builds.
const ajv = new Ajv({
  allErrors: true,
  // The schema's pre-existing SpeechAnchor definition uses `anyOf` branches
  // that each `require` only one of two sibling properties; Ajv's strict
  // mode flags that as a possibly-mistaken `required` (strictRequired). It
  // is intentional here (an "at least one of x/series" check), so only that
  // one strict rule is relaxed.
  strictRequired: false,
});
const validate: ValidateFunction = ajv.compile(schema);

function errorSummary(): string {
  return ajv.errorsText(validate.errors, { separator: '; ' });
}

/** A schema node, as far as these tests read one. A `$ref` names a definition. */
interface SchemaNode {
  $ref?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
}
const contract = schema as unknown as { oneOf: SchemaNode[]; definitions: Record<string, SchemaNode> };
const definitions = contract.definitions;
/** The definition a node's `$ref` names, or the node itself. */
const resolve = (node: SchemaNode): SchemaNode => (node.$ref ? definitions[node.$ref.split('/').pop()!] : node);
/** The properties of every action the schema lists: one entry per op, one per show type. */
const actions = contract.oneOf.map((variant) => resolve(variant).properties!);

/**
 * Every show type's data shapes: one per type, or (a diagram's) one per
 * `mode`, named `type` or `type/mode`. `required` is the keys the shape
 * requires; a shape with an `anyOf` of `required` branches (progress: value
 * or steps) needs one branch met, and `branches` lists them.
 */
interface ShowShape { name: string; type: string; mode?: string; required: string[]; branches: string[][] }
const showShapes: ShowShape[] = actions.flatMap((properties) => {
  const type = properties.type?.enum?.[0];
  if (!type) return [];
  const data = resolve(properties.data);
  return (data.oneOf ? data.oneOf.map(resolve) : [data]).map((shape) => {
    const mode = shape.properties?.mode?.enum?.[0];
    return { name: mode ? `${type}/${mode}` : type, type, mode, required: shape.required ?? [], branches: (shape.anyOf ?? []).map((branch) => branch.required ?? []) };
  });
});

// The corpus cases both validators refuse and the schema accepts: each breaks
// a rule JSON Schema cannot state (docs/display-tool.md, "Canonical schema &
// validation rules"), grouped by why. The list is exact both ways: a refused
// case the schema accepts must be named here, and a case named here must be
// one the schema still accepts, so closing a gap, or a corpus change that no
// longer needs one, fails until this list follows it.
const SCHEMA_GAPS: Record<string, { why: string; cases: string[] }> = {
  items: {
    why:
      'a relationship between the items of a list (an id unique in its list, an endpoint naming a node or ' +
      "an actor, a self-loop, an edge pair, a row with one cell per column, a highlight naming a row): JSON Schema checks " +
      "each item's own shape and has no keyword for a property computed across the others without a vendor extension",
    cases: [
      'graph_node_id_duplicate', 'graph_edge_from_unknown', 'graph_edge_to_unknown', 'graph_edge_self_loop',
      'graph_edge_duplicate_pair', 'graph_edge_order_from_before_to', 'graph_edge_order_endpoints_before_self_loop',
      'sequence_actor_id_duplicate', 'sequence_message_from_unknown', 'sequence_message_to_unknown',
      'table_row_ragged', 'table_row_too_long', 'table_highlight_past_the_rows', 'table_highlight_with_no_rows',
      'calendar_event_duplicate_id', 'tasks_item_duplicate_id', 'timer_duplicate_id', 'weather_hour_duplicate_time',
      'weather_day_duplicate_date', 'inbox_message_duplicate_id',
    ],
  },
  fields: {
    why: "a series' value count against the chart's label count compares two sibling fields",
    cases: ['chart_series_longer_than_labels'],
  },
  times: {
    why: 'two times compared as times (an end before its start, `now` off `today`, a timer started at or after its end, offsets applied); a pattern reads one string',
    cases: [
      'calendar_now_after_today', 'calendar_now_before_today', 'calendar_event_end_a_minute_before_its_start',
      'calendar_event_end_the_day_before_its_start', 'calendar_event_end_on_an_earlier_day_at_a_later_hour',
      'timer_started_at_its_end', 'timer_started_at_its_end_in_another_offset', 'timer_started_after_its_end',
      'timer_started_after_its_end_by_its_offset', 'timer_started_a_nanosecond_after',
    ],
  },
  size: {
    why: 'the action-size caps bound the action as JSON.stringify writes it, a transport-level property, not the parsed instance',
    cases: [
      'size_one_byte_over_the_cap', 'size_counts_utf8_bytes', 'size_cap_is_general_for_a_non_image_type',
      'size_counts_long_numbers_as_javascript_writes_them', 'size_counts_exponents_as_javascript_writes_them',
      'size_say_normalized_over_the_cap',
    ],
  },
  utf16: {
    // Reproducing UTF-16-unit counting in the schema would take a hand-rolled
    // `pattern` that counts units only under Ajv's non-default
    // `unicodeRegExp: false`: the schema's meaning would hang on one
    // validator's configuration.
    why: "maxLength counts code points (the JSON Schema specification, and Ajv's default); the caps count UTF-16 code units, so an astral character is cheaper against the schema",
    cases: [
      'show_id_65_astral', 'chart_label_33_astral', 'calendar_event_id_65_astral', 'note_anchor_item_65_astral',
      'tasks_item_tag_17_astral', 'inbox_message_channel_17_astral',
    ],
  },
  signature: {
    why: "an image's bytes must start with the signature its format names: a cross-field check over decoded bytes (the schema pins the base64 alphabet, padding and length)",
    cases: [
      'image_bytes_jpeg_named_png', 'image_bytes_png_named_jpeg', 'image_bytes_riff_wave_named_webp',
    ],
  },
};

// The schema describes what the validators accept, so it must never be the
// stricter of the two, and it refuses what they refuse wherever JSON Schema
// can say why. The text of an error and the order of the checks are the
// corpus's to pin, not the schema's.
describe('display-action-v1.schema.json and the validator corpus', () => {
  it('accepts every action both validators accept', () => {
    const refused = corpusCases
      .filter((testCase) => testCase.accepted)
      .filter((testCase) => !validate(expandCorpusValue(testCase.action)))
      .map((testCase) => testCase.name);
    expect(refused).toEqual([]);
  });

  it('refuses every action both validators refuse, but for the rules it cannot state', () => {
    const gaps = new Set(Object.values(SCHEMA_GAPS).flatMap((gap) => gap.cases));
    const accepted = corpusCases
      .filter((testCase) => testCase.error !== undefined)
      .filter((testCase) => validate(expandCorpusValue(testCase.action)))
      .map((testCase) => testCase.name);
    expect(accepted.filter((name) => !gaps.has(name)), 'refused by both validators, accepted by the schema').toEqual([]);
    expect([...gaps].filter((name) => !accepted.includes(name)), 'in SCHEMA_GAPS, but not a refused case the schema accepts').toEqual([]);
  });

  // The time patterns state the whole of the time rules, real days and
  // leap years included, so every corpus case refused only for how a time
  // is written is refused by the schema too.
  it('refuses every time the validators refuse for how it is written', () => {
    const accepted = corpusCases
      .filter((testCase) => testCase.name.startsWith('time_') && testCase.error !== undefined)
      .filter((testCase) => validate(expandCorpusValue(testCase.action)))
      .map((testCase) => testCase.name);
    expect(accepted).toEqual([]);
  });

  // A refused name lists every name its field takes (docs/display-tool.md,
  // "How the two validators agree"). Each field's list is the one the schema
  // states for that field, in its order, so the error and the contract name
  // the same set; two sets with the same names in another order (a task's
  // state and a progress step's) cannot stand in for each other.
  it('lists, in every refusal of a name, the set the schema states for that field, in its order', () => {
    const property = (definition: string, key: string): string[] => {
      const shape = resolve(definitions[definition]);
      // A table cell is a string, a number or an object; the object has the semantic.
      const object = shape.oneOf?.find((branch) => branch.properties) ?? shape;
      return resolve(object.properties![key]).enum!;
    };
    const stated: Record<string, string[]> = {
      // The op, the show type and the diagram mode are stated one per action
      // or shape, across the schema's `oneOf`s.
      op: [...new Set(actions.map((properties) => properties.op.enum![0]))],
      'show.type': [...new Set(showShapes.map((shape) => shape.type))],
      'diagram.mode': showShapes.filter((shape) => shape.type === 'diagram').map((shape) => shape.mode!),
      'show.role': property('ShowChartAction', 'role'),
      'chart.kind': property('ChartData', 'kind'),
      'series.semantic': property('ChartSeries', 'semantic'),
      'metric.semantic': property('MetricData', 'semantic'),
      'metric.trend': property('MetricData', 'trend'),
      'progress step.state': property('ProgressStep', 'state'),
      'diagram node.semantic': property('DiagramNode', 'semantic'),
      'diagram node.state': property('DiagramNode', 'state'),
      'diagram edge.semantic': property('DiagramEdge', 'semantic'),
      'diagram actor.semantic': property('SequenceActor', 'semantic'),
      'diagram message.kind': property('SequenceMessage', 'kind'),
      'document.kind': property('DocumentData', 'kind'),
      'table column.semantic': property('TableColumn', 'semantic'),
      'table cell.semantic': property('TableCell', 'semantic'),
      'image.format': property('ImageData', 'format'),
      'note segment.semantic': property('RichSegment', 'semantic'),
      'calendar.view': property('CalendarData', 'view'),
      'calendar event.semantic': property('CalendarEvent', 'semantic'),
      'calendar event.status': property('CalendarEvent', 'status'),
      'task.state': property('TaskItem', 'state'),
      'task.priority': property('TaskItem', 'priority'),
      'timer.state': property('Timer', 'state'),
      'weather.units': property('WeatherData', 'units'),
      'weather current.condition': property('WeatherCurrent', 'condition'),
      'weather hour.condition': property('WeatherHour', 'condition'),
      'weather day.condition': property('WeatherDay', 'condition'),
      'inbox message.semantic': property('InboxMessage', 'semantic'),
    };
    const listed: Array<[string, string]> = [];
    for (const testCase of corpusCases) {
      const match = /^invalid ([^:]+): expected one of (.+?)(?: \(.*\))?$/.exec(testCase.error ?? '');
      if (match) listed.push([match[1], match[2]]);
    }
    // Every field the corpus refuses a name for is mapped above, and each
    // mapped field has a refusal in the corpus.
    expect([...new Set(listed.map(([field]) => field))].sort()).toEqual(Object.keys(stated).sort());
    for (const [field, names] of listed) expect(names.split(', '), field).toEqual(stated[field]);
  });

  // JSON cannot hold a NaN or an infinity, so these are not corpus cases.
  it('refuses every non-finite mutation (NaN, Infinity, -Infinity)', () => {
    for (const { name, action } of nonFiniteActions) {
      expect(validate(action), `expected schema to reject non-finite mutation "${name}"`).toBe(false);
    }
  });
});

// Both validators are held to the same source through the corpus, which
// both run (validatorCorpus.test.ts, and agrees_with_the_shared_validator_corpus
// in apps/backend/tests/test_visual_protocol.rs): for each show type the
// schema lists, the corpus accepts its smallest data, exactly the keys the
// schema requires, and for each of those keys refuses a case that holds the
// others but not it, with an error that names the key. Each side once kept
// its own copy of these samples.
describe('the corpus holds what display-action-v1.schema.json requires of each show type', () => {
  const shown = (testCase: CorpusCase) => {
    const action = testCase.action as { op?: unknown; type?: unknown; data?: unknown };
    if (action === null || typeof action !== 'object' || action.op !== 'show' || typeof action.data !== 'object' || action.data === null) return null;
    return { type: action.type, data: action.data as Record<string, unknown> };
  };
  const ofShape = (shape: ShowShape, testCase: CorpusCase, modeSent = true) => {
    const show = shown(testCase);
    if (!show || show.type !== shape.type) return null;
    return !modeSent || show.data.mode === shape.mode ? show.data : null;
  };
  const keys = (data: Record<string, unknown>) => Object.keys(data).sort();
  /** The accepted case whose data is exactly `wanted`'s keys. */
  const acceptedWith = (shape: ShowShape, wanted: string[]) =>
    corpusCases.find((testCase) => {
      const data = testCase.accepted && ofShape(shape, testCase);
      return data && keys(data).join() === [...wanted].sort().join();
    });

  it("knows exactly the schema's show types and their shapes", () => {
    const named = new Set(corpusCases.filter((testCase) => testCase.accepted).flatMap((testCase) => {
      const show = shown(testCase);
      return show ? [show.data.mode === undefined ? `${show.type}` : `${show.type}/${show.data.mode}`] : [];
    }));
    expect([...named].sort()).toEqual(showShapes.map((shape) => shape.name).sort());
  });

  for (const shape of showShapes) {
    it(`accepts the smallest ${shape.name} and refuses it without each required key`, () => {
      // The first `anyOf` branch is the one the smallest data carries.
      const required = [...shape.required, ...(shape.branches[0] ?? [])];
      expect(acceptedWith(shape, required)?.name, `${shape.name}: an accepted case with exactly ${required.join(', ')}`).toBeDefined();
      for (const key of required) {
        const refused = corpusCases.find((testCase) => {
          const data = testCase.error !== undefined && ofShape(shape, testCase, key !== 'mode');
          return data && !(key in data) && required.every((other) => other === key || other in data) && new RegExp(`\\b${key}\\b`).test(testCase.error!);
        });
        expect(refused?.name, `${shape.name} without ${key}: a refused case whose error names it`).toBeDefined();
      }
    });
  }

  it("accepts a progress with steps in place of value, the schema's other anyOf branch", () => {
    const progress = showShapes.find((shape) => shape.name === 'progress')!;
    expect(progress.branches).toEqual([['value'], ['steps']]);
    const steps = acceptedWith(progress, [...progress.required, 'steps']);
    expect(steps?.name).toBeDefined();
    expect(validate(expandCorpusValue(steps!.action)), errorSummary()).toBe(true);
  });
});
