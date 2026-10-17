/**
 * Offline plan for a bounded translation window.
 * Playback does not import this module. Bergamot has no separate context field,
 * so a combined string would be translated as if the listener said all of it.
 * `boundedContextTranslationEnabled` stays false until a real video shows that
 * the combined utterance stays in sync and does not repeat caption words.
 */

export const boundedContextTranslationEnabled = false;

export const BOUNDED_CONTEXT_LIMITS = {
  maxPastCues: 1,
  maxLookaheadCues: 1,
  maxCombinedWords: 24,
  maxGapSec: 0.8,
  maxTargetWords: 12,
  maxStartDeltaSec: 8,
} as const;

export interface BoundedCue {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface BoundedContextPlan {
  mode: 'preloaded' | 'live';
  cueId: string;
  targetText: string;
  contextBefore: string;
  contextAfter: string;
  combinedText: string;
  reason: string;
  playbackEnabled: false;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function incomplete(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && !/[.?!]["']?\s*$/u.test(trimmed)
    && words(trimmed).length <= BOUNDED_CONTEXT_LIMITS.maxTargetWords;
}

function neighbor(earlier: BoundedCue, later: BoundedCue): boolean {
  const gap = later.startTime - earlier.endTime;
  if (gap > BOUNDED_CONTEXT_LIMITS.maxGapSec) return false;
  const startDelta = later.startTime - earlier.startTime;
  return startDelta >= -0.05 && startDelta <= BOUNDED_CONTEXT_LIMITS.maxStartDeltaSec;
}

/** True when the later cue repeats the end of the earlier cue. Those joins duplicate speech. */
export function repeatsEdge(left: string, right: string): boolean {
  const earlier = words(left).map(word => word.toLocaleLowerCase('en-US').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const later = words(right).map(word => word.toLocaleLowerCase('en-US').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const limit = Math.min(4, earlier.length, later.length);
  for (let size = limit; size >= 2; size -= 1) {
    if (earlier.slice(-size).join(' ') === later.slice(0, size).join(' ')) return true;
  }
  return false;
}

export function planBoundedContext(cues: BoundedCue[], index: number, mode: 'preloaded' | 'live'): BoundedContextPlan {
  const current = cues[index];
  const previous = index > 0 ? cues[index - 1] : undefined;
  const next = index + 1 < cues.length ? cues[index + 1] : undefined;
  const target = current?.text.trim() ?? '';
  const targetIncomplete = incomplete(target);
  const past = previous && current && neighbor(previous, current) ? previous.text.trim() : '';
  let contextBefore = '';
  let contextAfter = '';
  let reason = 'target-only';

  if (mode === 'live') {
    if (targetIncomplete && past && !repeatsEdge(past, target)) {
      contextBefore = past;
      reason = 'live-past-only';
    } else if (targetIncomplete && past && repeatsEdge(past, target)) {
      reason = 'live-overlap-edge-skipped';
    } else {
      reason = 'live-target-only';
    }
  } else if (targetIncomplete) {
    const future = next && current && neighbor(current, next) && mode === 'preloaded' ? next.text.trim() : '';
    const pastOk = past && !repeatsEdge(past, target);
    const futureOk = future && !repeatsEdge(target, future);
    const count = words(pastOk ? past : '').length + words(target).length + words(futureOk ? future : '').length;
    if (count <= BOUNDED_CONTEXT_LIMITS.maxCombinedWords) {
      contextBefore = pastOk ? past : '';
      contextAfter = futureOk ? future : '';
      if (contextBefore && contextAfter) reason = 'past-and-one-lookahead';
      else if (contextAfter) reason = 'one-lookahead';
      else if (contextBefore) reason = 'preloaded-past-only';
      else if (past && repeatsEdge(past, target) || future && repeatsEdge(target, future)) reason = 'overlap-edge-skipped';
    } else {
      reason = 'over-budget';
    }
  } else {
    reason = 'complete-target';
  }

  const combinedText = [contextBefore, target, contextAfter].filter(Boolean).join(' ');
  return {
    mode,
    cueId: current?.id ?? '',
    targetText: target,
    contextBefore,
    contextAfter,
    combinedText,
    reason,
    playbackEnabled: false,
  };
}
