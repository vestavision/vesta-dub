import { describe, expect, it } from 'vitest';
import { captionActivationDecision, shouldRestoreCaptionPlayback } from '../src/subtitles/CaptionActivation';

describe('caption activation', () => {
  it('uses a cached payload without touching the player', () => {
    expect(captionActivationDecision({ cached: true, enabled: true, hidden: false, attempts: 0, elapsedSinceAttemptMs: null })).toBe('use-cache');
  });

  it('does not activate while hidden, and waits before a second visible attempt', () => {
    expect(captionActivationDecision({ cached: false, enabled: true, hidden: true, attempts: 0, elapsedSinceAttemptMs: null })).toBe('defer-hidden');
    expect(captionActivationDecision({ cached: false, enabled: true, hidden: false, attempts: 1, elapsedSinceAttemptMs: 500 })).toBe('skip-duplicate');
    expect(captionActivationDecision({ cached: false, enabled: true, hidden: false, attempts: 1, elapsedSinceAttemptMs: 4000 })).toBe('activate');
    expect(captionActivationDecision({ cached: false, enabled: true, hidden: false, attempts: 2, elapsedSinceAttemptMs: 9000 })).toBe('skip-duplicate');
  });

  it('activates when visible and uncached', () => {
    expect(captionActivationDecision({ cached: false, enabled: true, hidden: false, attempts: 0, elapsedSinceAttemptMs: null })).toBe('activate');
    expect(captionActivationDecision({ cached: false, enabled: false, hidden: false, attempts: 0, elapsedSinceAttemptMs: null })).toBe('skip-disabled');
  });

  it('seeks back only for the caption reload to the start', () => {
    expect(shouldRestoreCaptionPlayback(12.4, 0.02, false)).toBe(true);
    expect(shouldRestoreCaptionPlayback(12.4, 0.02, true)).toBe(false);
    expect(shouldRestoreCaptionPlayback(12.4, 11.8, false)).toBe(false);
    expect(shouldRestoreCaptionPlayback(0.4, 0, false)).toBe(false);
  });
});
