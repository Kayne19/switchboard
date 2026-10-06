// Run before every unit test file (vite.config.ts `test.setupFiles`). React
// warns of an update outside act() unless the environment says the tests
// drive it through act(), which every jsdom test here does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
