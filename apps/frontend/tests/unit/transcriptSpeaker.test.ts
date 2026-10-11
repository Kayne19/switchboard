// The history names which agent spoke, so a line from a background or
// foreground project agent is not mistaken for the operator.
import { describe, expect, it } from 'vitest';
import { transcriptSpeaker } from '../../src/components/TranscriptDrawer';

describe('transcriptSpeaker', () => {
  it('labels a project agent line with that agent', () => {
    expect(transcriptSpeaker({ key: 0, speaker: 'DAMOCLES', text: 'ready', agent: 'grape-segmentation' })).toBe('GRAPE-SEGMENTATION');
  });

  it('keeps the switchboard name for the operator and unlabelled lines', () => {
    expect(transcriptSpeaker({ key: 0, speaker: 'DAMOCLES', text: 'hi', agent: 'operator' })).toBe('DAMOCLES');
    expect(transcriptSpeaker({ key: 0, speaker: 'DAMOCLES', text: 'hi' })).toBe('DAMOCLES');
  });

  it('keeps the caller label', () => {
    expect(transcriptSpeaker({ key: 0, speaker: 'CALLER', text: 'pull it up', agent: 'switchboard' })).toBe('CALLER');
  });
});
