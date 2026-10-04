import { describe, expect, it } from 'vitest';
import Ajv, { type ValidateFunction } from 'ajv';
import schema from '../../../../docs/display-action-v1.schema.json';
import fixtures from '../fixtures/display-actions.json';
import { validateControllerAction } from '../../src/controller/validation';

// docs/display-action-v1.schema.json is described (docs/display-tool.md) as
// the canonical DisplayAction contract, exercised by this same fixture file.
// Nothing previously checked the schema itself against it, so it could (and
// did) drift from the two validators that actually run: the TypeScript
// controller (src/controller/validation.ts) and the Rust backend
// (apps/backend/src/visual_protocol.rs). This test is that check.
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

// Fixtures below are real, understood disagreements between the schema and
// the validators that JSON Schema cannot close without either a
// non-standard vendor keyword or a data model JSON Schema does not have
// access to. Each is a deliberate, documented exception, not an oversight:
// this set is asserted against directly so that closing a gap (or a fixture
// change that no longer needs the exception) fails the test until this list
// is updated, instead of the mismatch silently vanishing.
const KNOWN_SCHEMA_GAPS: Record<string, string> = {
  // Node/edge referential integrity and uniqueness are checks over
  // *relationships between sibling array items* (duplicate ids, an edge
  // endpoint that names no node, a self-loop, a duplicate edge pair).
  // Standard JSON Schema (any draft) validates each item's own shape; it
  // has no keyword for a computed property across an array's other items
  // without a vendor extension (e.g. ajv-keywords' uniqueItemProperties, or
  // an Ajv-only $data reference). The graph invariants stay enforced only
  // by visual_protocol.rs and validation.ts.
  diagram_duplicate_node_id: 'node id uniqueness is a cross-item invariant, not a per-node shape rule',
  diagram_edge_missing_endpoint: 'edge endpoints referencing nodes[] is cross-array referential integrity',
  diagram_edge_self_loop: 'from === to is an equality check between two sibling fields',
  diagram_edge_duplicate_pair: 'duplicate (from, to) pairs is a cross-item uniqueness invariant',
  // A table row's length must equal `columns.length`, and a highlight index
  // must name a row: both relate one array to another in the same object.
  // The schema bounds a row at 12 cells and an index at a non-negative
  // integer; the exact fit stays with visual_protocol.rs and validation.ts.
  table_ragged_row: 'a row having exactly columns.length cells relates two sibling arrays',
  table_highlight_out_of_range: 'a highlight index naming an existing row relates two sibling arrays',
  // The same two invariants in sequence mode, over actors and messages.
  diagram_sequence_duplicate_actor_id: 'actor id uniqueness is a cross-item invariant, not a per-actor shape rule',
  diagram_sequence_message_missing_endpoint: 'message endpoints referencing actors[] is cross-array referential integrity',
  // A series' value count against the chart's label count is a relationship
  // between two sibling fields of the chart data, the same kind of check.
  chart_values_longer_than_labels: 'series.values.length <= labels.length compares two sibling fields',
  // The 48,000 UTF-8 byte cap bounds the serialized envelope on the wire
  // (see docs/display-tool.md, "Action size"). JSON Schema validates the
  // shape of the parsed instance, not the byte length of its serialization;
  // there is no keyword for "the JSON text you were decoded from is short
  // enough". This stays an application/transport-level check.
  oversized_action_bytes: 'total serialized byte size is a transport-level property, not part of the parsed instance',
  // `maxLength` counts Unicode code points, per the JSON Schema
  // specification (RFC 8259's definition of a JSON string's length) and
  // Ajv's default (spec-compliant) behavior. The app's own `id`/text caps
  // are deliberately defined in UTF-16 code units (docs/display-tool.md:
  // "String caps (UTF-16 code units)"), so an astral character (one code
  // point, two UTF-16 units) is cheaper against the schema's cap than
  // against the app's. This fixture's id is 97 code points / 130 UTF-16
  // units: under the schema's 128-code-point cap, over the app's 128-unit
  // one. Reproducing UTF-16-unit counting in the schema is only possible by
  // replacing `maxLength` with a hand-rolled, non-unicode `pattern`, which
  // itself only counts UTF-16 units under Ajv's non-default
  // `unicodeRegExp: false` option — i.e. by making the schema's meaning
  // depend on a specific validator's non-default configuration. Left as an
  // open contract question rather than silently patched over.
  oversized_id_astral_utf16: 'maxLength is Unicode-code-point-based per spec; the app caps UTF-16 code units',
};

describe('display-action-v1.schema.json', () => {
  it('accepts every canonical valid fixture', () => {
    for (const testCase of fixtures.valid) {
      const ok = validate(testCase.action);
      expect(ok, `expected schema to accept valid fixture "${testCase.name}": ${errorSummary()}`).toBe(true);
    }
  });

  it('rejects every canonical invalid fixture, except the documented schema gaps', () => {
    for (const testCase of fixtures.invalid) {
      const ok = validate(testCase.action);
      const gapReason = KNOWN_SCHEMA_GAPS[testCase.name];
      if (gapReason !== undefined) {
        expect(
          ok,
          `"${testCase.name}" is tracked in KNOWN_SCHEMA_GAPS (${gapReason}) and expected to ` +
            `still (wrongly) validate against the schema; if the schema now rejects it, drop it from that list`,
        ).toBe(true);
      } else {
        expect(
          ok,
          `expected schema to reject invalid fixture "${testCase.name}" (${testCase.reason}), but it validated`,
        ).toBe(false);
      }
    }
  });

  it('rejects every non-finite mutation (NaN, Infinity, -Infinity)', () => {
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

  it('has no stale entries in KNOWN_SCHEMA_GAPS', () => {
    const invalidNames = new Set(fixtures.invalid.map((c) => c.name));
    for (const name of Object.keys(KNOWN_SCHEMA_GAPS)) {
      expect(invalidNames.has(name), `KNOWN_SCHEMA_GAPS references "${name}", which is not in fixtures.invalid`).toBe(
        true,
      );
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
