import { describe, expect, it } from 'vitest';
import type { SequenceDiagramData, SequenceMessage } from '../../src/controller/types';
import { fixtures, traceDiagram } from '../../src/fixtures/scenes';
import { SLIVER } from '../../src/primitives/drawingFit';
import { layoutSequence, sequenceMinScale, viewSequence, type Box, type SequenceOrientation } from '../../src/primitives/sequenceLayout';

const handoffDiagram = (fixtures.handoff[0] as { data: SequenceDiagramData }).data;

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


describe('sequence recomposed to a width', () => {
  // The hard trace (8 actors, 32 messages), the handoff, and the wordy and
  // self-message cases, recomposed to a phone's width at the readable
  // minimum (377 units), to a focus layer's (418), and to the landscape
  // slot's (1175).
  const cases: Array<[string, SequenceDiagramData]> = [
    ['trace', traceDiagram],
    ['handoff', handoffDiagram],
    ['wordy', sequences.wordy],
    ['tail', sequences.tail],
    // An empty actor label and an empty message label are allowed.
    [
      'blanks',
      {
        mode: 'sequence',
        actors: [{ id: 'a', label: '' }, ...traceDiagram.actors.slice(1)],
        messages: [{ from: 'a', to: 'ws', label: '' }, ...traceDiagram.messages.slice(1, 6)],
      },
    ],
  ];
  for (const orientation of ['landscape', 'portrait'] as SequenceOrientation[]) {
    for (const [name, data] of cases) {
      for (const frameWidth of [377, 418, 1175]) {
        const natural = layoutSequence(data, orientation);
        const layout = layoutSequence(data, orientation, { width: frameWidth });
        it(`${orientation} / ${name} in ${frameWidth}: as wide as the frame, its headers clear of each other and of other lifelines`, () => {
          if (natural.width <= frameWidth) {
            expect(layout).toEqual(natural);
            return;
          }
          // A landscape header's words are wider than a phone frame's
          // columns allow; there it is as narrow as its words let it be.
          if (orientation === 'portrait' || frameWidth > 1000) expect(layout.width).toBeLessThanOrEqual(frameWidth + 1e-6);
          else expect(layout.width).toBeLessThan(natural.width);
          const headerBottom = Math.max(...layout.actors.map((actor) => actor.box.y + actor.box.height));
          layout.actors.forEach((actor, index) => {
            expect(actor.box.x).toBeGreaterThanOrEqual(0);
            expect(actor.box.x + actor.box.width).toBeLessThanOrEqual(layout.width + 1e-6);
            // Its own lifeline drops from inside its box.
            expect(actor.x).toBeGreaterThan(actor.box.x);
            expect(actor.x).toBeLessThan(actor.box.x + actor.box.width);
            for (const other of layout.actors.slice(index + 1)) expect(overlaps(actor.box, other.box), `${actor.actor.id} over ${other.actor.id}`).toBe(false);
            // Another actor's lifeline, falling from a row above, passes it by.
            for (const other of layout.actors) {
              if (other === actor || other.box.y >= actor.box.y) continue;
              const line: Box = { x: other.x, y: other.box.y + other.box.height, width: 0.001, height: headerBottom - other.box.y - other.box.height };
              expect(overlaps(actor.box, line), `${other.actor.id}'s lifeline through ${actor.actor.id}`).toBe(false);
            }
          });
          // Every word of a header is drawn, inside its box.
          for (const actor of layout.actors) {
            for (const value of [actor.x, actor.box.x, actor.box.width, actor.box.height]) expect(Number.isFinite(value)).toBe(true);
            const widest = Math.max(0, ...actor.labelLines.map((line) => line.length * layout.actorLabelSize * 0.7), ...actor.subLines.map((line) => line.length * layout.actorSubSize * 0.69));
            expect(widest, actor.actor.id).toBeLessThanOrEqual(actor.box.width + 1e-6);
            expect(actor.labelLines.join(' ')).toBe(actor.actor.label);
            expect(actor.subLines.join('').replace(/\s/g, '')).toBe((actor.actor.sub ?? '').replace(/\s/g, ''));
          }
        });

        it(`${orientation} / ${name} in ${frameWidth}: messages in order, each label on its own row, clear of the headers and the others`, () => {
          const headerBottom = Math.max(...layout.actors.map((actor) => actor.box.y + actor.box.height));
          const indexOf = new Map(layout.actors.map((actor, index) => [actor.actor.id, index]));
          let lastY = headerBottom;
          for (const item of layout.messages) {
            const top = Math.min(item.label.box.y, ...item.points.map((point) => point.y));
            expect(top).toBeGreaterThan(lastY);
            lastY = Math.max(item.label.box.y + item.label.box.height, ...item.points.map((point) => point.y));
            const { box } = item.label;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(layout.width + 1e-6);
            // Every character of the label is drawn (a word too long for a line breaks).
            expect(item.label.lines.join('').replace(/\s/g, '')).toBe(item.message.label.replace(/\s/g, ''));
            if (!item.label.over) {
              // Between its lifelines: clear of every lifeline it does not cross.
              const from = indexOf.get(item.message.from) ?? 0;
              const to = indexOf.get(item.message.to) ?? 0;
              layout.actors.forEach((actor, index) => {
                if (!item.self && index > Math.min(from, to) && index < Math.max(from, to)) return;
                const line: Box = { x: actor.x, y: headerBottom, width: 0.001, height: actor.lifelineEnd - headerBottom };
                expect(overlaps(box, line), `${item.label.text} under ${actor.actor.id}`).toBe(false);
              });
            } else if (!item.self) {
              // Over its arrow: centred on it as far as the edges allow.
              const centre = (item.points[0].x + item.points[1].x) / 2;
              // (A label held off the drawing's edge, within its side padding, is not centred.)
              const clamped = box.x <= 8 + 1e-6 || box.x + box.width >= layout.width - 8 - 1e-6;
              if (!clamped) expect(box.x + box.width / 2).toBeCloseTo(centre);
              expect(box.y + box.height).toBeLessThanOrEqual(item.points[0].y);
            }
          }
          const labels = layout.messages.map((message) => message.label.box);
          labels.forEach((label, index) => {
            for (const other of labels.slice(index + 1)) expect(overlaps(label, other)).toBe(false);
          });
          for (const actor of layout.actors) expect(actor.lifelineEnd).toBeGreaterThan(lastY);
        });
      }
    }
  }
});

describe('a sequence read in its viewport', () => {
  // The diagram slot's drawing viewport and the focus layer's at each
  // canonical geometry, in CSS pixels.
  const viewports = [
    { width: 914, height: 526 },
    { width: 330, height: 374 },
    { width: 726, height: 531 },
    { width: 1980, height: 604 },
    { width: 1325, height: 792 },
    { width: 366, height: 726 },
  ];
  for (const [name, data] of [['trace', traceDiagram], ['handoff', handoffDiagram]] as const) {
    it(`${name}: never below the readable minimum, and never scrolled across in a stage or focus viewport`, () => {
      for (const size of viewports) {
        for (const scrollbar of [0, 11]) {
          const { layout, fit } = viewSequence(data, { ...size, scrollbar });
          expect(fit.scale, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(sequenceMinScale(layout) * (1 - SLIVER) - 1e-9);
          expect(fit.scrollX, `${size.width}x${size.height}`).toBe(false);
        }
      }
    });
  }

  it('reads the thirty-two-message trace at the readable minimum, not at a few pixels', () => {
    const { fit } = viewSequence(traceDiagram, { width: 914, height: 526, scrollbar: 0 });
    // Scaled to fit the slot, its 11-unit message labels came out at 3.6 px.
    expect(11 * fit.scale).toBeGreaterThanOrEqual(8);
    expect(fit.scrollY).toBe(true);
  });
});
