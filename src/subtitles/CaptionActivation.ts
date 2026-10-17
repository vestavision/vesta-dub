export type CaptionActivationDecision = 'use-cache' | 'skip-disabled' | 'defer-hidden' | 'skip-duplicate' | 'activate';

/**
 * The player reloads media when captions are activated. One visible request
 * is enough for the signed timedtext body. A repeat, or a request made while
 * the tab is hidden, reloads the player where autoplay cannot resume.
 */
export function captionActivationDecision(input: {
  cached: boolean;
  enabled: boolean;
  hidden: boolean;
  attempts: number;
  elapsedSinceAttemptMs: number | null;
}): CaptionActivationDecision {
  if (input.cached) return 'use-cache';
  if (!input.enabled) return 'skip-disabled';
  if (input.hidden) return 'defer-hidden';
  if (input.attempts >= 2) return 'skip-duplicate';
  if (input.attempts === 1 && (input.elapsedSinceAttemptMs == null || input.elapsedSinceAttemptMs < 4000)) return 'skip-duplicate';
  return 'activate';
}

/** One seek back after the caption reload returns the media to the start. */
export function shouldRestoreCaptionPlayback(savedTime: number, currentTime: number | null, alreadyRestored: boolean): boolean {
  return !alreadyRestored && savedTime > 1 && currentTime != null && currentTime < 1 && savedTime - currentTime > 1.5;
}
