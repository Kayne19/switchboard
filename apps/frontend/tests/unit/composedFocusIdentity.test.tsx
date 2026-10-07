// @vitest-environment jsdom
// The composed primary shares its identity with its focus, as every other
// object does (ObjectMotion's `switchboard-object-<id>`), so focusing a
// single metric, progress or note primary grows the focus out of its slot.
// It passed `layoutId={undefined}` for anything but a metric cluster, and
// ObjectMotion spreads its props after its own layoutId, so the undefined
// took the default away: that focus only faded in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutMotion } from '../../src/hooks/useLayoutMotion';
import { renderScene, stubResizeObserver, unmountAll } from './sceneHarness';

const asked = vi.hoisted(() => [] as LayoutMotion[]);
vi.mock('../../src/hooks/useLayoutMotion', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/hooks/useLayoutMotion')>();
  return {
    ...original,
    useLayoutMotion: (motion: LayoutMotion) => {
      asked.push(motion);
      return original.useLayoutMotion(motion);
    },
  };
});

stubResizeObserver();

afterEach(() => {
  unmountAll();
  asked.length = 0;
});

const identities = () => new Set(asked.map((motion) => motion.layoutId).filter(Boolean));

describe('the composed primary', () => {
  const cases = [
    { name: 'a single metric', action: { op: 'show', id: 'build-time', type: 'metric', role: 'primary', data: { label: 'BUILD', value: '4m 12s' } } },
    { name: 'a progress', action: { op: 'show', id: 'ship', type: 'progress', role: 'primary', data: { label: 'SHIP', value: 40 } } },
    { name: 'a note', action: { op: 'show', id: 'aside', type: 'note', role: 'primary', data: { segments: [{ text: 'A note on its own.' }] } } },
  ] as const;
  for (const { name, action } of cases) {
    it(`shares its identity with its focus: ${name}`, () => {
      renderScene([action as never]);
      expect(identities()).toContain(`switchboard-object-${action.id}`);
    });
  }

  it('names a cluster by its own id: a cluster is not one of its metrics', () => {
    renderScene([
      { op: 'show', id: 'cpu', type: 'metric', role: 'primary', data: { label: 'CPU', value: '45%' } },
      { op: 'show', id: 'mem', type: 'metric', role: 'primary', data: { label: 'MEM', value: '62%' } },
    ] as never);
    expect(identities()).toContain('switchboard-object-primary-metric-cluster');
    expect(identities()).not.toContain('switchboard-object-cpu');
  });
});
