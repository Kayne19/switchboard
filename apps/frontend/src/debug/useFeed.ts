import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { debugSocketUrl, SocketFeed, type Feed, type FeedHandlers, type FeedStatus } from './connection';
import type { DebugFrame } from './protocol';
import { initialDebugState, noteRejected, reduceFrames, type DebugState } from './reducer';

type FeedAction = { type: 'frames'; frames: DebugFrame[] } | { type: 'rejected'; error: string };

function feedReducer(state: DebugState, action: FeedAction): DebugState {
  return action.type === 'frames' ? reduceFrames(state, action.frames) : noteRejected(state, action.error);
}

export interface FeedOptions {
  fixture: boolean;
  speed: number;
  instant: boolean;
}

export function feedOptions(search: string): FeedOptions {
  const params = new URLSearchParams(search);
  const speed = Number(params.get('speed') ?? '1');
  return {
    fixture: params.has('fixture') && params.get('fixture') !== '0',
    speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
    instant: params.get('instant') === '1',
  };
}

/** How long a seq gap may stay open before the page asks for a snapshot. */
const GAP_RESYNC_MS = 2_000;

export function useDebugFeed(options: FeedOptions) {
  const [state, dispatch] = useReducer(feedReducer, undefined, initialDebugState);
  const [status, setStatus] = useState<{ status: FeedStatus; detail?: string }>({ status: 'connecting' });
  const feedRef = useRef<Feed | null>(null);
  const missingRef = useRef(state.missing);
  missingRef.current = state.missing;

  useEffect(() => {
    let cancelled = false;
    const handlers: FeedHandlers = {
      frames: (frames) => dispatch({ type: 'frames', frames }),
      rejected: (error) => dispatch({ type: 'rejected', error }),
      status: (next, detail) => setStatus({ status: next, detail }),
    };
    if (options.fixture) {
      void Promise.all([import('./demo'), import('../../tests/fixtures/debug-events.json')]).then(([demo, fixture]) => {
        if (cancelled) return;
        const data = (fixture as { default: unknown }).default as Parameters<typeof demo.fixtureFrames>[0];
        const feed = new demo.FixtureFeed(demo.fixtureFrames(data), handlers, options.speed, options.instant);
        feedRef.current = feed;
        feed.start();
      });
    } else {
      const feed = new SocketFeed(debugSocketUrl(window.location), handlers);
      feedRef.current = feed;
      feed.start();
    }
    return () => {
      cancelled = true;
      feedRef.current?.stop();
      feedRef.current = null;
    };
  }, [options.fixture, options.speed, options.instant]);

  // A gap the live stream does not fill soon means frames were lost: take a
  // fresh snapshot rather than show a projection with holes in it.
  const hasGap = state.missing.length > 0;
  useEffect(() => {
    if (!hasGap) return;
    const timer = setTimeout(() => {
      if (missingRef.current.length > 0) feedRef.current?.resync();
    }, GAP_RESYNC_MS);
    return () => clearTimeout(timer);
  }, [hasGap]);

  const resync = useCallback(() => feedRef.current?.resync(), []);
  return { state, status: status.status, statusDetail: status.detail, resync };
}
