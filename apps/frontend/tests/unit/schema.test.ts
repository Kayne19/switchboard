import { describe, expect, it } from 'vitest';
import Ajv, { type ValidateFunction } from 'ajv';
import schema from '../../../../docs/display-action-v1.schema.json';
import fixtures from '../fixtures/display-actions.json';
import { corpusCases, expandCorpusValue } from '../fixtures/validatorCorpus';
import { validateControllerAction } from '../../src/controller/validation';

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

  // JSON cannot hold a NaN or an infinity, so these are not corpus cases.
  it('refuses every non-finite mutation (NaN, Infinity, -Infinity)', () => {
    for (const mutation of fixtures.nonFiniteMutations) {
      const cloned = JSON.parse(JSON.stringify(mutation.baseAction));
      let target: any = cloned;
      for (let i = 0; i < mutation.path.length - 1; i++) {
        target = target[mutation.path[i]];
      }
      const lastKey = mutation.path[mutation.path.length - 1];
      if (mutation.value === 'Infinity') {
        target[lastKey] = Number.POSITIVE_INFINITY;
      } else if (mutation.value === '-Infinity') {
        target[lastKey] = Number.NEGATIVE_INFINITY;
      } else if (mutation.value === 'NaN') {
        target[lastKey] = Number.NaN;
      }

      const ok = validate(cloned);
      expect(ok, `expected schema to reject non-finite mutation "${mutation.name}"`).toBe(false);
    }
  });
});

// The browser validator is held to the same source: it accepts every show type
// the schema lists with exactly the data the schema requires, and refuses each
// when a required key is missing.
describe('validateControllerAction follows display-action-v1.schema.json', () => {
  const definitions = schema.definitions as Record<string, any>;
  const resolve = (node: any) => (node.$ref ? definitions[node.$ref.split('/').pop()!] : node);
  // A type's data is one shape, or (a diagram's) one shape per `mode`; a
  // shape is named by its type and, when it has one, its mode.
  const requiredByShape: Record<string, string[]> = {};
  for (const variant of schema.oneOf as Array<{ $ref: string }>) {
    const action = definitions[variant.$ref.split('/').pop()!];
    const kind: string | undefined = action.properties.type?.enum?.[0];
    if (!kind) continue;
    const data = resolve(action.properties.data);
    const shapes: any[] = data.oneOf ? data.oneOf.map(resolve) : [data];
    for (const shape of shapes) {
      const mode: string | undefined = shape.properties.mode?.enum?.[0];
      // A shape with an `anyOf` of `required` branches (progress: value or
      // steps) needs one branch met; the first is the one the sample carries.
      const firstBranch: string[] = shape.anyOf?.[0]?.required ?? [];
      requiredByShape[mode ? `${kind}/${mode}` : kind] = [...shape.required, ...firstBranch].sort();
    }
  }
  // The smallest data the validator accepts for each shape; each carries
  // exactly the schema's required keys (and the first `anyOf` branch's),
  // checked below.
  const smallest: Record<string, Record<string, unknown>> = {
    chart: { series: [{ name: 'a', values: [1] }] },
    metric: { label: 'L', value: '1' },
    progress: { label: 'L', value: 50 },
    'diagram/graph': { mode: 'graph', nodes: [{ id: 'n', label: 'N' }], edges: [] },
    'diagram/sequence': { mode: 'sequence', actors: [{ id: 'a', label: 'A' }], messages: [] },
    document: { subject: 'S', paragraphs: ['p'] },
    code: { source: { text: 'x' } },
    table: { columns: [{ label: 'c' }], rows: [] },
    note: { segments: [{ text: 't' }] },
    // A real 1x1 PNG: the validator sniffs the bytes, so a placeholder would not do.
    image: { format: 'png', bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN48ew+AAVnAq5EDgAUAAAAAElFTkSuQmCC', alt: 'a' },
    calendar: { view: 'week', start: '2026-10-05', events: [] },
    tasks: { items: [{ id: 't', text: 'T' }] },
    timer: { timers: [{ id: 't', label: 'T', endsAt: '2026-10-05T18:42:00Z' }] },
    weather: { location: 'L', units: 'C', current: { temp: 1, condition: 'clear' } },
    inbox: { messages: [{ id: 'm', from: 'F', time: '2026-10-05' }] },
  };

  it('knows exactly the schema\'s show types and their shapes', () => {
    expect(Object.keys(smallest).sort()).toEqual(Object.keys(requiredByShape).sort());
  });

  for (const [shape, required] of Object.entries(requiredByShape)) {
    it(`accepts the smallest ${shape} and refuses it without each required key`, () => {
      const data = smallest[shape];
      const kind = shape.split('/')[0];
      expect(Object.keys(data).sort()).toEqual(required);
      const action = { op: 'show', id: 'x', type: kind, data };
      expect(validateControllerAction(action).ok, `${shape}: ${JSON.stringify(validateControllerAction(action))}`).toBe(true);
      for (const key of required) {
        const { [key]: _dropped, ...rest } = data;
        expect(validateControllerAction({ ...action, data: rest }).ok, `${shape} without ${key}`).toBe(false);
      }
    });
  }

  it('accepts a progress with steps in place of value, the schema\'s other anyOf branch', () => {
    const branches = (definitions.ProgressData.anyOf as Array<{ required: string[] }>).map((branch) => branch.required);
    expect(branches).toEqual([['value'], ['steps']]);
    const action = { op: 'show', id: 'x', type: 'progress', data: { label: 'L', steps: [{ label: 'S' }] } };
    expect(validate(action), errorSummary()).toBe(true);
    expect(validateControllerAction(action).ok).toBe(true);
  });
});
