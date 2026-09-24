// @vitest-environment jsdom
// Every tool call registers on the activity panel (#27): a run of calls to
// one tool must read as a run of calls, not as one call still running.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityState } from '../../src/controller/types';
import { activitySummary, ToolActivity } from '../../src/primitives/ToolActivity';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const read = (call: number, detail = 'apps/backend/src/api.rs'): ActivityState => ({ label: 'switchboard', tool: 'read', detail, call });
const show = (activity: ActivityState | null) => act(() => root.render(<ToolActivity activity={activity} reserveSpace />));
const panel = () => host.querySelector<HTMLElement>('[data-testid="tool-activity"]');
const callLine = () => host.querySelector<HTMLElement>('.tool-activity__call');
const sweep = () => host.querySelector<HTMLElement>('.tool-activity__sweep');

describe('tool activity calls', () => {
  it('brings each call of the same tool in afresh, in the panel it already has', () => {
    show(read(1));
    const firstPanel = panel();
    const firstLine = callLine();
    const firstSweep = sweep();
    expect(firstPanel?.getAttribute('data-call')).toBe('1');
    expect(firstLine?.textContent).toContain('read');

    show(read(2));
    // The same panel: the slot never blinks between calls.
    expect(panel()).toBe(firstPanel);
    expect(panel()?.getAttribute('data-call')).toBe('2');
    // A new call line and a new sweep, even with the same tool and detail.
    expect(callLine()).not.toBe(firstLine);
    expect(sweep()).not.toBe(firstSweep);
    expect(callLine()?.textContent).toContain('read');
  });

  it('replaces a lingering finished call at once when the next one starts', () => {
    show(read(1));
    show(null);
    act(() => vi.advanceTimersByTime(200));
    expect(panel()?.textContent).toContain('LAST TOOL USED');
    const lingering = callLine();

    show(read(2, 'apps/backend/src/pbx.rs'));
    expect(panel()?.textContent).toContain('CURRENT ACTIVITY');
    expect(callLine()).not.toBe(lingering);
    expect(callLine()?.textContent).toContain('apps/backend/src/pbx.rs');
  });

  it('keeps the reserved slot the panel\'s own height across a call change', () => {
    show(read(1));
    const slot = host.querySelector('.tool-activity-slot')!;
    const sizer = slot.querySelector('.tool-activity-slot__sizer')!;
    // The sizer mirrors the panel's lines: a header, a tool line and a detail line.
    expect(sizer.children).toHaveLength(3);
    expect(callLine()?.children).toHaveLength(2);
    show(read(2));
    expect(slot.querySelector('.tool-activity-slot__sizer')).toBe(sizer);
  });
});

// #50: calls made together arrive faster than a frame, so the panel counts
// them rather than naming only the last.
describe('tool call bursts', () => {
  const burst = (tool: string, detail: string, counts: Array<[string, number]>): ActivityState => ({
    label: 'switchboard',
    tool,
    detail,
    call: 9,
    burst: counts.map(([name, count]) => ({ tool: name, count })),
  });

  it('names a lone call by its tool and detail', () => {
    expect(activitySummary(read(1))).toEqual({ title: 'read', detail: 'apps/backend/src/api.rs', count: 1 });
  });

  it('counts a burst of one tool by what it worked on, keeping the latest detail', () => {
    show(burst('read', 'src/file-19.ts', [['read', 20]]));
    expect(host.querySelector('.tool-activity__call .tool-activity__tool')?.textContent).toBe('read / 20 files');
    expect(host.querySelector('.tool-activity__call .tool-activity__detail')?.textContent).toBe('src/file-19.ts');
    expect(panel()?.getAttribute('data-count')).toBe('20');
    expect(activitySummary(burst('grep', 'TODO', [['grep', 4]])).title).toBe('grep / 4 searches');
    expect(activitySummary(burst('route_check', '', [['route_check', 3]])).title).toBe('route_check / 3 calls');
  });

  it('counts every call of a mixed burst and lists its tools, the busiest first', () => {
    show(burst('grep', 'TODO', [['grep', 2], ['read', 20]]));
    expect(host.querySelector('.tool-activity__call .tool-activity__tool')?.textContent).toBe('22 tool calls');
    expect(host.querySelector('.tool-activity__call .tool-activity__detail')?.textContent).toBe('read 20 / grep 2');
  });

  it('says the finished burst was tools, not one tool', () => {
    show(burst('read', 'src/file-19.ts', [['read', 20]]));
    show(null);
    act(() => vi.advanceTimersByTime(200));
    expect(panel()?.textContent).toContain('LAST TOOLS USED');
    expect(host.querySelector('.tool-activity__call .tool-activity__tool')?.textContent).toBe('read / 20 files');
  });
});
