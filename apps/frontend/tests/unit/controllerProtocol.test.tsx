// @vitest-environment jsdom
// `window.SwitchboardController.protocol` names the operations its
// `dispatch` takes. Those are the guarded boundary's (`validation.ts`); the
// list was a second one, kept beside the reducer, and still named `listen`,
// which the boundary refuses (issue #273).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { ControllerProvider } from '../../src/controller/context';
import { validateControllerAction } from '../../src/controller/validation';
import { mount, stubResizeObserver, unmountAll } from './sceneHarness';

stubResizeObserver();

class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

// The smallest action of each operation the page's reducer knows.
const ONE_OF_EACH: Record<string, Record<string, unknown>> = {
  show: { op: 'show', id: 'n', type: 'note', data: { segments: [{ text: 'x' }] } },
  hide: { op: 'hide', id: 'n' },
  say: { op: 'say', text: 'x' },
  focus: { op: 'focus', id: 'n' },
  listen: { op: 'listen', on: true },
  clear: { op: 'clear' },
};

describe('window.SwitchboardController.protocol', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('names exactly the operations dispatch takes', () => {
    mount(
      <ControllerProvider>
        <App />
      </ControllerProvider>,
    );
    const accepted = Object.keys(ONE_OF_EACH).filter((op) => validateControllerAction(ONE_OF_EACH[op]).ok);
    expect([...window.SwitchboardController.protocol].sort()).toEqual(accepted.sort());
    for (const op of Object.keys(ONE_OF_EACH).filter((name) => !accepted.includes(name))) {
      expect(() => window.SwitchboardController.dispatch(ONE_OF_EACH[op])).toThrow();
    }
  });
});
