import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// CI runs the browser specs, all but the pixel goldens. jsdom lays nothing
// out, so a spec that measures a frame, a focus ring or the rail is the only
// thing that sees a regression there, and before the browser job none of
// them ran in CI. The goldens stay a local gate: they were drawn on the dev
// box, and the runner's fonts raster differently.

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

  it('installs Chromium from a cache keyed by the lockfile that pins it', () => {
    const browser = job('browser');
    expect(browser).toMatch(/uses: actions\/cache@v\d+/);
    expect(browser).toContain('~/.cache/ms-playwright');
    expect(browser).toContain("hashFiles('package-lock.json')");
    expect(browser).toContain('playwright install --with-deps chromium');
  });
});

describe('the pixel goldens', () => {
  const dir = path.join(root, 'apps/frontend/tests/visual');
  const specs = readdirSync(dir).filter((file) => file.endsWith('.spec.ts'));

  it('are taken in visual.spec.ts alone, so the tag there is what keeps them out of CI', () => {
    const taking = specs.filter((file) => readFileSync(path.join(dir, file), 'utf8').includes('toHaveScreenshot'));
    expect(taking).toEqual(['visual.spec.ts']);
  });

  // Each outermost test or describe (a test inside a describe takes its tag).
  it('are each tagged @golden', () => {
    const source = readFileSync(path.join(dir, 'visual.spec.ts'), 'utf8');
    const declarations = [...source.matchAll(/^ {0,2}test(?:\.describe)?\((.*)$/gm)].map((m) => m[1]);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) expect(declaration).toMatch(/, GOLDEN, /);
    expect(source).toContain("const GOLDEN = { tag: '@golden' } as const;");
  });
});
