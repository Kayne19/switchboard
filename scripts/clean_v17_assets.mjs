import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite shares static/ with the isolated legacy runtime and wake-word assets,
// so it cannot empty the whole output directory. Remove its owned,
// content-hashed subtree and obsolete visual assets to keep committed builds
// deterministic and ensure legacy visual modules cannot survive.
rmSync(resolve(import.meta.dirname, '../static/v17-assets'), {
  recursive: true,
  force: true,
});

for (const staleFile of ['diagram.js', 'stage.js', 'diff.js']) {
  rmSync(resolve(import.meta.dirname, '../static', staleFile), {
    force: true,
  });
}
