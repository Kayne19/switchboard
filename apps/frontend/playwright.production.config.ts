import { chromium, defineSuite } from './playwright.base';

// The production build is served on a port of its own (4173 is the dev
// server's, 4174 the debug dev server's, 4183 the browser suite's) by a
// server the suite starts and never reuses, for the reason
// playwright.config.ts gives. PLAYWRIGHT_INTEGRATION_PORT moves it, so two
// checkouts can run the suite at once.
const port = Number(process.env.PLAYWRIGHT_INTEGRATION_PORT || 4184);

export default defineSuite({
  testDir: './tests/integration',
  port,
  serve: 'npm --prefix ../.. run build && npm --prefix ../.. run preview',
  expect: { timeout: 8_000 },
  use: { permissions: ['microphone'] },
  // The production build in Chromium and in WebKit, the iPad's engine
  // (docs/ipad.md); `--project=chromium` or `--project=webkit` runs one.
  projects: [
    // A fake microphone lets the native runtime record without a device.
    chromium(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']),
    // WebKit's own mock capture device stands in for the microphone.
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
