// The shell the jsdom tests mount React into, written once. Before, each
// test file carried its own copy: a host element, a root, an afterEach that
// unmounted it, a `Scene` component that ran actions through the controller,
// and a no-op ResizeObserver.
//
// - `mount` renders a node into a new element on the page. Everything
//   mounted is unmounted, and its element removed, after each test.
//   vitest runs this file's afterEach, registered on import, after the test
//   file's own: a file whose afterEach takes away what the tree's cleanup
//   still uses (a spy, a stubbed global, fake timers, a stubbed prototype
//   getter) calls `unmountAll()` first, so the tree goes before them.
// - `renderScene` mounts the page's scene renderer and runs actions through
//   its controller, as the agent's display calls reach it; `runActions`
//   runs more, `lastScene` is the scene just drawn, `controllerState` what
//   the controller holds.
// - `stubResizeObserver` is opt-in, not in setupFiles: some files install
//   one that reports (railFit.test.tsx, calendarPaging.test.tsx).
//
// The act-environment flag every file used to set is in setup.ts.
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root, type RootOptions } from 'react-dom/client';
import { afterEach } from 'vitest';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction, ControllerState } from '../../src/controller/types';

const roots = new Map<HTMLElement, Root>();

/** Renders `node` into a new element appended to the page, and returns the element. */
export function mount(node: ReactNode, options?: RootOptions): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host, options);
  roots.set(host, root);
  act(() => root.render(node));
  return host;
}

/** Renders `node` again into the root `host` was mounted with. */
export function rerender(host: HTMLElement, node: ReactNode): void {
  const root = rootOf(host);
  act(() => root.render(node));
}

/** The root `host` was mounted with, for a test that must commit outside act(). */
export function rootOf(host: HTMLElement): Root {
  const root = roots.get(host);
  if (!root) throw new Error('rootOf: that element is not mounted');
  return root;
}

/** Unmounts what `host` holds before the test ends, and removes it from the page. */
export function unmount(host: HTMLElement): void {
  const root = roots.get(host);
  if (!root) return;
  roots.delete(host);
  try {
    act(() => root.unmount());
  } finally {
    host.remove();
  }
}

let sceneHost: HTMLDivElement | null = null;
let controller: { run: (actions: ControllerAction[]) => void; state: ControllerState } | null = null;

function SceneRunner({ actions }: { actions: ControllerAction[] }) {
  const { run, state } = useController();
  controller = { run, state };
  useEffect(() => run(actions), [actions, run]);
  return null;
}

/**
 * Mounts the page's scene renderer with `actions` run through its
 * controller, and returns the element it is mounted in. `before` renders
 * inside the controller ahead of the actions, so its effects run first.
 */
export function renderScene(actions: ControllerAction[], before?: ReactNode): HTMLDivElement {
  // runActions and lastScene name one scene; a second would take them over unseen.
  if (sceneHost && roots.has(sceneHost)) throw new Error('renderScene: a scene is already mounted in this test');
  sceneHost = mount(
    <ControllerProvider>
      {before}
      <SceneRunner actions={actions} />
      <SceneRenderer />
    </ControllerProvider>,
  );
  return sceneHost;
}

function scene() {
  if (!sceneHost || !controller || !roots.has(sceneHost)) throw new Error('no scene: call renderScene first');
  return { host: sceneHost, ...controller };
}

/** Runs more actions through the controller of the scene `renderScene` mounted. */
export function runActions(actions: ControllerAction[]): void {
  const { run } = scene();
  act(() => run(actions));
}

/** The scene just drawn: a scene that is leaving stays in the page until its exit ends, so it is the last. */
export function lastScene(): Element {
  return [...scene().host.querySelectorAll('[data-scene]')].at(-1)!;
}

/** The controller's state as the scene last rendered it. */
export function controllerState(): ControllerState {
  return scene().state;
}

/**
 * A ResizeObserver that never reports. jsdom has none, and a primitive that
 * measures its box needs one to mount; with this one every box reads as
 * jsdom, or the test, gives it.
 */
export function stubResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * The element a `url(#id)` attribute value names, looked up in `within`
 * (null where it names none there): SVG ids are each drawing's own
 * (`useSvgIds`), so a test follows the reference rather than spell an id.
 */
export function referenced(within: ParentNode, value: string | null | undefined): Element | null {
  const id = value?.match(/^url\(#(.+)\)$/)?.[1];
  return id ? ([...within.querySelectorAll('[id]')].find((element) => element.id === id) ?? null) : null;
}

/** Unmounts everything mounted, now; the harness does it after each test. */
export function unmountAll(): void {
  // Every root goes, even past one whose cleanup throws; the first error is reported.
  const errors: unknown[] = [];
  for (const host of [...roots.keys()]) {
    try {
      unmount(host);
    } catch (error) {
      errors.push(error);
    }
  }
  sceneHost = null;
  controller = null;
  if (errors.length > 0) throw errors[0];
}

afterEach(unmountAll);
