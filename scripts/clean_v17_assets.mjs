import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite shares static/ with the VAD worklet and the wake-word assets, so it
// cannot empty the whole output directory. Remove its owned, content-hashed
// subtree, and any output of the deleted legacy runtime a local checkout may
// still hold, so a local build serves exactly what is committed.
const staticRoot = resolve(import.meta.dirname, '../static');

rmSync(resolve(staticRoot, 'v17-assets'), { recursive: true, force: true });
rmSync(resolve(staticRoot, 'legacy'), { recursive: true, force: true });

for (const staleFile of [
  'app.js',
  'diagram.js',
  'diff.js',
  'hands_free.js',
  'protocol.js',
  'stage.js',
  'synchro.js',
  'wake_detector.js',
  'wake_word.js',
]) {
  rmSync(resolve(staticRoot, staleFile), { force: true });
}
