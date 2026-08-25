import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const packageJson = JSON.parse(fs.readFileSync(path.resolve(root, '../../package.json'), 'utf8'));
const glyph = read('src/primitives/DamoclesGlyph.tsx');
const reducer = read('src/controller/reducer.ts');
const styles = read('src/styles/index.css');
const designSources = ['App.tsx', 'main.tsx', 'app', 'components', 'controller', 'design', 'fixtures', 'hooks', 'integration', 'primitives', 'styles'];
const collectSource = (relative) => {
  const absolute = path.join(root, 'src', relative);
  if (fs.statSync(absolute).isFile()) return /\.(ts|tsx|css)$/.test(relative) ? [read(path.join('src', relative))] : [];
  return fs.readdirSync(absolute, { recursive: true })
    .filter((entry) => typeof entry === 'string' && /\.(ts|tsx|css)$/.test(entry))
    .map((entry) => read(path.join('src', relative, entry)));
};
const allSource = designSources.flatMap(collectSource).join('\n');

const requiredGlyphPolygons = [
  '393,465 440,512 440,976 393,929',
  '461,533 479,551 479,1015 461,997',
  '442,176 460,176 460,441 442,423',
  '451,75 435,106 405,135 428,155 442,181 460,181 474,155 497,135 467,106',
  '235,327 335,327 707,699 641,699 335,393 301,393',
  '451,115 467,135 451,154 435,135',
];
for (const points of requiredGlyphPolygons) assert(glyph.includes(points), `Damocles glyph geometry changed: ${points}`);

assert(reducer.includes("['show', 'hide', 'say', 'focus', 'listen', 'clear']"), 'Six-operation protocol changed.');
assert(allSource.includes('model-controlled layout field is forbidden'), 'Runtime protocol boundary validation is missing.');
assert(styles.includes('@container stage (max-aspect-ratio: 1/1)'), 'Portrait must be selected through stage geometry.');
assert(styles.includes('@container stage (min-aspect-ratio: 2/1)'), 'Very-wide composition rule is missing.');
assert(!/@media\s*\([^)]*(min|max)-width/i.test(styles), 'Width-based media breakpoint found. Use container geometry.');
assert(!/\b(iPad|iPhone|tablet|mobile breakpoint|desktop breakpoint)\b/i.test(allSource), 'Device-specific layout language found in source.');
assert(!/border-radius\s*:\s*(?:[4-9]|[1-9]\d)px/i.test(styles), 'Conventional rounded-card styling found.');

const forbiddenPackages = ['@mui/material', 'bootstrap', 'tailwindcss', '@chakra-ui/react', 'antd'];
const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
for (const name of forbiddenPackages) assert(!(name in dependencies), `Forbidden generic UI framework dependency: ${name}`);

assert(allSource.includes('layoutId={`switchboard-object-${objectId}`}'), 'Shared object layout identity is missing.');
assert(allSource.includes("data-testid=\"damocles-presence\""), 'Shared DamoclesPresence primitive is missing.');
assert(allSource.includes('prefers-reduced-motion'), 'Reduced-motion protection is missing.');

if (failures.length) {
  console.error('DESIGN LOCK FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Design lock verified.');
