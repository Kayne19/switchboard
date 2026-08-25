import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }

const root = path.resolve(new URL('..', import.meta.url).pathname);
const sourceRoot = path.join(root, 'src');
const outRoot = path.join(root, 'dist');
const assetRoot = path.join(outRoot, 'assets');

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(assetRoot, { recursive: true });

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

function addJsExtensions(code) {
  const rewrite = (specifier) => {
    if (!specifier.startsWith('.')) return specifier;
    if (/\.(?:js|mjs|json|css)$/.test(specifier)) return specifier;
    return `${specifier}.js`;
  };
  return code
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, a, specifier, c) => `${a}${rewrite(specifier)}${c}`)
    .replace(/(import\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, a, specifier, c) => `${a}${rewrite(specifier)}${c}`)
    .replace(/(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g, (_match, a, specifier, c) => `${a}${rewrite(specifier)}${c}`);
}

for (const input of listFiles(sourceRoot)) {
  const relative = path.relative(sourceRoot, input);
  if (relative.endsWith('.d.ts') || relative.endsWith('.css')) continue;
  if (!/\.tsx?$/.test(relative)) continue;
  const source = fs.readFileSync(input, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: input,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      sourceMap: true,
    },
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    for (const diagnostic of errors) console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    process.exit(1);
  }
  let code = result.outputText.replace(/^import\s+["']\.\/styles\/index\.css["'];?\s*$/m, '');
  code = addJsExtensions(code);
  const output = path.join(assetRoot, relative.replace(/\.tsx?$/, '.js'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, code);
  if (result.sourceMapText) fs.writeFileSync(`${output}.map`, result.sourceMapText);
}

fs.copyFileSync(path.join(sourceRoot, 'styles/index.css'), path.join(assetRoot, 'index.css'));

const importMap = {
  imports: {
    react: 'https://esm.sh/react@19.1.1',
    'react/jsx-runtime': 'https://esm.sh/react@19.1.1/jsx-runtime',
    'react-dom': 'https://esm.sh/react-dom@19.1.1?external=react',
    'react-dom/client': 'https://esm.sh/react-dom@19.1.1/client?external=react',
    'motion/react': 'https://esm.sh/motion@12.23.12/react?external=react,react-dom',
  },
};

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#000000" />
  <title>Switchboard V17.2</title>
  <link rel="stylesheet" href="./assets/index.css" />
  <script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body>
  <div id="root"></div>
  <div id="boot-fallback" hidden>
    <p>React preview dependencies did not load.</p>
    <a href="./offline-reference.html">Open the approved offline reference</a>
  </div>
  <script type="module" src="./assets/main.js"></script>
  <script>
    setTimeout(() => {
      if (!document.querySelector('[data-scene-kind]')) {
        const fallback = document.getElementById('boot-fallback');
        if (fallback) fallback.hidden = false;
      }
    }, 6000);
  </script>
</body>
</html>`;
fs.writeFileSync(path.join(outRoot, 'index.html'), html);

const fallback = path.join(root, 'reference/lineage/approved-v16-controller.html');
if (fs.existsSync(fallback)) fs.copyFileSync(fallback, path.join(outRoot, 'offline-reference.html'));

fs.writeFileSync(path.join(outRoot, 'BUILD_INFO.json'), JSON.stringify({
  version: packageJsonVersion(),
  format: 'browser-esm-cdn-preview',
  generatedAt: new Date().toISOString(),
  note: 'Run npm run build for the fully bundled production build.',
}, null, 2));

function packageJsonVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

console.log(`CDN preview written to ${outRoot}`);
