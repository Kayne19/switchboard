// The display actions JSON cannot hold, built from display-actions.json
// beside this file (its description says why they are not corpus cases):
// each is `baseAction` with the number at `path` made NaN, Infinity or
// -Infinity. The page's validator (validation.test.ts) and the schema
// (schema.test.ts) must each refuse every one.
import fixtures from './display-actions.json';

const NON_FINITE: Record<string, number> = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY };

type Json = Record<string | number, unknown>;

export const nonFiniteActions: Array<{ name: string; action: unknown }> = fixtures.nonFiniteMutations.map((mutation) => {
  if (!(mutation.value in NON_FINITE)) throw new Error(`${mutation.name}: ${mutation.value} is not NaN, Infinity or -Infinity`);
  const action = JSON.parse(JSON.stringify(mutation.baseAction)) as Json;
  const target = mutation.path.slice(0, -1).reduce<Json>((node, key) => node[key] as Json, action);
  target[mutation.path[mutation.path.length - 1]] = NON_FINITE[mutation.value];
  return { name: mutation.name, action };
});
