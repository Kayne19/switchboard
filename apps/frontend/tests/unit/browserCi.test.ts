import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// CI runs the browser specs, all but the pixel goldens, in Chromium and in
// WebKit. jsdom lays nothing out, so a spec that measures a frame, a focus
// ring or the rail is the only thing that sees a regression there, and
// before the browser job none of them ran in CI. The goldens stay a local
// gate: they were drawn on the dev box, and the runner's fonts raster
// differently.

const root = path.resolve(import.meta.dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

/** A job's block in the workflow: from its key to the next job's. */
function job(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('the CI browser job', () => {
  it('keeps the `test` job master requires, and adds a browser job beside it', () => {
    expect(job('test')).toContain('npm test');
    expect(job('browser')).not.toBe('');
  });

  it('runs the browser specs but the goldens, and the production build in the browser', () => {
    const browser = job('browser');
    expect(browser).toContain('npm run test:browser');
    expect(browser).toContain('npm run test:integration');
    expect(scripts['test:browser']).toBe(`${scripts['test:visual']} --grep-invert @golden`);
  });

  it('installs each engine from a cache keyed by the engine and the lockfile that pins it', () => {
    const browser = job('browser');
    expect(browser).toMatch(/uses: actions\/cache@v\d+/);
    expect(browser).toContain('~/.cache/ms-playwright');
    expect(browser).toContain("playwright-${{ matrix.browser }}-${{ runner.os }}-${{ hashFiles('package-lock.json') }}");
    expect(browser).toContain('playwright install --with-deps ${{ matrix.browser }}');
  });

  // The iPad is a first-class target, and every iPad browser is WebKit
  // (docs/ipad.md): the specs and the production build run in it too.
  it('runs every leg in Chromium and in WebKit, one engine per leg', () => {
    const browser = job('browser');
    expect(browser).toContain('browser: [chromium, webkit]');
    expect(browser).toContain('--project=${{ matrix.browser }}');
    for (const config of ['apps/frontend/playwright.config.ts', 'apps/frontend/playwright.production.config.ts']) {
      const source = read(config);
      expect(source, config).toContain("browserName: 'chromium'");
      expect(source, config).toContain("browserName: 'webkit'");
    }
  });
});

// A hung test must end as a named failure, not hold a runner until GitHub's
// six-hour default kills the job and cuts the log off (#335). Each job has
// its own limit; inside the browser legs Playwright stops first, so it names
// the tests that did not finish and leaves test-results/ for the trace
// upload; the host-agent tests each have a default deadline.
describe('the CI time limits', () => {
  const minutes = (name: string) => Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job(name))?.[1]);
  const globalTimeout = (config: string) => /globalTimeout: process\.env\.CI \? (\d+) \* 60_000 : 0,/.exec(read(config))?.[1];

  it('bounds every job', () => {
    for (const name of ['test', 'browser']) expect(minutes(name), name).toBeGreaterThan(0);
  });

  it('stops Playwright on CI before the browser job\'s own limit', () => {
    for (const config of ['apps/frontend/playwright.config.ts', 'apps/frontend/playwright.production.config.ts']) {
      const limit = Number(globalTimeout(config));
      expect(limit, config).toBeGreaterThan(0);
      expect(limit, config).toBeLessThan(minutes('browser'));
    }
  });

  it('gives each host-agent test a default deadline', () => {
    expect(scripts['test:host-agent']).toMatch(/--test-timeout=\d+/);
  });
});

describe('the pixel goldens', () => {
  const dir = path.join(root, 'apps/frontend/tests/visual');
  const specs = readdirSync(dir).filter((file) => file.endsWith('.spec.ts'));

  it('are Chromium\'s alone: the WebKit project leaves them out', () => {
    expect(read('apps/frontend/playwright.config.ts')).toContain("{ name: 'webkit', use: { browserName: 'webkit' }, grepInvert: /@golden/ }");
  });

  it('are taken in visual.spec.ts alone, so the tag there is what keeps them out of CI', () => {
    const taking = specs.filter((file) => /toHaveScreenshot|toMatchSnapshot/.test(readFileSync(path.join(dir, file), 'utf8')));
    expect(taking).toEqual(['visual.spec.ts']);
  });

  // Each outermost test or describe (a test inside a describe takes its tag).
  it('are each tagged @golden', () => {
    const source = readFileSync(path.join(dir, 'visual.spec.ts'), 'utf8');
    const declarations = [...source.matchAll(/^ {0,2}test(?:\.\w+)*\((.*)$/gm)].filter((m) => !/^ {0,2}test\.use\(/.test(m[0])).map((m) => m[1]);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) expect(declaration).toMatch(/, GOLDEN, /);
    expect(source).toContain("const GOLDEN = { tag: '@golden' } as const;");
  });
});
