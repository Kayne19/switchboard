import type { ControllerState, FixtureName } from './controller/types';
import type { OPERATIONS } from './controller/validation';

declare global {
  interface Window {
    SwitchboardController: {
      dispatch: (action: unknown) => void;
      run: (actions: unknown[]) => void;
      load: (fixture: FixtureName) => void;
      state: () => ControllerState;
      protocol: typeof OPERATIONS;
    };
  }
}

export {};
