import { two } from './timeLabels';

/** A noun as a count names it: what one is called, and what several are. */
export type Noun = readonly [one: string, many: string];

/** A count as the page writes it ('1 TASK', '15 TASKS'); `pad` gives it two
 * digits at least, as the drawing rims and the folded rail count ('07 NODES'). */
export function countText(count: number, [one, many]: Noun, { pad = false }: { pad?: boolean } = {}): string {
  return `${pad ? two(count) : count} ${count === 1 ? one : many}`;
}

/** A count on a scroller's rim, two digits at least wherever a rim counts ('07 NODES', '06 TASKS', 'MON-TUE / 07 EVENTS'), as the folded rail counts its modules ('02 METRICS'). */
export function rimCount(count: number, noun: Noun): string {
  return countText(count, noun, { pad: true });
}
