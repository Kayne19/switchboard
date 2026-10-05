import type {
  CalendarData,
  ControllerAction,
  DiagramData,
  DiagramNode,
  FixtureName,
  InboxData,
  Semantic,
  SequenceDiagramData,
  TasksData,
  TimerData,
  WeatherCondition,
  WeatherData,
} from '../controller/types';

const trainingSeries = {
  xLabel: 'EPOCH',
  yLabel: 'LOSS',
  xMax: 40,
  yMin: 0.08,
  yMax: 0.3,
  marker: { x: 32, series: 'VAL LOSS' },
  series: [
    {
      name: 'TRAIN LOSS',
      semantic: 'green' as const,
      values: [0.277,0.262,0.249,0.236,0.225,0.214,0.204,0.195,0.186,0.178,0.17,0.162,0.155,0.148,0.142,0.136,0.131,0.126,0.121,0.117,0.113,0.11,0.108,0.106,0.105,0.1041],
    },
    {
      name: 'VAL LOSS',
      semantic: 'orange' as const,
      values: [0.284,0.269,0.254,0.24,0.227,0.216,0.206,0.197,0.189,0.181,0.175,0.169,0.164,0.159,0.155,0.152,0.15,0.151,0.154,0.158,0.164,0.171,0.179,0.188,0.197,0.1832],
    },
  ],
};

// Test suite wall time by package, this run against the last: the shape a
// bar chart is for, with a labelled category per package.
const suiteDurations = {
  kind: 'bar' as const,
  labels: ['backend', 'frontend unit', 'frontend visual', 'host agent', 'skill', 'hygiene'],
  yLabel: 'SECONDS',
  xLabel: 'PACKAGE',
  series: [
    { name: 'THIS RUN', semantic: 'green' as const, values: [41.8, 3.3, 96.4, 6.1, 0.3, 0.4] },
    { name: 'PREVIOUS RUN', semantic: 'muted' as const, values: [44.0, 3.1, 102.9, 6.4, 0.3, 0.4] },
  ],
  marker: { x: 2, series: 'THIS RUN' },
};

// The `figure` scene's image: a 320x200 PNG test card (palette bars, a
// crosshair, a grey step ramp), 1251 bytes, generated once with Python's
// zlib and struct and embedded here so the fixture needs no file or network.
const FIGURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAEqklEQVR42u3cwU4TaxiAYWrihrgw0aSszZgY5QJqItuuWLDgArwT8RZYscM7oPcAJk1csTEuIOwILGXlxujEJrWZwrTTduj3zzxPujiak+kP9c33zTkjnZvrq40Yumf7QU5ysL0Z5CTnd8dLXmHQy/aGF0te5ORoN8g35HIY5CAbh/1+hGM82QCSJWAQMCBgQMAgYEDAgIABAUOzdDyJNS2tJ7EGvWyZt5jnOS1PYk3zJBaLy6Mdv+JcChPYBC6bwPc2Vj5CZz4LPc81TeCwE1jACQQ83dj8fz+h0l9meOiNBGyFZvH9djKn0aumt5u+vtU6OAEH9fntaf4qpPVo7154u86XH/nLhyJgqqVb98itNJBlLGBm1zv6h0/fd/JXkFP9+fgmf40z9jEJmLLBGyfdQsZGsYBJZvAaxQIm+cFrFAuYtAevUSxgyupN9EvQsIDVu5P0F6JhAbe03uTW5pnrtIYF3KJ6G/Z1aVjA6tUwAlavhgWMejUsYP7X2zYaFnCj6m3D+J0cwhoWcHO0p95CwwjYra+bYQTs1tfNsICxPFukBWx5tkgjYMuzRVrAWJ4t0gLG8myRFjAgYOPXEBYwIOCWjV/KGcICDs3+XL5FI2BAwDXsz8bvPEPYFi1gQMAgYOzPtmgBAwIGAQMCdgOM22ABAwIGAQMCBgQMAgYEDAgYEDA0X+fm+irIUbpn+0FOcrC9OflLP+lqjQo/hedyGOVgh/2+gNMIeKb6HqU8vzte8gqDXrY3vFjyIidHu6v/k/fvOcqqPyVLwFZocA8MCBgQMAgYEDAgYEDAIGBAwI01egbLE5fzW+wxLAQMAgYEDAjYbbAbYAEDAgYEbIu2PyNgEDBVGcLl4xcBh96iKWd/FjAg4NqGsC36of3Z+BUwIGBD2PgVMCU0PFkvAk5sCDPJ+BWwRdryjIAt0pZnAWORtjwL2CJteUbAFmnLs4CpdZFuT8Pjeo1fAbsZduuLgN0Mu/UVMBpWr4A1fKpeBKxh9QqY9TXcjIzzdNUr4DY23IBR7P8YCVjDp+pFwGk3nFbG47VZvQJue8PJjeLJdNUrYJIZxQavgEl1FBu8AibJUWzwCphFRvGgl41eazlJ4d0NXgGzSMbjlh453fEvpStgFrE3vMhfD43Eukfu9AEI9x8mbq6vghyle7Yf5CQH25tBTnJ+d1wI7N7Iy5uc+S/MvObJ0W6Qb8jlMEo5h/2+gAVcLeDy6lYy8O/9fQGHDdgKnfBqvZL9doWXwgQ2geeawJVua5cv0wQ2gQEBAwIGAQMCBgQMAgYEDDyKTpZlQY7y+vY2yEmevYjy8Xx99SHCMZ4//RbkG/Lu5+8gJ/n18r0JDAgYBAwIGBAwIGAQMCBgQMCAgEHAwFp1Vn7Fbrcb+YLBj7fyC25tbfl8Q11wtZ+ICQxWaEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgEHAgIABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAYOAAQEDAgYBAwn5C/I3UR6npYO2AAAAAElFTkSuQmCC';

// The switchboard itself, drawn the way an agent on a call would draw it,
// from the caller's page inward: twenty-two parts with their real names
// and long subs, labelled edges, the transfer and hand-back loop, the
// display frame and its confirmation coming back, skip edges from the
// deployment side, a fan-out to three project sessions and the fan-in from
// them to the skill module. The note is too long for a callout, so the
// node carries the NOTE marker. An agent lists the parts in the order it
// explains them; the layout breaks cycles from the first, so the call
// flows from the page.
export const topologyDiagram: DiagramData = {
  mode: 'graph', title: 'SYSTEM / SWITCHBOARD TOPOLOGY', subtitle: 'CALL PATH / DISPLAY PATH / DEPLOYMENT', context: 'SYSTEM MAP', caption: 'TOPOLOGY / 22 PARTS',
  nodes: [
    { id: 'browser', label: 'Browser page', sub: 'React stage / mic + playback', detail: 'apps/frontend/src' },
    { id: 'runtime', label: 'Call runtime', sub: 'clip outbox / epochs / transfers', detail: 'src/runtime/callRuntime.ts' },
    { id: 'ws', label: 'Browser WebSocket', sub: '/ws / clips in, frames out', detail: 'apps/backend/src/browser.rs' },
    { id: 'stt', label: 'STT sidecar', sub: 'local HTTP / webm in, text out' },
    { id: 'whisper', label: 'Whisper', sub: 'speech model in the sidecar' },
    { id: 'pbx', label: 'PBX', sub: 'Switchboard.handle() / the active leg', detail: 'apps/backend/src/pbx.rs', state: 'active', semantic: 'orange' },
    { id: 'operator', label: 'Operator agent', sub: 'pi --mode rpc / route tool only', semantic: 'orange' },
    { id: 'prewarm', label: 'Prewarm', sub: 'model catalogs / prepare reports', detail: 'apps/backend/src/prewarm.rs' },
    { id: 'announcer', label: 'Leg announcer', sub: 'one scene reset per leg', detail: 'apps/backend/src/leg_announcer.rs' },
    { id: 'host', label: 'Host agent', sub: 'dials /host / one per project host', semantic: 'cyan' },
    { id: 'wiki', label: 'llm-wiki agent', sub: 'prime-agent session in ~/projects/llm-wiki', state: 'active', semantic: 'green' },
    { id: 'board', label: 'switchboard agent', sub: 'prime-agent session in ~/projects/switchboard', state: 'blocked', semantic: 'green' },
    { id: 'lab', label: 'homelab agent', sub: 'prime-agent session in ~/projects/homelab', state: 'todo', semantic: 'green' },
    { id: 'skill', label: 'switchboard skill module', sub: 'speak / display / view / listen', detail: 'skills/switchboard', semantic: 'cyan' },
    { id: 'socket', label: 'Skill socket', sub: 'local socket / depth 0 sessions only', semantic: 'cyan' },
    { id: 'tts', label: 'ElevenLabs TTS', sub: 'reply text in, mp3 out', semantic: 'amber' },
    { id: 'gate', label: 'Display gate', sub: 'validate / stamp seq / confirm watermark', detail: 'apps/backend/src/display.rs' },
    { id: 'projection', label: 'Display projection', sub: 'objects, focus, replay snapshot', detail: 'DisplayProjection::apply' },
    { id: 'debug', label: 'Debug page', sub: 'debug listener / event feed', semantic: 'muted' },
    { id: 'role', label: 'homelab damocles role', sub: 'ansible / systemd units / secrets', state: 'done', semantic: 'muted' },
    { id: 'env', label: 'Environment file', sub: 'SWITCHBOARD_* / docs/environment.md', state: 'done', semantic: 'muted' },
    { id: 'registry', label: 'Project registry', sub: 'switchboard_projects / host + cwd', state: 'done', semantic: 'muted' },
  ],
  edges: [
    { from: 'browser', to: 'runtime', label: 'mic clips' },
    { from: 'runtime', to: 'ws', label: 'webm / opus' },
    { from: 'ws', to: 'stt', label: 'clip' },
    { from: 'stt', to: 'whisper', label: 'pcm' },
    { from: 'stt', to: 'pbx', label: 'transcript' },
    { from: 'pbx', to: 'operator', label: 'caller turn', semantic: 'orange' },
    { from: 'operator', to: 'pbx', label: 'route signal', semantic: 'orange' },
    { from: 'prewarm', to: 'pbx', label: 'launch plan' },
    { from: 'prewarm', to: 'host', label: 'list_models / run_prepare' },
    { from: 'pbx', to: 'host', label: 'create / prompt / steer', semantic: 'orange', active: true },
    { from: 'host', to: 'wiki', label: 'session', semantic: 'green', active: true },
    { from: 'host', to: 'board', label: 'session', semantic: 'green' },
    { from: 'host', to: 'lab', label: 'session', semantic: 'green' },
    { from: 'wiki', to: 'skill', label: 'speak / display', semantic: 'cyan' },
    { from: 'board', to: 'skill', semantic: 'cyan' },
    { from: 'lab', to: 'skill', semantic: 'cyan' },
    { from: 'skill', to: 'socket', label: 'one action per line', semantic: 'cyan' },
    { from: 'socket', to: 'host', label: 'module_call', semantic: 'cyan' },
    { from: 'host', to: 'tts', label: 'spoken line', semantic: 'amber' },
    { from: 'pbx', to: 'tts', label: 'operator reply', semantic: 'amber' },
    { from: 'tts', to: 'ws', label: 'mp3', semantic: 'amber' },
    { from: 'host', to: 'gate', label: 'display action' },
    { from: 'pbx', to: 'announcer', label: 'leg settled' },
    { from: 'announcer', to: 'gate', label: 'epoch / scene reset' },
    { from: 'gate', to: 'projection', label: 'validated action' },
    { from: 'projection', to: 'ws', label: 'display frame + seq' },
    { from: 'ws', to: 'browser', label: 'frames + audio' },
    { from: 'ws', to: 'gate', label: 'applied_seq confirm' },
    { from: 'gate', to: 'debug', label: 'debug feed', semantic: 'muted' },
    { from: 'pbx', to: 'debug', semantic: 'muted' },
    { from: 'role', to: 'env', label: 'writes', semantic: 'muted' },
    { from: 'role', to: 'registry', label: 'templates', semantic: 'muted' },
    { from: 'env', to: 'pbx', label: 'Config::from_env', semantic: 'muted' },
    { from: 'registry', to: 'prewarm', label: 'projects + hosts', semantic: 'muted' },
  ],
};

// A wide CI and release pipeline: forty steps in seven layers of up to ten,
// with edges that skip layers (a release tag straight to the release build,
// the lockfile to the checks that read it) and one roll-back loop. Drawn by
// an agent, this is where a layered drawing runs out of width first.
const pipelineNodes: Array<[string, string, string, DiagramNode['state']?, Semantic?]> = [
  ['push', 'push to master', 'branch protection', 'done'],
  ['pr', 'pull request', 'head must be up to date', 'done'],
  ['nightly', 'nightly cron', '02:00 / full matrix', 'done'],
  ['tag', 'release tag', 'v* / signed', 'todo'],
  ['lock', 'package-lock.json', 'npm ci reads it', 'done'],
  ['toolchain', 'rust-toolchain.toml', 'pinned toolchain', 'done'],
  ['checkout', 'checkout', 'full history for the sha', 'done'],
  ['rustup', 'rustup', 'clippy + rustfmt components', 'done'],
  ['node', 'node 22', 'npm ci', 'done'],
  ['cargo-cache', 'cargo cache', 'registry + target', 'done'],
  ['npm-cache', 'npm cache', '~/.npm', 'done'],
  ['python', 'python 3.12', 'stdlib only', 'done'],
  ['chromium', 'playwright chromium', 'pinned by the lockfile', 'done'],
  ['sha', 'stamp git sha', 'SWITCHBOARD_GIT_SHA', 'done'],
  ['fmt', 'cargo fmt', '--all -- --check', 'done', 'green'],
  ['clippy', 'cargo clippy', '-D warnings, all targets', 'done', 'green'],
  ['cargo-test', 'cargo test', '--locked / 439 tests', 'active', 'cyan'],
  ['typecheck', 'typecheck', 'tsc / app, node, host agent', 'done', 'green'],
  ['vitest', 'vitest unit', '560 tests / jsdom', 'done', 'green'],
  ['design-lock', 'design lock', 'verify-design-lock.mjs', 'done', 'green'],
  ['hygiene', 'hygiene sweep', 'check_hygiene.mjs', 'done', 'green'],
  ['skill-tests', 'skill tests', 'unittest discover', 'done', 'green'],
  ['host-tests', 'host agent tests', 'node --test', 'active', 'cyan'],
  ['no-ssh', 'no-ssh check', 'check_no_ssh.mjs', 'done', 'green'],
  ['static', 'vite build static/', 'committed bundle', 'active', 'cyan'],
  ['static-debug', 'vite build static-debug/', 'embedded debug page', 'todo'],
  ['release', 'cargo build --release', 'binary from git archive', 'todo'],
  ['visual', 'playwright visual', 'goldens / 4 geometries', 'blocked', 'red'],
  ['integration', 'playwright integration', 'fake mic + fixture socket', 'todo'],
  ['schema', 'schema parity', 'TS and Rust validators agree', 'todo'],
  ['static-diff', 'static diff', 'git diff --exit-code', 'todo'],
  ['binary', 'switchboard binary', 'stamped with the sha', 'todo'],
  ['goldens', 'golden report', 'diff images for review', 'todo'],
  ['checksums', 'checksums', 'sha256 per artifact', 'todo'],
  ['summary', 'CI summary', 'one line per gate', 'todo'],
  ['bundle', 'static bundle', 'static/ + static-debug/', 'todo'],
  ['pin', 'bump switchboard_version', 'homelab pins by commit', 'todo'],
  ['notify', 'notify Kayne', 'result + links', 'todo'],
  ['publish', 'publish artifacts', 'binary, bundle, checksums', 'todo'],
  ['homelab-pr', 'homelab pull request', 'deploys on merge', 'todo'],
];
const pipelineEdges: Array<[string, string, string?]> = [
  ['push', 'checkout'], ['pr', 'checkout', 'head sha'], ['nightly', 'checkout'], ['tag', 'checkout'],
  ['toolchain', 'rustup', 'pin'], ['toolchain', 'cargo-cache', 'cache key'], ['lock', 'node', 'npm ci'], ['lock', 'npm-cache', 'cache key'], ['lock', 'chromium'],
  ['push', 'sha'], ['pr', 'sha'], ['tag', 'sha'], ['pr', 'python'], ['nightly', 'python'],
  ['rustup', 'fmt'], ['rustup', 'clippy'], ['rustup', 'cargo-test'], ['cargo-cache', 'clippy'], ['cargo-cache', 'cargo-test'],
  ['node', 'typecheck'], ['node', 'vitest'], ['node', 'design-lock'], ['node', 'host-tests'], ['npm-cache', 'vitest'],
  ['checkout', 'hygiene'], ['checkout', 'no-ssh'], ['python', 'skill-tests'], ['toolchain', 'fmt', 'same rustfmt'],
  ['typecheck', 'static'], ['typecheck', 'static-debug'], ['vitest', 'static'], ['sha', 'release', 'build.rs stamp'], ['tag', 'release', 'release only'],
  ['cargo-test', 'release'], ['clippy', 'release'], ['chromium', 'visual'], ['chromium', 'integration'], ['vitest', 'schema'], ['cargo-test', 'schema'],
  ['static', 'static-diff', 'must match'], ['static-debug', 'static-diff'], ['release', 'binary'], ['release', 'checksums'], ['visual', 'goldens', 'on failure'],
  ['fmt', 'summary'], ['hygiene', 'summary'], ['skill-tests', 'summary'], ['host-tests', 'summary'], ['no-ssh', 'summary'], ['design-lock', 'summary'],
  ['integration', 'summary'], ['schema', 'summary'], ['static', 'bundle'], ['static-debug', 'bundle'],
  ['binary', 'pin', 'commit sha'], ['static-diff', 'pin'], ['summary', 'pin', 'all green'], ['summary', 'notify', 'red gates'], ['goldens', 'notify'],
  ['binary', 'publish'], ['bundle', 'publish'], ['checksums', 'publish'],
  ['pin', 'homelab-pr'], ['publish', 'homelab-pr', 'artifact links'], ['homelab-pr', 'notify', 'review'], ['nightly', 'notify', 'nightly digest'],
  ['homelab-pr', 'pin', 'roll back'],
];
export const pipelineDiagram: DiagramData = {
  mode: 'graph', title: 'CI / BUILD + RELEASE PIPELINE', subtitle: 'SWITCHBOARD / 40 STEPS / RUN 4182', context: 'PIPELINE', caption: 'PIPELINE / 40 STEPS',
  nodes: pipelineNodes.map(([id, label, sub, state, semantic]) => ({ id, label, sub, ...(state ? { state } : {}), ...(semantic ? { semantic } : {}) })),
  edges: pipelineEdges.map(([from, to, label]) => ({ from, to, ...(label ? { label } : {}) })),
};

// A whole transfer and the first display of the project agent's turn, as a
// sequence: eight actors, thirty-two messages of every kind, self-messages,
// one active. Long exchanges like this are what an agent sends when it
// explains a call path, and where a drawing scaled to fit stops being read.
export const traceDiagram: SequenceDiagramData = {
  mode: 'sequence', title: 'CALL / TRANSFER + FIRST DISPLAY', subtitle: 'CALLER -> LLM-WIKI / 32 MESSAGES', context: 'CALL TRACE', caption: 'TRACE / 8 ACTORS / 32 MESSAGES',
  actors: [
    { id: 'caller', label: 'CALLER', sub: 'browser page / mic', semantic: 'paper' },
    { id: 'ws', label: 'WEBSOCKET', sub: '/ws / browser.rs' },
    { id: 'stt', label: 'STT SIDECAR', sub: 'whisper', semantic: 'muted' },
    { id: 'pbx', label: 'PBX', sub: 'Switchboard.handle()', semantic: 'orange' },
    { id: 'operator', label: 'OPERATOR', sub: 'pi rpc / route only', semantic: 'orange' },
    { id: 'prewarm', label: 'PREWARM', sub: 'launch plans' },
    { id: 'host', label: 'HOST AGENT', sub: 'host link / skill socket', semantic: 'cyan' },
    { id: 'agent', label: 'PROJECT AGENT', sub: 'llm-wiki / prime-agent', semantic: 'green' },
  ],
  messages: [
    { from: 'caller', to: 'ws', label: 'clip (webm / opus)' },
    { from: 'ws', to: 'stt', label: 'transcribe' },
    { from: 'stt', to: 'ws', label: '"put me through to llm-wiki"', kind: 'return' },
    { from: 'ws', to: 'pbx', label: 'transcript', kind: 'async' },
    { from: 'pbx', to: 'pbx', label: 'classify (Jev)' },
    { from: 'pbx', to: 'operator', label: 'caller turn' },
    { from: 'operator', to: 'pbx', label: 'route(llm-wiki) signal', kind: 'async' },
    { from: 'pbx', to: 'prewarm', label: 'launch plan?' },
    { from: 'prewarm', to: 'pbx', label: 'host, cwd, model, prepare report', kind: 'return' },
    { from: 'pbx', to: 'host', label: 'create session' },
    { from: 'host', to: 'agent', label: 'start in ~/projects/llm-wiki', kind: 'async' },
    { from: 'agent', to: 'host', label: 'ready', kind: 'return' },
    { from: 'host', to: 'pbx', label: 'session state', kind: 'return' },
    { from: 'pbx', to: 'ws', label: 'epoch + leg: llm-wiki', kind: 'async' },
    { from: 'ws', to: 'caller', label: 'relabel the page', kind: 'async' },
    { from: 'pbx', to: 'host', label: 'intro prompt with the caller\'s words' },
    { from: 'host', to: 'agent', label: 'prompt' },
    { from: 'agent', to: 'agent', label: 'read git log' },
    { from: 'agent', to: 'host', label: 'speak("three commits since yesterday")', kind: 'async' },
    { from: 'host', to: 'pbx', label: 'module_call speak', kind: 'async' },
    { from: 'pbx', to: 'ws', label: 'mp3', kind: 'async' },
    { from: 'ws', to: 'caller', label: 'play', kind: 'async' },
    { from: 'agent', to: 'host', label: 'display(diagram)' },
    { from: 'host', to: 'pbx', label: 'module_call /display' },
    { from: 'pbx', to: 'pbx', label: 'validate + stamp seq 41' },
    { from: 'pbx', to: 'ws', label: 'display frame, seq 41', kind: 'async' },
    { from: 'ws', to: 'caller', label: 'render', kind: 'async' },
    { from: 'caller', to: 'ws', label: 'screen_state applied_seq 41' },
    { from: 'ws', to: 'pbx', label: 'confirm watermark', kind: 'async' },
    { from: 'pbx', to: 'host', label: 'rendered: true', kind: 'return', active: true },
    { from: 'host', to: 'agent', label: 'On screen.', kind: 'return' },
    { from: 'agent', to: 'host', label: 'turn settled', kind: 'return' },
  ],
};

// ---- Personal-assistant scenes ------------------------------------------------
//
// Kayne's week of 2026-10-05, the way an assistant agent on a call would
// show it: the calendar with standups, a dentist appointment, overlapping
// meetings, all-day days and an overnight flight; the to-do list with
// groups, overdue and done items; the kitchen timers and a reminder; the
// forecast; the inbox. "Today" and "now" are data (Wednesday 2026-10-07,
// 09:40), so these scenes draw the same on any day. A timer is the one
// thing measured against the page clock, so its instants are set from the
// moment this module loads: a preview counts down, and a test that pins
// the page clock pins them too.

const ASSISTANT_TODAY = '2026-10-07';
const ASSISTANT_NOW = '2026-10-07T09:40';

export const assistantWeek: CalendarData = {
  title: 'WEEK / OCT 5-11', subtitle: 'KAYNE / WORK + HOME', context: 'CALENDAR', caption: 'PACIFIC TIME',
  view: 'week', start: '2026-10-05', days: 7, today: ASSISTANT_TODAY, now: ASSISTANT_NOW,
  events: [
    { id: 'priya-leave', title: 'Priya on leave', start: '2026-10-01', end: '2026-10-06', semantic: 'muted' },
    { id: 'standup-mon', title: 'Standup', start: '2026-10-05T09:30', end: '2026-10-05T09:45', location: 'Meet' },
    { id: 'review-mon', title: 'Switchboard review', start: '2026-10-05T11:00', end: '2026-10-05T12:00', semantic: 'orange' },
    { id: 'gym-mon', title: 'Gym', start: '2026-10-05T18:00', end: '2026-10-05T19:00' },
    { id: 'standup-tue', title: 'Standup', start: '2026-10-06T09:30', end: '2026-10-06T09:45', location: 'Meet' },
    { id: 'lunch-ana', title: 'Lunch with Ana', start: '2026-10-06T12:30', end: '2026-10-06T13:30', location: 'Tartine, Guerrero St' },
    { id: 'homelab', title: 'Homelab maintenance window: Proxmox upgrade and the backup restore drill', start: '2026-10-06T20:00', end: '2026-10-06T22:00', status: 'tentative' },
    { id: 'ana-in-town', title: 'Ana in town', start: '2026-10-07', end: '2026-10-08', semantic: 'green' },
    { id: 'standup-wed', title: 'Standup', start: '2026-10-07T09:30', end: '2026-10-07T09:45', location: 'Meet', active: true },
    { id: 'dentist', title: 'Dentist', start: '2026-10-07T10:30', end: '2026-10-07T11:30', location: 'Dr. Okafor, 14 Pine St', detail: 'Cleaning and a check on the lower left molar', semantic: 'amber' },
    { id: 'design-review', title: 'Design review: visual palette', start: '2026-10-07T13:00', end: '2026-10-07T14:00' },
    { id: 'one-on-one', title: '1:1 with Priya', start: '2026-10-07T13:30', end: '2026-10-07T14:00', detail: 'Overlaps the design review; Priya can move it' },
    { id: 'dry-cleaning', title: 'Pick up dry cleaning', start: '2026-10-07T17:30' },
    { id: 'mom-birthday', title: "Mom's birthday", start: '2026-10-08', semantic: 'green' },
    { id: 'standup-thu', title: 'Standup', start: '2026-10-08T09:30', end: '2026-10-08T09:45', location: 'Meet' },
    { id: 'planning', title: 'Q4 planning', start: '2026-10-08T14:00', end: '2026-10-08T15:30', location: 'Room 4B' },
    { id: 'interview', title: 'Interview: staff engineer', start: '2026-10-08T14:00', end: '2026-10-08T15:00', status: 'tentative', semantic: 'cyan' },
    { id: 'landlord', title: 'Call the landlord', start: '2026-10-08T15:00', end: '2026-10-08T15:20' },
    { id: 'gym-thu', title: 'Gym', start: '2026-10-08T18:00', end: '2026-10-08T19:00', status: 'cancelled' },
    { id: 'standup-fri', title: 'Standup', start: '2026-10-09T09:30', end: '2026-10-09T09:45', location: 'Meet' },
    { id: 'flight', title: 'Flight UA 1532 SFO to JFK', start: '2026-10-09T18:05', end: '2026-10-10T02:40', location: 'SFO Terminal 3, gate F12', detail: 'Lands 05:40 New York time. Seat 14C.', semantic: 'cyan' },
    { id: 'brooklyn', title: 'Brooklyn trip', start: '2026-10-10', end: '2026-10-12', status: 'confirmed' },
    { id: 'wedding', title: "Sam and Lee's wedding", start: '2026-10-10T16:00', end: '2026-10-10T23:00', location: 'Brooklyn Botanic Garden' },
  ],
};

// Today, as an agenda: what the composed `today` scene leads with.
export const assistantAgenda: CalendarData = {
  title: 'TODAY / WED OCT 7', subtitle: 'AGENDA', context: 'CALENDAR', caption: 'PACIFIC TIME',
  view: 'agenda', start: ASSISTANT_TODAY, days: 1, today: ASSISTANT_TODAY, now: ASSISTANT_NOW,
  events: assistantWeek.events.filter((event) => event.start.startsWith(ASSISTANT_TODAY)),
};

// Today in a day view: the whole day with room for every line, an
// on-call shift run over from last night, a release freeze that runs on
// past midnight, a cancelled class, and three events in one hour.
export const assistantDay: CalendarData = {
  title: 'WED OCT 7 / DAY', subtitle: 'KAYNE / WORK + HOME', context: 'CALENDAR', caption: 'PACIFIC TIME',
  view: 'day', start: ASSISTANT_TODAY, today: ASSISTANT_TODAY, now: ASSISTANT_NOW,
  events: [
    { id: 'on-call', title: 'On call: switchboard pager', start: '2026-10-06T22:00', end: '2026-10-07T08:00', semantic: 'red', detail: 'Hand over to Priya at 08:00' },
    { id: 'yoga', title: 'Yoga', start: '2026-10-07T07:00', end: '2026-10-07T08:00', status: 'cancelled', location: 'Mission Yoga' },
    ...assistantWeek.events.filter((event) => event.start.startsWith(ASSISTANT_TODAY)),
    { id: 'focus', title: 'Focus block: write the round 4 report', start: '2026-10-07T13:00', end: '2026-10-07T15:00', status: 'tentative' },
    { id: 'coffee', title: 'Coffee with Sam', start: '2026-10-07T15:30', end: '2026-10-07T16:00', location: 'Ritual, Valencia St' },
    { id: 'freeze', title: 'Release freeze', start: '2026-10-07T22:00', end: '2026-10-08T06:00', semantic: 'orange', detail: 'No deploys until the 06:00 check' },
  ],
};

// October as a month: the week above in its row, a conference over three
// days, a visit that runs over a weekend into the next row, a busy
// Wednesday, and the days of September and November the rows reach.
export const assistantMonth: CalendarData = {
  title: 'OCTOBER 2026', subtitle: 'KAYNE / WORK + HOME', context: 'CALENDAR', caption: 'PACIFIC TIME',
  view: 'month', start: '2026-10-01', today: ASSISTANT_TODAY, now: ASSISTANT_NOW,
  events: [
    { id: 'rent', title: 'Rent due', start: '2026-10-01', semantic: 'amber' },
    { id: 'sept-retro', title: 'September retro', start: '2026-09-30T15:00', end: '2026-09-30T16:00' },
    ...assistantWeek.events,
    { id: 'standup-14', title: 'Standup', start: '2026-10-14T09:30', end: '2026-10-14T09:45' },
    { id: 'arch', title: 'Architecture review', start: '2026-10-14T10:00', end: '2026-10-14T11:00', semantic: 'orange' },
    { id: 'lunch-14', title: 'Team lunch', start: '2026-10-14T12:00', end: '2026-10-14T13:00' },
    { id: 'vendor', title: 'Vendor call: ElevenLabs', start: '2026-10-14T13:30', end: '2026-10-14T14:00' },
    { id: 'pairing', title: 'Pairing with Ana', start: '2026-10-14T14:00', end: '2026-10-14T16:00', status: 'tentative' },
    { id: 'haircut', title: 'Haircut', start: '2026-10-14T17:00', end: '2026-10-14T17:30' },
    { id: 'book-club', title: 'Book club', start: '2026-10-14T19:00', end: '2026-10-14T21:00', location: "Priya's place" },
    { id: 'strange-loop', title: 'Strange Loop', start: '2026-10-15', end: '2026-10-17', semantic: 'cyan', location: 'St. Louis' },
    { id: 'talk', title: 'My talk: one voice, many agents', start: '2026-10-16T11:00', end: '2026-10-16T11:45', semantic: 'orange' },
    { id: 'parents', title: 'Parents visiting', start: '2026-10-24', end: '2026-10-27', semantic: 'green' },
    { id: 'dinner-24', title: 'Dinner at Nopa', start: '2026-10-24T19:30', end: '2026-10-24T21:30' },
    { id: 'standup-21', title: 'Standup', start: '2026-10-21T09:30', end: '2026-10-21T09:45' },
    { id: 'dentist-follow', title: 'Dentist follow-up', start: '2026-10-28T08:30', end: '2026-10-28T09:00', semantic: 'amber', status: 'tentative' },
    { id: 'halloween', title: 'Halloween party', start: '2026-10-31T20:00', end: '2026-11-01T01:00' },
    { id: 'nov-planning', title: 'November planning', start: '2026-11-02T10:00', end: '2026-11-02T11:00' },
  ],
};

// The rest of the week as an agenda: each day's events in order, the
// flight past midnight, the trip over three days, and the two days with
// nothing on them as one line.
export const assistantAgendaWeek: CalendarData = {
  title: 'NEXT 7 DAYS', subtitle: 'AGENDA / FROM TODAY', context: 'CALENDAR', caption: 'PACIFIC TIME',
  view: 'agenda', start: ASSISTANT_TODAY, days: 7, today: ASSISTANT_TODAY, now: ASSISTANT_NOW,
  events: assistantWeek.events,
};

export const assistantTasks: TasksData = {
  title: 'TO DO / THIS WEEK', subtitle: '10 OPEN / 3 DONE', context: 'TASKS', caption: 'TODOIST / PERSONAL + WORK',
  today: ASSISTANT_TODAY,
  items: [
    { id: 'pr', text: 'Review the switchboard PR', state: 'active', due: '2026-10-07T17:00', priority: 'high', group: 'Work', tags: ['switchboard', 'review'] },
    { id: 'report', text: 'Write the round 4 report', due: '2026-10-08', group: 'Work' },
    { id: 'offsite', text: 'Reply to Priya about the offsite', state: 'done', group: 'Work' },
    { id: 'passport', text: 'Renew passport', due: '2026-10-02', priority: 'high', group: 'Errands', detail: 'Photos are in the desk drawer', tags: ['travel'] },
    { id: 'dry-cleaning', text: 'Pick up dry cleaning', due: '2026-10-07T17:30', group: 'Errands' },
    { id: 'gift', text: 'Buy a gift for Mom', state: 'done', due: '2026-10-06', group: 'Errands' },
    { id: 'pge', text: 'Pay the PG&E bill', due: '2026-10-05', priority: 'high', group: 'Home', tags: ['bills'] },
    { id: 'smoke', text: 'Replace the smoke detector battery', priority: 'low', group: 'Home' },
    { id: 'claim', text: 'Send the dental insurance claim for the cleaning and the x-ray, with the receipt from the front desk and the referral letter', due: '2026-10-12', group: 'Home', detail: 'Form 2B on the Delta portal, not the one on its first page', tags: ['health', 'bills'] },
    { id: 'plumber', text: 'Book the plumber', state: 'blocked', group: 'Home', detail: "Waiting on the landlord's OK" },
    { id: 'pack', text: 'Pack for New York', due: '2026-10-09', group: 'Trip', tags: ['travel'] },
    { id: 'check-in', text: 'Check in for UA 1532', due: '2026-10-08T18:05', group: 'Trip', tags: ['travel'] },
    { id: 'card', text: 'Print the wedding card', state: 'done', group: 'Trip' },
  ],
};

const FIXTURE_LOADED_AT = Math.floor(Date.now() / 1000) * 1000;

/** An instant `minutes` from when this module loaded, in the form a timer
 * takes, written on the caller's Pacific clock (-07:00) as the agent would. */
function minutesFromLoad(minutes: number): string {
  return new Date(FIXTURE_LOADED_AT + minutes * 60_000 - 7 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '-07:00');
}

// The hard cases of a kitchen: one counting with its bar, one paused, one
// done a minute ago, a reminder with no start, and one long label over an
// hour to go.
export const assistantTimers: TimerData = {
  title: 'KITCHEN / TIMERS', subtitle: '5 TIMERS / 1 PAUSED', context: 'TIMERS', caption: 'SET BY VOICE',
  timers: [
    { id: 'pasta', label: 'Pasta', startedAt: minutesFromLoad(-1.5), endsAt: minutesFromLoad(7.5) },
    { id: 'bread', label: 'Bread in the oven', startedAt: minutesFromLoad(-24), endsAt: minutesFromLoad(21), state: 'paused', remaining: 1260 },
    { id: 'tea', label: 'Tea', startedAt: minutesFromLoad(-5.25), endsAt: minutesFromLoad(-1.25) },
    { id: 'leave', label: 'Leave for the dentist', endsAt: minutesFromLoad(50) },
    { id: 'laundry', label: 'Move the laundry from the washer to the dryer downstairs', startedAt: minutesFromLoad(-10), endsAt: minutesFromLoad(75) },
  ],
};

// Two days by the hour and ten by the day, the most a phone's strip has to
// keep readable: fog burning off, rain overnight into Thursday, clearing
// for the flight on Friday evening.
const FORECAST_HOURS: Array<[number, WeatherCondition, number]> = [
  [61, 'fog', 10], [62, 'fog', 10], [64, 'partly-cloudy', 5], [66, 'partly-cloudy', 0], [67, 'clear', 0], [68, 'clear', 0],
  [68, 'clear', 0], [67, 'clear', 0], [65, 'partly-cloudy', 0], [63, 'partly-cloudy', 5], [61, 'cloudy', 10], [60, 'cloudy', 15],
  [59, 'cloudy', 20], [58, 'drizzle', 35], [57, 'drizzle', 40], [57, 'rain', 55], [56, 'rain', 60], [56, 'rain', 65],
  [55, 'rain', 70], [55, 'heavy-rain', 80], [55, 'heavy-rain', 85], [55, 'rain', 75], [56, 'rain', 60], [56, 'drizzle', 45],
  [57, 'rain', 55], [58, 'rain', 60], [59, 'thunder', 70], [60, 'heavy-rain', 80], [61, 'rain', 65], [61, 'rain', 50],
  [60, 'drizzle', 35], [59, 'cloudy', 20], [58, 'cloudy', 15], [57, 'cloudy', 10], [57, 'partly-cloudy', 5], [56, 'partly-cloudy', 5],
  [56, 'cloudy', 10], [55, 'cloudy', 10], [55, 'fog', 10], [54, 'fog', 10], [54, 'fog', 5], [54, 'fog', 5],
  [53, 'fog', 5], [53, 'fog', 5], [54, 'haze', 0], [55, 'haze', 0], [57, 'partly-cloudy', 0], [59, 'partly-cloudy', 0],
];

export const assistantWeather: WeatherData = {
  title: 'WEATHER / SAN FRANCISCO', subtitle: 'NOW + 48 H + 10 DAYS', context: 'FORECAST', caption: 'NWS / ISSUED 09:30',
  location: 'San Francisco, CA', units: 'F',
  current: { temp: 61, condition: 'fog', summary: 'Fog burning off by noon; rain moves in overnight and lasts through Thursday afternoon', high: 68, low: 54, feelsLike: 59, humidity: 84, precip: 10, wind: 'W 12 mph, gusts 25' },
  hourly: FORECAST_HOURS.map(([temp, condition, precip], hour) => ({
    time: `2026-10-${String(7 + Math.floor((10 + hour) / 24)).padStart(2, '0')}T${String((10 + hour) % 24).padStart(2, '0')}:00`,
    temp, condition, precip,
  })),
  daily: [
    { date: '2026-10-07', high: 68, low: 54, condition: 'partly-cloudy', precip: 20 },
    { date: '2026-10-08', high: 61, low: 55, condition: 'rain', precip: 80 },
    { date: '2026-10-09', high: 63, low: 53, condition: 'cloudy', precip: 30 },
    { date: '2026-10-10', high: 66, low: 52, condition: 'clear', precip: 0 },
    { date: '2026-10-11', high: 64, low: 53, condition: 'wind', precip: 5 },
    { date: '2026-10-12', high: 65, low: 52, condition: 'partly-cloudy', precip: 10 },
    { date: '2026-10-13', high: 63, low: 51, condition: 'drizzle', precip: 40 },
    { date: '2026-10-14', high: 60, low: 50, condition: 'thunder', precip: 60 },
    { date: '2026-10-15', high: 58, low: 49, condition: 'heavy-rain', precip: 90 },
    { date: '2026-10-16', high: 62, low: 50, condition: 'haze', precip: 0 },
  ],
  alert: 'Small craft advisory on the bay until 21:00',
};

export const assistantInbox: InboxData = {
  title: 'INBOX / UNREAD FIRST', subtitle: '5 UNREAD / 4 FLAGGED', context: 'MAIL + CHAT', caption: 'GMAIL / SLACK / SMS',
  today: ASSISTANT_TODAY,
  messages: [
    { id: 'dentist', from: "Dr. Okafor's office", subject: 'Appointment today', snippet: 'Reminder: today at 10:30. Reply C to confirm or call to reschedule.', time: '2026-10-07T08:12', channel: 'sms', unread: true, flagged: true, semantic: 'amber' },
    { id: 'united', from: 'United Airlines', subject: 'Check-in for UA 1532 opens tomorrow', snippet: 'SFO to JFK, Friday Oct 9, 18:05. Seat 14C.', time: '2026-10-07T07:55', channel: 'email', unread: true },
    { id: 'ci', from: 'GitHub', subject: '[switchboard] CI failed on visual-palette', snippet: 'test (ubuntu-latest) failed in 4m 12s', time: '2026-10-07T07:41', channel: 'email', unread: true, semantic: 'red' },
    { id: 'priya', from: 'Priya', snippet: 'offsite agenda draft is in the doc, can you look before Thursday?', time: '2026-10-06T21:14', channel: 'slack', unread: true },
    { id: 'mom', from: 'Mom', snippet: 'Are you still coming for dinner Thursday?', time: '2026-10-06T19:02', channel: 'sms', flagged: true },
    { id: 'pge', from: 'PG&E', subject: 'Your bill is past due', snippet: 'Pay $84.12 by Oct 12 to avoid a late fee.', time: '2026-10-05T06:00', channel: 'email', unread: true, flagged: true },
    { id: 'ana', from: 'Ana', snippet: 'lunch was great, same time next week?', time: '2026-10-06T14:20', channel: 'slack' },
    { id: 'homelab', from: 'damocles (homelab cron)', subject: 'Nightly backup report: 2 warnings, disk at 81% on the media pool', snippet: 'restic: 2 files changed during the snapshot; the media pool crossed its 80% threshold at 02:14.', time: '2026-10-07T02:30', channel: 'email' },
    { id: 'wedding', from: 'Sam and Lee', subject: 'Wedding weekend: shuttle times, the rehearsal dinner and parking at the garden', snippet: 'Shuttles leave the hotel at 15:15 and 15:45; there is no parking at the garden on weekends.', time: '2026-10-04', channel: 'email' },
    { id: 'linear', from: 'Linear', subject: 'Weekly digest: 14 issues moved to Done', time: '2026-10-02T08:00', channel: 'email' },
    { id: 'lease', from: 'Mission Bay Properties', subject: 'Lease renewal', snippet: 'Your lease ends Nov 30. Please let us know by Oct 15 whether you plan to renew.', time: '2026-09-28', channel: 'email', flagged: true },
  ],
};

// A note on the dentist event, by its id: the item the page marks.
const dentistNote: ControllerAction = {
  op: 'show', id: 'dentist-note', type: 'note', data: { tag: 'DAMOCLES / LEAVE BY 10:05', anchor: { target: 'week', item: 'dentist' }, segments: [
    { text: 'Traffic on 101 is slow this morning. ' },
    { text: 'Leave right after standup', accent: true, bold: true },
    { text: ' to make the 10:30 at Dr. Okafor.' },
  ] },
};

export const fixtures: Record<FixtureName, ControllerAction[]> = {
  idle: [],
  conversation: [
    {
      op: 'show', id: 'message', type: 'message', role: 'primary', data: {
        context: 'TRAINING DISCUSSION', tag: 'CURRENT RESPONSE / 01',
        segments: [
          { text: 'The divergence begins around ' },
          { text: 'epoch 32', accent: true },
          { text: '. Training loss keeps falling, but validation loss turns upward, so I would inspect the learning-rate transition and the first batches after it.' },
        ],
        channel: { name: 'VOICE', mode: 'HANDS-FREE' },
        transcript: [
          { speaker: 'YOU', text: 'How did the training run go?' },
          { speaker: 'DAMOCLES', text: 'The run is still healthy overall, but validation divergence begins around epoch 32.' },
          { speaker: 'YOU', text: 'What would you check first?' },
          { speaker: 'DAMOCLES', text: 'I would inspect the learning-rate transition and the first batches immediately after it. The training curve itself is still descending normally.' },
        ],
      },
    },
  ],
  training: [
    { op: 'show', id: 'loss', type: 'chart', role: 'primary', data: { ...trainingSeries, title: 'RUN / GRAPE-AMODAL-04', subtitle: 'TRAINING / LOSS TRACE / LIVE', context: 'TRAINING RUN', caption: 'PRIMARY / LOSS TRACE' } },
    { op: 'show', id: 'val-loss', type: 'metric', data: { label: 'VAL LOSS', value: '0.1832', semantic: 'orange' } },
    { op: 'show', id: 'train-loss', type: 'metric', data: { label: 'TRAIN LOSS', value: '0.1041', semantic: 'green' } },
    { op: 'show', id: 'learning-rate', type: 'metric', data: { label: 'LEARNING RATE', value: '1.2e-4' } },
    { op: 'show', id: 'gpu', type: 'metric', data: { label: 'GPU', value: '91%' } },
    { op: 'show', id: 'eta', type: 'metric', data: { label: 'ETA', value: '01:42:18' } },
    { op: 'show', id: 'progress', type: 'progress', data: { label: 'EPOCH 41 / 80', detail: 'ACTIVE / OPTIMIZER STEP 18442', value: 51.25, text: '51.25% COMPLETE' } },
    { op: 'show', id: 'training-note', type: 'note', data: { tag: 'OBSERVATION / EPOCH 32+', anchor: { target: 'loss', x: 32, series: 'VAL LOSS' }, segments: [
      { text: 'Validation loss turns upward here while training loss continues down. I would inspect the ' },
      { text: 'learning-rate transition', accent: true, bold: true },
      { text: ' and the first batches after it.' },
    ] } },
  ],
  architecture: [
    { op: 'show', id: 'system-map', type: 'diagram', role: 'primary', data: {
      title: 'SYSTEM / CONTROL TRANSFER', subtitle: 'SWITCHBOARD -> PROJECT SESSION / ROUTING TRACE', context: 'SYSTEM MAP',
      nodes: [
        { id: 'damocles', label: 'DAMOCLES', sub: 'FRONT DESK / OPERATOR', detail: 'CONTEXT / GENERAL', semantic: 'orange' },
        { id: 'session', label: 'PROJECT SESSION', sub: 'HEADLESS PI / SSH', detail: 'CONTEXT / SWITCHBOARD', semantic: 'paper' },
        { id: 'planner', label: 'PLANNER', sub: 'PLAN IR / GENERATE', semantic: 'green' },
        { id: 'implementer', label: 'IMPLEMENTER', sub: 'PATCH / EXECUTE', semantic: 'cyan' },
        { id: 'pool', label: 'SUBAGENT POOL', sub: 'DELEGATED EXECUTION / PARALLEL', semantic: 'paper' },
      ],
      edges: [
        { from: 'damocles', to: 'session', semantic: 'orange', active: true },
        { from: 'session', to: 'planner', semantic: 'orange', active: true },
        { from: 'session', to: 'implementer', semantic: 'orange' },
        { from: 'planner', to: 'pool', semantic: 'green' },
        { from: 'implementer', to: 'pool', semantic: 'cyan' },
      ],
    } },
    { op: 'show', id: 'architecture-note', type: 'note', data: { tag: 'CURRENT EXPLANATION / 01', anchor: { target: 'system-map', node: 'session' }, segments: [
      { text: 'The voice does not change. ' },
      { text: 'Context moves.', accent: true, bold: true },
      { text: ' Damocles routes the session into the project directory, then the project orchestrator delegates work without exposing those internal handoffs to you.' },
    ] } },
  ],
  email: [
    { op: 'show', id: 'mail', type: 'document', role: 'primary', data: {
      kind: 'email', context: 'MAIL', source: 'MAIL / INBOX', from: 'PROF. ARDEN', timestamp: '23 AUG 2026 / 01:14',
      subject: 'Re: revised segmentation results and September submission',
      paragraphs: [
        'Kayne,',
        'I reviewed the new figures. The hidden-region results are much easier to follow now, and I agree that the residual correction should stay framed as a lightweight final-stage adjustment rather than a second model.',
        'Please send me the updated draft once you have the new seed runs in place. I would also tighten the related-work paragraph before submission.',
        'Best,\nArden',
      ],
    } },
    { op: 'show', id: 'email-note', type: 'note', data: { tag: 'DAMOCLES / SUMMARY', segments: [
      { text: 'No action is required immediately. The only concrete request is to send the updated draft after the additional seed runs and tighten related work before submission.' },
    ] } },
  ],
  handoff: [
    { op: 'show', id: 'handoff', type: 'diagram', role: 'primary', data: {
      mode: 'sequence', title: 'CALL / HANDOFF', subtitle: 'OPERATOR -> PROJECT AGENT / TRANSFER', context: 'CALL TRACE',
      actors: [
        { id: 'caller', label: 'CALLER', sub: 'BROWSER / VOICE', semantic: 'paper' },
        { id: 'operator', label: 'OPERATOR', sub: 'DAMOCLES / FRONT DESK', semantic: 'orange' },
        { id: 'pbx', label: 'PBX', sub: 'SWITCHBOARD / ROUTING', semantic: 'cyan' },
        { id: 'agent', label: 'PROJECT AGENT', sub: 'HEADLESS PI / SSH', semantic: 'green' },
      ],
      messages: [
        { from: 'caller', to: 'operator', label: 'put me through to llm-wiki' },
        { from: 'operator', to: 'pbx', label: 'route(llm-wiki)' },
        { from: 'pbx', to: 'agent', label: 'launch session', kind: 'async' },
        { from: 'agent', to: 'agent', label: 'load context' },
        { from: 'agent', to: 'pbx', label: 'ready', kind: 'return' },
        { from: 'pbx', to: 'caller', label: 'line transferred', active: true },
        { from: 'caller', to: 'agent', label: 'what changed since yesterday?' },
        { from: 'agent', to: 'caller', label: 'three commits, one open PR', kind: 'return' },
      ],
    } },
    { op: 'show', id: 'handoff-note', type: 'note', data: { tag: 'CURRENT EXPLANATION / 01', anchor: { target: 'handoff', node: 'pbx' }, segments: [
      { text: 'The operator never leaves the line. ' },
      { text: 'The PBX moves the caller.', accent: true, bold: true },
      { text: ' Once the project agent reports ready, the caller speaks to it directly.' },
    ] } },
  ],
  code: [
    { op: 'show', id: 'source', type: 'code', role: 'primary', data: {
      title: 'SOURCE / ROUTER', file: 'apps/backend/src/session/router.ts / L41-57', context: 'CODE REVIEW',
      source: { language: 'typescript', highlight: [5,6,7,8,9,10,11], text: `export async function routeSession(request: RouteRequest) {
  const project = await resolveProject(request.project);
  const target = project.session ?? await createSession(project);

  if (request.mode === "coding") {
    await handoffContext({
      source: request.context,
      destination: target,
      preserveVoice: true,
    });
  }

  return attachTransport(target, {
    ssh: project.host,
    cwd: project.path,
  });
}` },
    } },
    { op: 'show', id: 'code-note', type: 'note', data: { tag: 'DAMOCLES / L45-51', segments: [
      { text: 'This is the actual handoff boundary. ' },
      { text: 'The executor changes; the voice does not.', accent: true, bold: true },
      { text: ' The rest of the function is transport plumbing.' },
    ] } },
  ],
  results: [
    { op: 'show', id: 'test-matrix', type: 'table', role: 'primary', data: {
      title: 'TESTS / MATRIX', subtitle: 'CI RUN 4182 / MASTER', context: 'TEST RESULTS', caption: 'RESULTS / 5 SUITES',
      columns: [
        { label: 'SUITE' },
        { label: 'PASSED', semantic: 'green' },
        { label: 'FAILED', semantic: 'red' },
        { label: 'SKIPPED', semantic: 'muted' },
        { label: 'DURATION' },
      ],
      rows: [
        ['backend / unit', 442, 0, 3, '38.4s'],
        ['backend / pbx', 61, 0, 0, '12.1s'],
        ['frontend / unit', 318, { text: '2', semantic: 'red', bold: true }, 0, '9.7s'],
        ['frontend / visual', 24, 0, { text: '6', semantic: 'muted' }, '1m 48s'],
        ['skill', 25, 0, 0, '0.1s'],
      ],
      highlight: [2],
    } },
    { op: 'show', id: 'results-note', type: 'note', data: { tag: 'DAMOCLES / FAILURES', segments: [
      { text: 'Two frontend unit failures, both in ' },
      { text: 'notePlacement.test.ts', accent: true, bold: true },
      { text: ': the leader now clears the trace by two more pixels than the test expects. Nothing else moved.' },
    ] } },
  ],
  comparison: [
    { op: 'show', id: 'durations', type: 'chart', role: 'primary', data: { ...suiteDurations, title: 'CI / TEST SUITE DURATIONS', subtitle: 'WALL TIME BY PACKAGE / THIS RUN vs PREVIOUS', context: 'CI RUN', caption: 'PRIMARY / SUITE DURATIONS' } },
    { op: 'show', id: 'total', type: 'metric', data: { label: 'TOTAL', value: '148.3 s', semantic: 'green' } },
    { op: 'show', id: 'delta', type: 'metric', data: { label: 'VS PREVIOUS', value: '-8.8 s' } },
    { op: 'show', id: 'slowest', type: 'metric', data: { label: 'SLOWEST', value: 'frontend visual', semantic: 'orange' } },
    { op: 'show', id: 'durations-note', type: 'note', data: { tag: 'OBSERVATION / VISUAL SUITE', anchor: { target: 'durations', x: 2, series: 'THIS RUN' }, segments: [
      { text: 'The visual suite is two thirds of the run. ' },
      { text: 'Six seconds faster than last time', accent: true, bold: true },
      { text: ', since the goldens are now compared without a rebuild.' },
    ] } },
  ],
  // An image primary: the page builds the img source from format and bytes,
  // and the note sits in the rail beside it.
  figure: [
    { op: 'show', id: 'test-card', type: 'image', role: 'primary', data: {
      format: 'png', bytes: FIGURE_PNG_BASE64,
      alt: 'Test card: seven palette bars under a crosshair, over a grey step ramp',
      title: 'FIGURE / TEST CARD', subtitle: 'IMAGE / PNG / INLINE', context: 'FIGURE',
    } },
    { op: 'show', id: 'figure-note', type: 'note', data: { tag: 'DAMOCLES / FIGURE', segments: [
      { text: 'The page draws the picture from the bytes the agent sent; ' },
      { text: 'no URL is ever fetched.', accent: true, bold: true },
      { text: ' It keeps the whole figure in view and reads its size on decode.' },
    ] } },
  ],
  // An agent's plan beside the work it is about: the merge path is the
  // primary (each slice into the integration branch, then the rebuild and
  // the pin), and the plan is a module in the rail, read the same way as the
  // measures the work moves above it; the note says what holds the plan up.
  // The whole plan is a focus away. The bar is the share of steps done, 4 of 7.
  plan: [
    { op: 'show', id: 'merge-path', type: 'diagram', role: 'primary', data: {
      mode: 'graph', title: 'VISUAL-PALETTE / MERGE PATH', subtitle: 'SLICES -> INTEGRATION -> RELEASE', context: 'SHIP PLAN', caption: 'PLAN / 7 STEPS',
      nodes: [
        { id: 'chart-kinds', label: 'CHART KINDS', sub: 'vp/chart-kinds', state: 'done' },
        { id: 'table-type', label: 'TABLE TYPE', sub: 'vp/table-type', state: 'done' },
        { id: 'sequence', label: 'SEQUENCE DIAGRAMS', sub: 'vp/sequence-diagram', state: 'done' },
        { id: 'small-primitives', label: 'STEPS + TRENDS', sub: 'vp/small-primitives', state: 'done' },
        { id: 'diagram-layout', label: 'GRAPH LAYOUT', sub: 'vp/diagram-layout', semantic: 'orange', state: 'active' },
        { id: 'integration', label: 'VISUAL-PALETTE', sub: 'INTEGRATION BRANCH', semantic: 'cyan' },
        { id: 'static', label: 'REBUILD static/', sub: 'ONE BUILD, ALL SLICES', state: 'blocked' },
        { id: 'pin', label: 'HOMELAB PIN', sub: 'switchboard_version', state: 'todo' },
      ],
      edges: [
        { from: 'chart-kinds', to: 'integration' },
        { from: 'table-type', to: 'integration' },
        { from: 'sequence', to: 'integration' },
        { from: 'small-primitives', to: 'integration' },
        { from: 'diagram-layout', to: 'integration', label: 'in review', semantic: 'orange', active: true },
        { from: 'integration', to: 'static' },
        { from: 'static', to: 'pin' },
      ],
    } },
    { op: 'show', id: 'ship-plan', type: 'progress', role: 'secondary', data: {
      label: 'VISUAL-PALETTE', detail: 'SHIP PLAN / 4 OF 7 STEPS DONE', value: 57.14,
      steps: [
        { label: 'CHART KINDS + LABELS', state: 'done', detail: 'LINE / BAR / AREA / SCATTER' },
        { label: 'TABLE TYPE', state: 'done', detail: 'MERGED / AUDITED' },
        { label: 'SEQUENCE DIAGRAMS', state: 'done', detail: 'DIAGRAM MODE "sequence"' },
        { label: 'PROGRESS STEPS + METRIC TREND', state: 'done', detail: 'MERGED / AUDITED' },
        { label: 'GRAPH LAYOUT REWRITE', state: 'active', detail: 'CYCLES / LONG EDGES / IN REVIEW' },
        { label: 'REBUILD static/', state: 'blocked', detail: 'WAITS ON THE LAYOUT MERGE' },
        { label: 'BUMP THE HOMELAB PIN', detail: 'switchboard_version' },
      ],
    } },
    { op: 'show', id: 'tests-passing', type: 'metric', data: { label: 'TESTS PASSING', value: '418', semantic: 'green', trend: 'up', delta: '+31' } },
    { op: 'show', id: 'build-time', type: 'metric', data: { label: 'BUILD TIME', value: '38.4 s', semantic: 'cyan', trend: 'down', delta: '-2.1 s' } },
    { op: 'show', id: 'plan-note', type: 'note', data: { tag: 'DAMOCLES / PLAN', anchor: { target: 'ship-plan' }, segments: [
      { text: 'The static rebuild ' },
      { text: 'waits on the graph layout', accent: true, bold: true },
      { text: '.' },
    ] } },
  ],

  // A visual primary with visuals beside it: the diagram keeps the main
  // slot, the table and the figure share the aux row under it, and the
  // note and the metrics sit in the rail.
  composed: [
    { op: 'show', id: 'call-route', type: 'diagram', role: 'primary', data: {
      mode: 'graph', title: 'CALL / ROUTE', subtitle: 'CALLER -> PROJECT AGENT / LEGS', context: 'CALL TRACE',
      nodes: [
        { id: 'caller', label: 'CALLER', sub: 'BROWSER / VOICE', state: 'done' },
        { id: 'operator', label: 'OPERATOR', sub: 'DAMOCLES / FRONT DESK', semantic: 'orange', state: 'done' },
        { id: 'pbx', label: 'PBX', sub: 'SWITCHBOARD / ROUTING', semantic: 'cyan', state: 'active' },
        { id: 'agent', label: 'PROJECT AGENT', sub: 'HEADLESS PI / SSH', semantic: 'green', state: 'todo' },
      ],
      edges: [
        { from: 'caller', to: 'operator', label: 'voice', semantic: 'orange' },
        { from: 'operator', to: 'pbx', label: 'route', semantic: 'orange' },
        { from: 'pbx', to: 'agent', label: 'launch', semantic: 'cyan', active: true },
      ],
    } },
    { op: 'show', id: 'leg-latency', type: 'table', role: 'secondary', data: {
      title: 'LEGS / LATENCY', caption: 'LEGS / LAST 20 CALLS',
      columns: [{ label: 'LEG' }, { label: 'P50' }, { label: 'P95' }, { label: 'STATE' }],
      rows: [
        ['caller -> operator', '120 ms', '180 ms', { text: 'OK', semantic: 'green' }],
        ['operator -> pbx', '40 ms', '65 ms', { text: 'OK', semantic: 'green' }],
        ['pbx -> agent', '0.9 s', { text: '2.1 s', semantic: 'amber', bold: true }, { text: 'SLOW', semantic: 'amber' }],
      ],
      highlight: [2],
    } },
    { op: 'show', id: 'route-figure', type: 'image', role: 'secondary', data: {
      format: 'png', bytes: FIGURE_PNG_BASE64,
      alt: 'Test card: seven palette bars under a crosshair, over a grey step ramp',
      title: 'FIGURE / TEST CARD',
    } },
    { op: 'show', id: 'live-calls', type: 'metric', data: { label: 'CALLS / LIVE', value: '3' } },
    { op: 'show', id: 'handoff-p95', type: 'metric', data: { label: 'HANDOFF P95', value: '2.1 s', semantic: 'amber', trend: 'up', delta: '+0.4 s' } },
    { op: 'show', id: 'route-note', type: 'note', data: { tag: 'OBSERVATION / PBX LEG', anchor: { target: 'call-route', node: 'pbx' }, segments: [
      { text: 'The slow leg is the launch. ' },
      { text: 'The PBX waits on the project session', accent: true, bold: true },
      { text: ' before it transfers the caller; the other legs are well under a quarter second.' },
    ] } },
  ],
  // The hard canonical diagrams: what agents really send, where drawings
  // break down (docs/visual-channel.md, "Diagrams that outgrow the frame").
  topology: [
    { op: 'show', id: 'topology', type: 'diagram', role: 'primary', data: topologyDiagram },
    { op: 'show', id: 'topology-note', type: 'note', data: { tag: 'DAMOCLES / DISPLAY PATH', anchor: { target: 'topology', node: 'gate' }, segments: [
      { text: 'A display counts as shown only when the page confirms it. ' },
      { text: 'The gate stamps each action with a seq', accent: true, bold: true },
      { text: ', the projection sends the frame, and the applied_seq coming back through the WebSocket moves the watermark the agent waits on.' },
    ] } },
  ],
  pipeline: [
    { op: 'show', id: 'pipeline', type: 'diagram', role: 'primary', data: pipelineDiagram },
    { op: 'show', id: 'pipeline-note', type: 'note', data: { tag: 'DAMOCLES / BLOCKED', anchor: { target: 'pipeline', node: 'visual' }, segments: [
      { text: 'The goldens differ on the new layout; they wait on approval.' },
    ] } },
  ],
  trace: [
    { op: 'show', id: 'trace', type: 'diagram', role: 'primary', data: traceDiagram },
    { op: 'show', id: 'trace-note', type: 'note', data: { tag: 'DAMOCLES / CONFIRMATION', anchor: { target: 'trace', node: 'pbx' }, segments: [
      { text: 'The PBX moves the caller, then ' },
      { text: 'waits for the page to confirm', accent: true, bold: true },
      { text: ' what it drew before the agent hears "On screen."' },
    ] } },
  ],
  // The personal-assistant types, one scene each (docs/display-tool.md,
  // "Personal-assistant types"), then the day they compose.
  calendar: [
    { op: 'show', id: 'week', type: 'calendar', role: 'primary', data: assistantWeek },
    dentistNote,
  ],
  // The other three views of the same calendar, each with the note on the
  // dentist appointment.
  'calendar-day': [
    { op: 'show', id: 'week', type: 'calendar', role: 'primary', data: assistantDay },
    dentistNote,
  ],
  'calendar-month': [
    { op: 'show', id: 'week', type: 'calendar', role: 'primary', data: assistantMonth },
    dentistNote,
  ],
  'calendar-agenda': [
    { op: 'show', id: 'week', type: 'calendar', role: 'primary', data: assistantAgendaWeek },
    dentistNote,
  ],
  tasks: [{ op: 'show', id: 'todo', type: 'tasks', role: 'primary', data: assistantTasks }],
  timer: [{ op: 'show', id: 'kitchen', type: 'timer', role: 'primary', data: assistantTimers }],
  // A note on one day of the forecast, by its date: the day the page marks.
  weather: [
    { op: 'show', id: 'weather', type: 'weather', role: 'primary', data: assistantWeather },
    { op: 'show', id: 'umbrella-note', type: 'note', data: { tag: 'DAMOCLES / UMBRELLA', anchor: { target: 'weather', item: '2026-10-08' }, segments: [
      { text: 'Rain all of Thursday, heaviest before dawn. ' },
      { text: 'Take the umbrella to Q4 planning', accent: true, bold: true },
      { text: '; Friday clears in time for the flight.' },
    ] } },
  ],
  inbox: [{ op: 'show', id: 'inbox', type: 'inbox', role: 'primary', data: assistantInbox }],
  // The morning briefing: today's agenda leads, and the forecast, the
  // to-do list and the inbox stand beside it; the note names the dentist
  // appointment in the agenda.
  today: [
    { op: 'show', id: 'week', type: 'calendar', role: 'primary', data: assistantAgenda },
    { op: 'show', id: 'weather', type: 'weather', role: 'secondary', data: assistantWeather },
    { op: 'show', id: 'todo', type: 'tasks', role: 'secondary', data: assistantTasks },
    { op: 'show', id: 'inbox', type: 'inbox', role: 'secondary', data: assistantInbox },
    dentistNote,
  ],
};

export const previousRunAction: ControllerAction = {
  op: 'show', id: 'previous-run', type: 'chart', role: 'compare', data: {
    ...trainingSeries, title: 'RUN / GRAPE-AMODAL-03', subtitle: 'COMPARISON / PREVIOUS', context: 'TRAINING RUN', compareLabel: 'PREVIOUS', marker: undefined,
    series: [{ name: 'VAL LOSS', semantic: 'cyan', values: [0.292,0.278,0.263,0.249,0.237,0.226,0.216,0.207,0.199,0.192,0.186,0.181,0.177,0.174,0.172,0.171,0.172,0.174,0.177,0.181,0.186,0.192,0.199,0.207,0.216,0.224] }],
  },
};
