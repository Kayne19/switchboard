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
    { op: 'show', id: 'loss', type: 'chart', role: 'primary', data: { ...trainingSeries, title: 'RUN / GRAPE-AMODAL-04', subtitle: 'TRAINING / LOSS TRACE / LIVE', context: 'TRAINING RUN' } },
    { op: 'show', id: 'val-loss', type: 'metric', data: { label: 'VAL LOSS', value: '0.1832', semantic: 'orange' } },
    { op: 'show', id: 'train-loss', type: 'metric', data: { label: 'TRAIN LOSS', value: '0.1041', semantic: 'green' } },
    { op: 'show', id: 'learning-rate', type: 'metric', data: { label: 'LEARNING RATE', value: '1.2e-4' } },
    { op: 'show', id: 'gpu', type: 'metric', data: { label: 'GPU', value: '91%' } },
    { op: 'show', id: 'eta', type: 'metric', data: { label: 'ETA', value: '01:42:18' } },
    { op: 'show', id: 'progress', type: 'progress', data: { label: 'EPOCH 41 / 80', detail: 'ACTIVE / OPTIMIZER STEP 18442', value: 0.5125, text: '51.25% COMPLETE' } },
    { op: 'show', id: 'training-note', type: 'note', data: { tag: 'OBSERVATION / EPOCH 32+', segments: [
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
    { op: 'show', id: 'architecture-note', type: 'note', data: { tag: 'CURRENT EXPLANATION / 01', segments: [
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
};

export const previousRunAction: ControllerAction = {
  op: 'show', id: 'previous-run', type: 'chart', role: 'compare', data: {
    ...trainingSeries, title: 'RUN / GRAPE-AMODAL-03', subtitle: 'COMPARISON / PREVIOUS', context: 'TRAINING RUN', compareLabel: 'PREVIOUS', marker: undefined,
    series: [{ name: 'VAL LOSS', semantic: 'cyan', values: [0.292,0.278,0.263,0.249,0.237,0.226,0.216,0.207,0.199,0.192,0.186,0.181,0.177,0.174,0.172,0.171,0.172,0.174,0.177,0.181,0.186,0.192,0.199,0.207,0.216,0.224] }],
  },
};

export const composedFixture: ControllerAction[] = [
    { op: 'show', id: 'composed-diagram', type: 'diagram', role: 'primary', data: {
      title: 'COMPOSED / SYSTEM FLOW', nodes: [
        { id: 'input', label: 'INPUT', state: 'done', semantic: 'green' },
        { id: 'active', label: 'ACTIVE NODE', state: 'active', semantic: 'cyan' },
        { id: 'output', label: 'OUTPUT', state: 'todo', semantic: 'paper' },
      ], edges: [
        { from: 'input', to: 'active', label: 'route', semantic: 'cyan' },
        { from: 'active', to: 'output', label: 'emit', semantic: 'cyan' },
      ],
    } },
    { op: 'show', id: 'composed-note', type: 'note', role: 'secondary', data: {
      tag: 'COMPOSED / NOTE', segments: [{ text: 'The active path is highlighted from the single active node.' }],
    } },
    { op: 'show', id: 'composed-metric', type: 'metric', role: 'ambient', data: { label: 'THROUGHPUT', value: '98.4%', semantic: 'green' } },
  ];
