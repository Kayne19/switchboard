import { describe, expect, it } from 'vitest';
import type { SequenceDiagramData, SequenceMessage } from '../../src/controller/types';
import { layoutSequence, type Box, type SequenceOrientation } from '../../src/primitives/sequenceLayout';

const sequence = (actors: string[], messages: Array<[string, string, string, SequenceMessage['kind']?]>): SequenceDiagramData => ({
  mode: 'sequence',
  actors: actors.map((id) => ({ id, label: id.toUpperCase() })),
  messages: messages.map(([from, to, label, kind]) => ({ from, to, label, ...(kind ? { kind } : {}) })),
});

const sequences: Record<string, SequenceDiagramData> = {
  // A call transfer: a return, an async launch, and a self-message.
  handoff: sequence(['caller', 'operator', 'pbx', 'agent'], [
    ['caller', 'operator', 'put me through'],
    ['operator', 'pbx', 'route(llm-wiki)'],
    ['pbx', 'agent', 'launch session', 'async'],
    ['agent', 'agent', 'load context'],
    ['agent', 'pbx', 'ready', 'return'],
    ['pbx', 'caller', 'line transferred'],
    ['caller', 'agent', 'what changed since yesterday?'],
    ['agent', 'caller', 'three commits, one open PR', 'return'],
  ]),
  // Labels far wider than the approved column pitch, between neighbours; the
  // unbroken ones cannot wrap, so the columns have to move.
  wordy: sequence(['a', 'b', 'c'], [
    ['a', 'b', 'a label much longer than the gap between two neighbouring lifelines'],
    ['b', 'c', 'another-label-that-would-run-under-a-lifeline-if-nothing-moved'],
    ['c', 'a', 'and one that spans both gaps and still has to fit between its ends, wrapped or not'],
  ]),
  // A self-message on the last actor, whose label has nowhere to go but out.
  tail: sequence(['left', 'right'], [
    ['left', 'right', 'ask'],
    ['right', 'right', 'think about it for a while before answering'],
    ['right', 'left', 'answer', 'return'],
  ]),
  lone: sequence(['one'], [['one', 'one', 'tick']]),
  silent: sequence(['x', 'y'], []),
};

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const orientation of ['landscape', 'portrait'] as SequenceOrientation[]) {
  describe(`sequence layout / ${orientation}`, () => {
    for (const [name, data] of Object.entries(sequences)) {
      const layout = layoutSequence(data, orientation);
      const lifelineBox = (x: number, top: number, bottom: number): Box => ({ x, y: top, width: 0.001, height: bottom - top });

      it(`${name}: actors stand in order across the top, each in a header its label fits`, () => {
        expect(layout.actors.map((a) => a.actor.id)).toEqual(data.actors.map((a) => a.id));
        layout.actors.forEach((laidOut, index) => {
          expect(laidOut.box.width).toBeGreaterThanOrEqual(laidOut.actor.label.length * layout.actorLabelSize * 0.7);
          expect(laidOut.x).toBe(laidOut.box.x + laidOut.box.width / 2);
          if (index > 0) {
            const previous = layout.actors[index - 1];
            expect(laidOut.box.x).toBeGreaterThan(previous.box.x + previous.box.width);
          }
          expect(laidOut.box.y).toBe(layout.actors[0].box.y);
        });
      });

      it(`${name}: messages run top to bottom in the order given, each from its sender to its receiver`, () => {
        expect(layout.messages.map((m) => m.message)).toEqual(data.messages);
        const xOf = new Map(layout.actors.map((a) => [a.actor.id, a.x]));
        let lastY = layout.actors[0].box.y + layout.actors[0].box.height;
        for (const item of layout.messages) {
          const [start, ...rest] = item.points;
          const tip = rest[rest.length - 1];
          expect(start.x).toBe(xOf.get(item.message.from));
          expect(tip.x).toBe(xOf.get(item.message.to));
          expect(start.y).toBeGreaterThan(lastY);
          lastY = Math.max(...item.points.map((p) => p.y));
          if (item.self) {
            expect(item.points).toHaveLength(4);
            expect(tip.y).toBeGreaterThan(start.y);
            expect(item.direction).toBe('left');
          } else {
            expect(item.points).toHaveLength(2);
            expect(tip.y).toBe(start.y);
            expect(item.direction).toBe(tip.x > start.x ? 'right' : 'left');
          }
        }
      });

      it(`${name}: every label clears the headers, the lifelines it does not cross, and every other label`, () => {
        const headerBottom = layout.actors[0].box.y + layout.actors[0].box.height;
        const indexOf = new Map(layout.actors.map((a, index) => [a.actor.id, index]));
        for (const item of layout.messages) {
          const { label } = item;
          expect(label.box.y).toBeGreaterThanOrEqual(headerBottom);
          expect(label.box.x).toBeGreaterThanOrEqual(0);
          expect(label.box.x + label.box.width).toBeLessThanOrEqual(layout.width);
          expect(label.box.y + label.box.height).toBeLessThanOrEqual(layout.height);
          // A label sits between its message's ends and never under them. A
          // lifeline the message itself crosses may pass under the label's
          // backing, as a crossing edge does under a graph label.
          const from = indexOf.get(item.message.from) ?? 0;
          const to = indexOf.get(item.message.to) ?? 0;
          const low = Math.min(from, to);
          const high = Math.max(from, to);
          layout.actors.forEach((actor, index) => {
            if (!item.self && index > low && index < high) return;
            expect(overlaps(label.box, lifelineBox(actor.x, headerBottom, actor.lifelineEnd)), `${label.text} under ${actor.actor.id}`).toBe(false);
          });
        }
        const labels = layout.messages.map((m) => m.label);
        labels.forEach((label, index) => {
          for (const other of labels.slice(index + 1)) {
            expect(overlaps(label.box, other.box), `${label.text} over ${other.text}`).toBe(false);
          }
        });
      });

      it(`${name}: the lifelines run past the last message and the drawing holds everything`, () => {
        const lowest = Math.max(
          ...layout.messages.flatMap((m) => [...m.points.map((p) => p.y), m.label.box.y + m.label.box.height]),
          layout.actors[0].box.y + layout.actors[0].box.height,
        );
        for (const actor of layout.actors) {
          expect(actor.lifelineEnd).toBeGreaterThan(lowest);
          expect(actor.lifelineEnd).toBeLessThan(layout.height);
          expect(actor.box.x).toBeGreaterThanOrEqual(0);
          expect(actor.box.x + actor.box.width).toBeLessThanOrEqual(layout.width);
        }
        for (const item of layout.messages) {
          for (const point of item.points) {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(layout.width);
          }
        }
      });
    }

    it('grows with the message count instead of compressing the rows', () => {
      const few = layoutSequence(sequence(['a', 'b'], [['a', 'b', 'one']]), orientation);
      const many = layoutSequence(
        sequence(['a', 'b'], Array.from({ length: 30 }, (_, i) => ['a', 'b', `message ${i}`] as [string, string, string])),
        orientation,
      );
      expect(many.height).toBeGreaterThan(few.height);
      const pitch = many.messages[1].points[0].y - many.messages[0].points[0].y;
      expect(few.messages[0].points[0].y).toBe(many.messages[0].points[0].y);
      expect(many.messages[29].points[0].y - many.messages[28].points[0].y).toBe(pitch);
    });

    it('keeps the approved width when the labels already fit', () => {
      const small = layoutSequence(sequence(['a', 'b'], [['a', 'b', 'go']]), orientation);
      expect(small.width).toBe(orientation === 'landscape' ? 1000 : 420);
    });

    it('wraps a long label over its span, and widens the span only for a word that cannot wrap', () => {
      const layout = layoutSequence(sequences.wordy, orientation);
      const [wrapped, unbroken, spanning] = layout.messages;
      const [a, b, c] = layout.actors;
      expect(c.x - b.x).toBeGreaterThan(unbroken.label.box.width);
      expect(c.x - b.x).toBeGreaterThan(b.x - a.x);
      expect(wrapped.label.lines.length).toBeGreaterThan(1);
      expect(unbroken.label.lines).toHaveLength(1);
      // The span across both gaps has twice the room of one between neighbours.
      expect(spanning.label.lines.length).toBeLessThan(wrapped.label.lines.length);
      expect(unbroken.label.box.width).toBeGreaterThan(wrapped.label.box.width);
    });

    it('wraps a sub under its actor in portrait only, keeping a separator with the words before it', () => {
      const data: SequenceDiagramData = {
        mode: 'sequence',
        actors: [{ id: 'pbx', label: 'PBX', sub: 'SWITCHBOARD / ROUTING' }, { id: 'agent', label: 'AGENT' }],
        messages: [],
      };
      const { actors } = layoutSequence(data, orientation);
      if (orientation === 'landscape') {
        expect(actors[0].subLines).toEqual(['SWITCHBOARD / ROUTING']);
      } else {
        expect(actors[0].subLines).toEqual(['SWITCHBOARD /', 'ROUTING']);
        expect(actors[0].box.height).toBeGreaterThan(actors[1].box.height - 1);
      }
      expect(actors[1].subLines).toEqual([]);
    });

    it('draws a self-message as a loop beside its lifeline with the label outside the loop', () => {
      const layout = layoutSequence(sequences.tail, orientation);
      const loop = layout.messages[1];
      const x = layout.actors[1].x;
      expect(loop.self).toBe(true);
      expect(loop.points.map((p) => p.x)).toEqual([x, loop.points[1].x, loop.points[1].x, x]);
      expect(loop.points[1].x).toBeGreaterThan(x);
      expect(loop.points[2].y).toBeGreaterThan(loop.points[0].y);
      expect(loop.label.anchor).toBe('start');
      expect(loop.label.box.x).toBeGreaterThan(loop.points[1].x);
    });
  });
}

describe('sequence layout / orientation', () => {
  it('portrait keeps the actors across the top with narrower columns', () => {
    const landscape = layoutSequence(sequences.handoff, 'landscape');
    const portrait = layoutSequence(sequences.handoff, 'portrait');
    expect(portrait.actors.map((a) => a.box.y)).toEqual(landscape.actors.map((a) => a.box.y));
    expect(portrait.width).toBeLessThan(landscape.width);
    expect(portrait.actorLabelSize).toBeLessThan(landscape.actorLabelSize);
    for (let i = 0; i < portrait.actors.length; i += 1) {
      expect(portrait.actors[i].box.width).toBeLessThanOrEqual(landscape.actors[i].box.width);
    }
  });
});
