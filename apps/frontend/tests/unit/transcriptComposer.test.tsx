// @vitest-environment jsdom
// The service refuses a typed turn longer than MAX_TYPED_TURN_CHARS
// (apps/backend/src/caller_input.rs), counted in code points once trimmed,
// with a generic "That message could not be sent.". The composer had already
// cleared the draft by then, so a long paste was lost. It refuses the turn
// itself, keeps the draft, and says why.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptDrawer } from '../../src/components/TranscriptDrawer';
import { MAX_TYPED_TURN_CHARS as CAP } from '../../src/protocol';
import { mount, type } from './sceneHarness';

function composer() {
  const onSend = vi.fn((_text: string) => true);
  const host = mount(<TranscriptDrawer open lines={[]} onClose={() => {}} onSend={onSend} />);
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Conversation input"]')!;
  const send = host.querySelector<HTMLButtonElement>('.transcript__send')!;
  const status = () => host.querySelector('[role="status"]')?.textContent ?? null;
  return { onSend, field, send, status };
}

describe('the history composer and the typed-turn cap', () => {
  it('keeps a paste over the cap in the field and says why it was not sent', () => {
    const { onSend, field, send, status } = composer();
    const text = 'x'.repeat(CAP + 1);
    type(field, text);
    act(() => send.click());
    expect({ sent: onSend.mock.calls.length, kept: field.value === text, status: status() }).toEqual({
      sent: 0,
      kept: true,
      status: `NOT SENT / TOO LONG / ${CAP + 1} OF ${CAP} CHARACTERS`,
    });
  });

  it('sends a turn exactly at the cap once trimmed, as the service trims it', () => {
    const { onSend, field, send, status } = composer();
    const text = `  ${'x'.repeat(CAP)} `;
    type(field, text);
    act(() => send.click());
    expect({ sent: onSend.mock.calls.map(([sent]) => sent.trim() === text.trim()), cleared: field.value === '', status: status() }).toEqual({
      sent: [true],
      cleared: true,
      status: null,
    });
  });

  it('counts code points, not UTF-16 units: the cap in emoji is sent whole', () => {
    const { onSend, field, send } = composer();
    const text = '\u{1F680}'.repeat(CAP);
    expect(text.length).toBe(2 * CAP);
    type(field, text);
    act(() => send.click());
    expect({ sent: onSend.mock.calls.map(([sent]) => sent === text), cleared: field.value === '' }).toEqual({ sent: [true], cleared: true });
  });

  it('counts code points, not what reads as one character: an accent written as its own mark counts', () => {
    const { onSend, field, send, status } = composer();
    const text = 'é'.repeat(CAP / 2 + 1);
    type(field, text);
    act(() => send.click());
    expect({ sent: onSend.mock.calls.length, kept: field.value === text, status: status() }).toEqual({
      sent: 0,
      kept: true,
      status: `NOT SENT / TOO LONG / ${CAP + 2} OF ${CAP} CHARACTERS`,
    });
  });

  it('keeps a draft holding a lone surrogate and says why: the service would refuse the whole frame', () => {
    const { onSend, field, send, status } = composer();
    const text = 'hello \ud83d';
    type(field, text);
    act(() => send.click());
    expect({ sent: onSend.mock.calls.length, kept: field.value === text, status: status() }).toEqual({
      sent: 0,
      kept: true,
      status: 'NOT SENT / BROKEN CHARACTER',
    });
  });

  it('offers no SEND for a draft of only U+0085, which the service trims to nothing', () => {
    const { onSend, field, send } = composer();
    type(field, '\u0085');
    const disabled = send.disabled;
    act(() => send.click());
    expect({ disabled, sent: onSend.mock.calls.length }).toEqual({ disabled: true, sent: 0 });
  });

  it('sends a turn at the cap that ends in U+0085, which the service trims away', () => {
    const { onSend, field, send, status } = composer();
    type(field, 'x'.repeat(CAP) + '\u0085');
    act(() => send.click());
    expect({ sent: onSend.mock.calls.map(([sent]) => sent === 'x'.repeat(CAP)), status: status() }).toEqual({ sent: [true], status: null });
  });

  it('sends a draft the service trims differently from the page without a stray U+0085', () => {
    const { onSend, field, send } = composer();
    type(field, '\u0085hi\u0085');
    act(() => send.click());
    expect(onSend.mock.calls).toEqual([['hi']]);
  });
});
