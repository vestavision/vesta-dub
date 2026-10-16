/** Experimental evidence types. A playback fallback is never a detected identity. */
export interface SpeakerSegment {
  speakerId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  confidence: number | null; // null when the model does not expose calibrated scores
  provenance: 'local-diarization' | 'caption-label' | 'manual-reference';
}
export interface SpeakerAssignment {
  speakerId: string | null;
  sourceStartMs: number;
  sourceEndMs: number;
  confidence: number | null;
  provenance: 'local-diarization' | 'caption-label' | 'manual-reference' | 'unassigned';
  reason: 'assigned' | 'no-evidence' | 'partial-coverage' | 'mixed-speakers' | 'overlap' | 'low-confidence';
  coverage: number;
}

function unionLength(intervals: [number, number][]): number {
  let end = -Infinity, total = 0;
  for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

/** Align a whole translated phrase once. Never split text using guessed word times. */
export function alignSpeaker(
  sourceStartMs: number, sourceEndMs: number, segments: SpeakerSegment[],
): SpeakerAssignment {
  if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs) || sourceEndMs <= sourceStartMs) {
    throw new Error('Invalid phrase interval');
  }
  const span = sourceEndMs - sourceStartMs;
  const hits = segments.filter(s => s.speakerId && Number.isFinite(s.sourceStartMs)
    && Number.isFinite(s.sourceEndMs) && s.sourceEndMs > s.sourceStartMs
    && s.sourceEndMs > sourceStartMs && s.sourceStartMs < sourceEndMs)
    .map(s => ({ ...s, sourceStartMs: Math.max(sourceStartMs, s.sourceStartMs), sourceEndMs: Math.min(sourceEndMs, s.sourceEndMs) }));
  const coverage = unionLength(hits.map(s => [s.sourceStartMs, s.sourceEndMs])) / span;
  const result: SpeakerAssignment = { speakerId: null, sourceStartMs, sourceEndMs,
    confidence: null, provenance: 'unassigned', reason: 'no-evidence', coverage };
  if (!hits.length) return result;
  // Same-speaker duplicate windows are unioned; cross-speaker overlap abstains.
  if (hits.some((a, i) => hits.slice(i + 1).some(b => a.speakerId !== b.speakerId
    && Math.min(a.sourceEndMs, b.sourceEndMs) > Math.max(a.sourceStartMs, b.sourceStartMs)))) {
    return { ...result, reason: 'overlap' };
  }
  if (new Set(hits.map(s => s.speakerId)).size > 1) return { ...result, reason: 'mixed-speakers' };
  if (coverage < 0.8) return { ...result, reason: 'partial-coverage' };
  if (hits.some(s => s.confidence !== null && (!Number.isFinite(s.confidence) || s.confidence < 0.75 || s.confidence > 1))) {
    return { ...result, reason: 'low-confidence' };
  }
  if (new Set(hits.map(s => s.provenance)).size > 1) return { ...result, reason: 'mixed-speakers' };
  const scores = hits.map(s => s.confidence);
  return { ...result, speakerId: hits[0].speakerId, reason: 'assigned', provenance: hits[0].provenance,
    confidence: scores.some(c => c === null) ? null : Math.min(...scores as number[]) };
}

/** A retained result survives seeks; navigation cannot reuse another video's identities. */
export class SpeakerTimeline {
  constructor(readonly videoId: string, readonly segments: readonly SpeakerSegment[]) {}
  assign(videoId: string, startMs: number, endMs: number): SpeakerAssignment {
    return alignSpeaker(startMs, endMs, videoId === this.videoId ? [...this.segments] : []);
  }
}
