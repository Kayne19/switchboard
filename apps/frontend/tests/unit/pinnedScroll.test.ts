import { describe, expect, it } from 'vitest';
import { nextScroll, type PinnedScroll, type PinnedScrollEvent } from '../../src/hooks/pinnedScroll';

const following: PinnedScroll = { kind: 'following' };
const reading: PinnedScroll = { kind: 'reading' };
const heldFollowing: PinnedScroll = { kind: 'held', resume: 'following' };
const heldReading: PinnedScroll = { kind: 'held', resume: 'reading' };

const scrolled = (atPin: boolean): PinnedScrollEvent => ({ kind: 'scrolled', atPin });
const event = (kind: 'contentChanged' | 'resized' | 'hold' | 'release'): PinnedScrollEvent => ({ kind });

describe('nextScroll', () => {
  const table: [string, PinnedScroll, PinnedScrollEvent, PinnedScroll, 'pin' | 'none'][] = [
    ['following, scrolled away', following, scrolled(false), reading, 'none'],
    ['following, scrolled at the pin', following, scrolled(true), following, 'none'],
    ['following, content', following, event('contentChanged'), following, 'pin'],
    ['following, resized', following, event('resized'), following, 'pin'],
    ['following, held', following, event('hold'), heldFollowing, 'none'],
    ['following, released', following, event('release'), following, 'none'],
    ['reading, scrolled to the pin', reading, scrolled(true), following, 'none'],
    ['reading, scrolled elsewhere', reading, scrolled(false), reading, 'none'],
    ['reading, content', reading, event('contentChanged'), reading, 'none'],
    ['reading, resized', reading, event('resized'), reading, 'none'],
    ['reading, held', reading, event('hold'), heldReading, 'none'],
    ['reading, released', reading, event('release'), reading, 'none'],
    ['held following, scrolled to the pin', heldFollowing, scrolled(true), heldFollowing, 'none'],
    ['held following, scrolled away', heldFollowing, scrolled(false), heldFollowing, 'none'],
    ['held following, content', heldFollowing, event('contentChanged'), heldFollowing, 'none'],
    ['held following, resized', heldFollowing, event('resized'), heldFollowing, 'none'],
    ['held following, held again', heldFollowing, event('hold'), heldFollowing, 'none'],
    ['held following, released', heldFollowing, event('release'), following, 'pin'],
    ['held reading, scrolled to the pin', heldReading, scrolled(true), heldReading, 'none'],
    ['held reading, scrolled away', heldReading, scrolled(false), heldReading, 'none'],
    ['held reading, content', heldReading, event('contentChanged'), heldReading, 'none'],
    ['held reading, resized', heldReading, event('resized'), heldReading, 'none'],
    ['held reading, held again', heldReading, event('hold'), heldReading, 'none'],
    ['held reading, released', heldReading, event('release'), reading, 'none'],
  ];

  it.each(table)('%s', (_name, from, given, to, effect) => {
    expect(nextScroll(from, given)).toEqual({ state: to, effect });
  });
});
