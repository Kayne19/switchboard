// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPACT_STEPS, ProgressPrimitive, aheadStepWindow, compactStepWindow, type ProgressVariant } from '../../src/primitives/ProgressPrimitive';
import type { ProgressData, ProgressStep } from '../../src/controller/types';

let host: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(data: ProgressData, compact: boolean | ProgressVariant = false) {
  const variant: ProgressVariant = compact === true ? 'compact' : compact === false ? 'full' : compact;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ProgressPrimitive data={data} variant={variant} />));
  return host.querySelector('[data-testid="progress"]') as HTMLElement;
}

const plan: ProgressStep[] = [
  { label: 'Fetch', state: 'done', detail: '412 crates' },
  { label: 'Compile', state: 'active' },
  { label: 'Migrate', state: 'blocked', detail: 'lock held' },
  { label: 'Link' },
];

describe('ProgressPrimitive', () => {
  it('draws the bar alone when there are no steps', () => {
    const progress = render({ label: 'BUILD', value: 40, text: '40%' });
    expect(progress.classList.contains('progress-primitive--stepped')).toBe(false);
    expect(progress.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
    expect(progress.querySelector('[data-testid="progress-steps"]')).toBeNull();
  });

  it('lists every step under the bar with its state glyph and detail', () => {
    const progress = render({ label: 'BUILD', value: 25, steps: plan });
    expect(progress.classList.contains('progress-primitive--stepped')).toBe(true);
    const items = [...progress.querySelectorAll('.progress-step')];
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual(['done', 'active', 'blocked', 'todo']);
    expect(items.map((item) => item.querySelector('.progress-step__label')?.textContent)).toEqual(['Fetch', 'Compile', 'Migrate', 'Link']);
    // The glyph names the state for a screen reader; the detail sits in the muted face.
    expect(items.map((item) => item.querySelector('.progress-step__glyph')?.getAttribute('aria-label'))).toEqual(['done', 'active', 'blocked', 'todo']);
    expect(items[0].querySelector('.progress-step__detail')?.textContent).toBe('412 crates');
    expect(items[0].querySelector('.progress-step__detail')?.classList.contains('muted')).toBe(true);
    expect(items[1].querySelector('.progress-step__detail')).toBeNull();
    // A done step is a filled square with a tick; a todo step a hollow one.
    expect(items[0].querySelector('.progress-step__glyph rect')?.getAttribute('fill')).toBe('currentColor');
    expect(items[0].querySelector('.progress-step__glyph path')).not.toBeNull();
    expect(items[3].querySelector('.progress-step__glyph rect')?.getAttribute('fill')).toBe('none');
    expect(items[3].querySelector('.progress-step__glyph path')).toBeNull();
  });

  it('never creates elements from a step label', () => {
    const progress = render({ label: 'BUILD', value: 0, steps: [{ label: '<b>bold</b>', detail: '<img src=x>' }] });
    expect(progress.querySelector('b')).toBeNull();
    expect(progress.querySelector('img')).toBeNull();
    expect(progress.querySelector('.progress-step__label')?.textContent).toBe('<b>bold</b>');
  });

  it('lists the whole plan in the main slot, however long', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ label: `S${i}`, state: i < 20 ? ('done' as const) : undefined }));
    const progress = render({ label: 'BUILD', value: 66.67, steps });
    expect(progress.querySelectorAll('.progress-step')).toHaveLength(30);
    expect(progress.querySelector('.progress-step--elided')).toBeNull();
  });

  it('shows a short plan whole in a compact slot', () => {
    const progress = render({ label: 'BUILD', value: 25, steps: plan }, true);
    expect(progress.querySelectorAll('.progress-step')).toHaveLength(4);
    expect(progress.querySelector('.progress-step--elided')).toBeNull();
  });

  it('windows a long plan in a compact slot and counts the rest', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      label: `S${i}`,
      state: i < 7 ? ('done' as const) : i === 7 ? ('active' as const) : undefined,
    }));
    const progress = render({ label: 'BUILD', value: 58, steps }, true);
    const items = [...progress.querySelectorAll('.progress-step')];
    // One done step for context, then the active one and what follows it.
    expect(items.map((item) => item.textContent)).toEqual(['6 DONE', 'S6', 'S7', 'S8', 'S9', '2 MORE']);
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual([null, 'done', 'active', 'todo', 'todo', null]);
    expect(progress.querySelectorAll('.progress-step:not(.progress-step--elided)')).toHaveLength(COMPACT_STEPS);
  });
});

describe('the rail module', () => {
  const steps = Array.from({ length: 7 }, (_, i) => ({
    label: `S${i}`,
    detail: `D${i}`,
    state: i < 4 ? ('done' as const) : i === 4 ? ('active' as const) : i === 5 ? ('blocked' as const) : undefined,
  }));

  it('heads the module with a metric row: the label and the share done', () => {
    const progress = render({ label: 'SHIP', value: 57.14, steps }, 'rail');
    expect(progress.classList.contains('progress-primitive--rail')).toBe(true);
    const head = progress.querySelector('.progress-primitive__head')!;
    expect(head.classList.contains('metric-row')).toBe(true);
    expect(head.querySelector('.metric-row__label')?.textContent).toBe('SHIP');
    expect(head.querySelector('.metric-row__label')?.classList.contains('micro')).toBe(true);
    expect(head.querySelector('.metric-row__number')?.textContent).toBe('57%');
    expect(progress.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('57.14');
  });

  it('counts the steps done and lists the ones still to do, each with its glyph', () => {
    const progress = render({ label: 'SHIP', value: 57.14, steps }, 'rail');
    const items = [...progress.querySelectorAll('.progress-step')];
    expect(items.map((item) => item.querySelector('.progress-step__label')?.textContent ?? item.textContent)).toEqual(['4 DONE', 'S4', 'S5', 'S6']);
    expect(items.slice(1).map((item) => item.querySelector('.progress-step__glyph')?.getAttribute('aria-label'))).toEqual(['active', 'blocked', 'todo']);
  });

  it('draws a bar alone as one metric row over the bar', () => {
    const progress = render({ label: 'UPLOAD', value: 42 }, 'rail');
    expect(progress.querySelector('.metric-row__number')?.textContent).toBe('42%');
    expect(progress.querySelector('[data-testid="progress-steps"]')).toBeNull();
  });
});

describe('aheadStepWindow', () => {
  const steps = (states: Array<ProgressStep['state']>) => states.map((state, i) => ({ label: `S${i}`, state }));

  it('starts at the first step still to do and holds a compact window of them', () => {
    expect(aheadStepWindow(steps(['done', 'done', 'active', undefined, undefined, undefined, undefined]))).toEqual({ start: 2, end: 2 + COMPACT_STEPS });
    expect(aheadStepWindow(steps(['done', 'done', 'done', 'done', 'active', 'blocked', undefined]))).toEqual({ start: 4, end: 7 });
  });

  it('lists nothing but the count when the plan is done', () => {
    expect(aheadStepWindow(steps(['done', 'done', 'done']))).toEqual({ start: 3, end: 3 });
  });
});

describe('compactStepWindow', () => {
  const steps = (states: Array<ProgressStep['state']>) => states.map((state, i) => ({ label: `S${i}`, state }));

  it('keeps a plan no longer than the window whole', () => {
    expect(compactStepWindow(steps(['done', 'active', undefined, undefined]))).toEqual({ start: 0, end: 4 });
    expect(compactStepWindow(steps(['done']))).toEqual({ start: 0, end: 1 });
  });

  it('starts at the beginning while the first open step is still near it', () => {
    expect(compactStepWindow(steps(['active', undefined, undefined, undefined, undefined, undefined]))).toEqual({ start: 0, end: 4 });
    expect(compactStepWindow(steps(['done', 'active', undefined, undefined, undefined, undefined]))).toEqual({ start: 0, end: 4 });
  });

  it('puts one done step before the first open one', () => {
    expect(compactStepWindow(steps(['done', 'done', 'done', 'blocked', undefined, undefined, undefined]))).toEqual({ start: 2, end: 6 });
  });

  it('ends at the end when the plan is done or nearly so', () => {
    expect(compactStepWindow(steps(['done', 'done', 'done', 'done', 'done', 'done']))).toEqual({ start: 2, end: 6 });
    expect(compactStepWindow(steps(['done', 'done', 'done', 'done', 'done', 'active']))).toEqual({ start: 2, end: 6 });
  });
});
