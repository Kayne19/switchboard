// @vitest-environment jsdom
// A surface that throws while rendering degrades alone (issue #34).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SurfaceBoundary } from '../../src/components/SurfaceBoundary';

let host: HTMLDivElement;
let root: Root;
let logged: MockInstance<typeof console.error>;
let uncaught: unknown[];

function Broken(): ReactNode {
  throw new Error('bad series');
}

function Chart({ label }: { label: string }) {
  return <div className="chart">{label}</div>;
}

function stage(surface: ReactNode) {
  return (
    <main className="stage">
      <div className="presence">DAMOCLES</div>
      {surface}
      <div className="metric">GPU</div>
    </main>
  );
}

function render(node: ReactNode) {
  act(() => root.render(node));
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  uncaught = [];
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host, {
    onUncaughtError: (error) => uncaught.push(error),
    onCaughtError: () => {},
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('SurfaceBoundary', () => {
  it('renders its content while the content renders', () => {
    const object = { id: 'loss' };
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={object}><Chart label="LOSS" /></SurfaceBoundary>));

    expect(host.querySelector('.chart')?.textContent).toBe('LOSS');
    expect(host.querySelector('.surface-unavailable')).toBeNull();
  });

  it('marks only its own surface unavailable when the content throws', () => {
    const object = { id: 'loss' };
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={object}><Broken /></SurfaceBoundary>));

    expect(uncaught).toEqual([]);
    expect(host.querySelector('.presence')?.textContent).toBe('DAMOCLES');
    expect(host.querySelector('.metric')?.textContent).toBe('GPU');
    expect(host.querySelector('.surface-unavailable')?.textContent).toBe('OBJECT / UNAVAILABLE');
  });

  it('logs the failure with the id of the surface that failed', () => {
    const object = { id: 'loss' };
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={object}><Broken /></SurfaceBoundary>));

    const ours = logged.mock.calls.filter((call) => String(call[0]).includes('loss'));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContainEqual(expect.objectContaining({ message: 'bad series' }));
  });

  it('stays unavailable while its object is unchanged', () => {
    const object = { id: 'loss' };
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={object}><Broken /></SurfaceBoundary>));
    // The page re-renders for something else; the same broken object is
    // not retried on every render.
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={object}><Chart label="LOSS" /></SurfaceBoundary>));

    expect(host.querySelector('.surface-unavailable')).not.toBeNull();
    expect(host.querySelector('.chart')).toBeNull();
  });

  it('recovers when its object is replaced', () => {
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={{ id: 'loss' }}><Broken /></SurfaceBoundary>));
    render(stage(<SurfaceBoundary surfaceId="loss" resetKey={{ id: 'loss' }}><Chart label="LOSS" /></SurfaceBoundary>));

    expect(host.querySelector('.chart')?.textContent).toBe('LOSS');
    expect(host.querySelector('.surface-unavailable')).toBeNull();
  });

  it('stands its fallback in for the content when one is given', () => {
    render(stage(
      <SurfaceBoundary surfaceId="scene" resetKey={1} fallback={<div className="scene-fallback">PRESENCE ONLY</div>}>
        <Broken />
      </SurfaceBoundary>,
    ));

    expect(host.querySelector('.scene-fallback')?.textContent).toBe('PRESENCE ONLY');
    expect(host.querySelector('.surface-unavailable')).toBeNull();
    expect(host.querySelector('.metric')?.textContent).toBe('GPU');
  });
});
