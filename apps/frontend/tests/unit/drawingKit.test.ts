// The drawing kit's rules, which a graph and a sequence share.
import { describe, expect, it } from 'vitest';
import { drawingOrientation } from '../../src/primitives/drawingKit';
import { nodeFramePath } from '../../src/primitives/diagramLayout';
import { actorFramePath } from '../../src/primitives/sequenceLayout';

describe('drawing kit', () => {
  it('cuts a node and an actor header from one outline, each by its own corners', () => {
    expect(nodeFramePath(160, 60)).toBe('M 0 14 L 14 0 H 138 L 160 22 V 60 H 18 L 0 42 Z');
    expect(actorFramePath(120, 40, 'full')).toBe('M 0 10 L 10 0 H 106 L 120 14 V 40 H 12 L 0 28 Z');
    expect(actorFramePath(120, 26, 'compact')).toBe('M 0 6 L 6 0 H 112 L 120 8 V 26 H 7 L 0 19 Z');
  });

  it('composes a drawing in portrait only once its viewport is a little taller than wide', () => {
    expect(drawingOrientation({ width: 1000, height: 1050 })).toBe('landscape');
    expect(drawingOrientation({ width: 1000, height: 1051 })).toBe('portrait');
  });
});
