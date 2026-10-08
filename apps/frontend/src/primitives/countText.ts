/** A noun as a count names it: what one is called, and what several are. */
export type Noun = readonly [one: string, many: string];

/** A count as the page writes it ('1 TASK', '15 TASKS'). */
export function countText(count: number, [one, many]: Noun): string {
  return `${count} ${count === 1 ? one : many}`;
}
