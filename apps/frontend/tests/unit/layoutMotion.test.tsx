// @vitest-environment jsdom
// Under reduced motion the page hands motion's layout projection nothing
// (hooks/useLayoutMotion.ts). Motion turned each layout change into an
// instant layout animation instead: drawn at the old box in the flush after
// the commit, at the new box in the next frame, and it asks for one render
// per timestamp, so a next frame within the same tick of the clock was
// never drawn and the box kept its old size for good (the main column at
// scaleY(0.9825) on a phone, beside timers, in one load in four). jsdom
// lays nothing out, so motion measures nothing here; the browser sees it
// (tests/visual/rest.spec.ts).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MotionConfig } from 'motion/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLayoutMotion, type LayoutMotion } from '../../src/hooks/useLayoutMotion';
import { mount, unmountAll } from './sceneHarness';

let seen: LayoutMotion | null = null;
function Probe({ motion }: { motion: LayoutMotion }) {
  seen = useLayoutMotion(motion);
  return null;
}

afterEach(() => {
  unmountAll();
  seen = null;
});

const src = `${import.meta.dirname}/../../src/`;
const sources = (readdirSync(src, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.tsx'))
  .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') }));

describe('layout motion', () => {
  it('is what the element asks for where motion is not reduced', () => {
    mount(<MotionConfig reducedMotion="never"><Probe motion={{ layout: 'position', layoutId: 'damocles-presence' }} /></MotionConfig>);
    expect(seen).toEqual({ layout: 'position', layoutId: 'damocles-presence' });
  });

  it('is nothing under reduced motion: no layout animation and no shared identity to project', () => {
    mount(<MotionConfig reducedMotion="always"><Probe motion={{ layout: true, layoutId: 'switchboard-object-route' }} /></MotionConfig>);
    expect(seen).toEqual({});
  });

  it('is the only way a motion element takes layout or layoutId: none is written on the element', () => {
    // Every <motion.x ...> opening tag in the page (an arrow function's `=>`
    // in its props does not end the tag).
    const written = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/<motion\.\w+\b(?:=>|[^>])*>/gs)]
        .filter((tag) => /\s(layout|layoutId|layoutDependency)(?=[\s=>/])/.test(tag[0]))
        .map((tag) => `${file}: ${tag[0].replace(/\s+/g, ' ').slice(0, 80)}`),
    );
    expect(written).toEqual([]);
    // And the hook is what the elements that move take.
    const users = sources.filter(({ text }) => /useLayoutMotion\(/.test(text)).map(({ file }) => file).sort();
    expect(users).toEqual(['components/FocusLayer.tsx', 'components/Scenes.tsx', 'primitives/DamoclesPresence.tsx', 'primitives/MetricsPrimitive.tsx', 'primitives/ObjectMotion.tsx']);
  });
});
