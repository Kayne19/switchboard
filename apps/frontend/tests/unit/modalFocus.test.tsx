// @vitest-environment jsdom
// Modal focus, phase by event (`useModalFocus`): the history
// (TranscriptDrawer) is the dialog here, the focus layer takes the same
// hook. A dialog is closed, open (focus belongs on its target: the field
// on a live line, RETURN while the line is down), or giving focus back to
// what held it before it opened, once in a microtask after the commit that
// closes it and then once a frame, for at most 60 tries.
//
// jsdom enforces neither `inert` nor the browser's blur of a field that
// turns disabled: the rows that depend on them are in historyModal.spec.ts
// and focusModal.spec.ts, which run in Chromium and WebKit.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptDrawer } from '../../src/components/TranscriptDrawer';
import { mount, rerender, unmountAll } from './sceneHarness';

type Line = { key: number; speaker: string; text: string };

const lines: Line[] = [
  { key: 0, speaker: 'CALLER', text: 'Where are the docs?' },
  { key: 1, speaker: 'DAMOCLES', text: 'They are in [the docs](https://example.com/docs).' },
];

// Frames run when the test says, not on a clock.
let frames: Array<FrameRequestCallback | null> = [];
let framesRequested = 0;

beforeEach(() => {
  control('opener');
  control('elsewhere');
  frames = [];
  framesRequested = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    framesRequested += 1;
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
    frames[handle - 1] = null;
  });
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The frames requested and not cancelled. */
const pending = () => frames.filter((callback) => callback !== null).length;

/** Runs the frames requested so far. */
function frame() {
  const due = frames;
  frames = due.map(() => null);
  act(() => {
    for (const callback of due) callback?.(0);
  });
}

/** Lets the microtask the closing commit queued run. */
async function afterCommit() {
  await act(async () => {
    await Promise.resolve();
  });
}

const send = () => true;

function page(open: boolean, onSend: ((text: string) => boolean) | undefined) {
  return <TranscriptDrawer open={open} lines={lines} onClose={() => {}} onSend={onSend} />;
}

/** A control outside the dialog, as the page's are. */
function control(className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = className;
  document.body.append(button);
  return button;
}

const field = () => document.querySelector<HTMLInputElement>('.transcript__input');
const returnButton = () => document.querySelector<HTMLButtonElement>('.transcript__return');
const opener = () => document.querySelector<HTMLButtonElement>('.opener')!;
const elsewhere = () => document.querySelector<HTMLButtonElement>('.elsewhere')!;
const link = () => document.querySelector<HTMLAnchorElement>('.transcript .rich-text__link')!;

/** Mounts the page closed, focuses the opener, and opens the history. */
function openFromOpener(onSend: ((text: string) => boolean) | undefined): HTMLElement {
  const host = mount(page(false, onSend));
  opener().focus();
  rerender(host, page(true, onSend));
  return host;
}

describe('modal focus: closed', () => {
  it('open on a live line: focus moves to the field', () => {
    openFromOpener(send);
    expect(document.activeElement).toBe(field());
  });

  it('open with the line down: focus moves to RETURN', () => {
    openFromOpener(undefined);
    expect(document.activeElement).toBe(returnButton());
  });

  it('open with nothing holding focus: focus moves in, and closing gives it back to nothing', async () => {
    const host = mount(page(false, undefined));
    rerender(host, page(true, undefined));
    expect(document.activeElement).toBe(returnButton());
    rerender(host, page(false, undefined));
    await afterCommit();
    expect(pending()).toBe(0);
    expect(document.activeElement).not.toBe(opener());
  });
});

describe('modal focus: open', () => {
  it('the line comes up: focus moves to the field, from RETURN', () => {
    const host = openFromOpener(undefined);
    rerender(host, page(true, send));
    expect(document.activeElement).toBe(field());
  });

  it('the line comes up: focus moves to the field, from another control in the dialog', () => {
    const host = openFromOpener(undefined);
    link().focus();
    rerender(host, page(true, send));
    expect(document.activeElement).toBe(field());
  });

  it('a new sender on a line still up: focus stays where the caller put it', () => {
    const host = openFromOpener(send);
    returnButton()!.focus();
    rerender(host, page(true, () => true));
    expect(document.activeElement).toBe(returnButton());
  });

  // The field turns disabled under the caller's focus. jsdom leaves focus
  // on the disabled field; a browser moves it to the body (#397).
  it('the line drops while focus is on the field: focus moves to RETURN', () => {
    const host = openFromOpener(send);
    expect(document.activeElement).toBe(field());
    rerender(host, page(true, undefined));
    expect(document.activeElement).toBe(returnButton());
  });

  it('the line drops after the browser moved focus to the body: focus moves to RETURN', () => {
    const host = openFromOpener(send);
    field()!.blur();
    rerender(host, page(true, undefined));
    expect(document.activeElement).toBe(returnButton());
  });

  it('the line drops while focus is on another control in the dialog: focus stays there', () => {
    const host = openFromOpener(send);
    link().focus();
    rerender(host, page(true, undefined));
    expect(document.activeElement).toBe(link());
  });

  it('close: focus goes back to the opener after the commit, not in it', async () => {
    const host = openFromOpener(send);
    rerender(host, page(false, send));
    expect(document.activeElement).not.toBe(opener());
    await afterCommit();
    expect(document.activeElement).toBe(opener());
    expect(pending()).toBe(0);
  });
});

describe('modal focus: giving focus back', () => {
  it('an opener that cannot take focus yet is tried each frame until it can', async () => {
    const host = openFromOpener(send);
    opener().disabled = true;
    rerender(host, page(false, send));
    await afterCommit();
    expect(pending()).toBe(1);
    frame();
    expect(pending()).toBe(1);
    opener().disabled = false;
    frame();
    expect(document.activeElement).toBe(opener());
    expect(pending()).toBe(0);
  });

  it('gives up after 60 tries', async () => {
    const host = openFromOpener(send);
    opener().disabled = true;
    rerender(host, page(false, send));
    await afterCommit();
    while (pending() > 0) frame();
    // The microtask's try, then 59 frames.
    expect(framesRequested).toBe(59);
  });

  it('focus moved elsewhere on the page: it stays there, and the tries stop', async () => {
    const host = openFromOpener(send);
    opener().disabled = true;
    rerender(host, page(false, send));
    await afterCommit();
    opener().disabled = false;
    elsewhere().focus();
    frame();
    expect(document.activeElement).toBe(elsewhere());
    expect(pending()).toBe(0);
  });

  it('the opener left the page: the tries stop', async () => {
    const host = openFromOpener(send);
    opener().disabled = true;
    rerender(host, page(false, send));
    await afterCommit();
    expect(pending()).toBe(1);
    // The opener is gone; a new button of its kind is not it.
    const gone = opener();
    gone.remove();
    frame();
    expect(document.activeElement).not.toBe(gone);
    expect(pending()).toBe(0);
  });

  it('the opener is in the scene that is leaving: nothing is given back', async () => {
    // The stage draws the scene it goes to after the one that is leaving,
    // and the leaving one is inert (Scenes.tsx).
    const stage = document.createElement('main');
    stage.className = 'stage';
    const leavingScene = document.createElement('section');
    leavingScene.setAttribute('data-scene', 'conversation');
    leavingScene.setAttribute('inert', '');
    const sceneOpener = document.createElement('button');
    leavingScene.append(sceneOpener);
    const nextScene = document.createElement('section');
    nextScene.setAttribute('data-scene', 'composed');
    stage.append(leavingScene, nextScene);
    document.body.append(stage);
    const host = mount(page(false, send));
    sceneOpener.focus();
    rerender(host, page(true, send));
    expect(document.activeElement).toBe(field());
    rerender(host, page(false, send));
    await afterCommit();
    expect(document.activeElement).not.toBe(sceneOpener);
    expect(pending()).toBe(0);
  });

  it('open again while giving focus back: the dialog keeps focus', async () => {
    const host = openFromOpener(send);
    opener().disabled = true;
    rerender(host, page(false, send));
    await afterCommit();
    rerender(host, page(true, send));
    expect(document.activeElement).toBe(field());
    // The opener is behind the open dialog, inert, and cannot take focus.
    frame();
    expect(document.activeElement).toBe(field());
  });

  // Teardown on leaving the phase: opening again ends the tries. Before the
  // machine they ran on, harmless only because the opener was inert behind
  // the dialog; jsdom has no inert, so here the opener can take focus.
  it('open again while giving focus back: the tries end', async () => {
    const host = openFromOpener(send);
    opener().disabled = true;
    rerender(host, page(false, send));
    await afterCommit();
    expect(pending()).toBe(1);
    rerender(host, page(true, send));
    expect(pending()).toBe(0);
    opener().disabled = false;
    frame();
    expect(document.activeElement).toBe(field());
  });

  it('open again before the first try: the try is dropped', async () => {
    const host = openFromOpener(send);
    rerender(host, page(false, send));
    rerender(host, page(true, send));
    await afterCommit();
    expect(document.activeElement).toBe(field());
    expect(pending()).toBe(0);
  });
});
