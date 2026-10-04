import type { ControllerAction, FixtureName } from '../controller/types';

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
};

export const previousRunAction: ControllerAction = {
  op: 'show', id: 'previous-run', type: 'chart', role: 'compare', data: {
    ...trainingSeries, title: 'RUN / GRAPE-AMODAL-03', subtitle: 'COMPARISON / PREVIOUS', context: 'TRAINING RUN', compareLabel: 'PREVIOUS', marker: undefined,
    series: [{ name: 'VAL LOSS', semantic: 'cyan', values: [0.292,0.278,0.263,0.249,0.237,0.226,0.216,0.207,0.199,0.192,0.186,0.181,0.177,0.174,0.172,0.171,0.172,0.174,0.177,0.181,0.186,0.192,0.199,0.207,0.216,0.224] }],
  },
};
