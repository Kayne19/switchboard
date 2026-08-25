import type { ControllerState, FixtureName } from './controller/types';

declare global {
  interface Window {
    SwitchboardController: {
      dispatch: (action: unknown) => void;
      run: (actions: unknown[]) => void;
      load: (fixture: FixtureName) => void;
      state: () => ControllerState;
      protocol: readonly ['show', 'hide', 'say', 'focus', 'listen', 'clear'];
    };
  }
}

export {};
