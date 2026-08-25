import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite shares static/ with the isolated legacy runtime and wake-word assets,
// so it cannot empty the whole output directory. Remove only its owned,
// content-hashed subtree to keep committed builds deterministic.
rmSync(resolve(import.meta.dirname, '../static/v17-assets'), {
  recursive: true,
  force: true,
});
