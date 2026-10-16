import { SubtitleCue } from '../core/types';

/**
 * SpeechSegmenter
 * Converts raw, fragmented, or overly long YouTube / ASR subtitle cues into
 * natural, speech-oriented sentence units with monotonic timestamps.
 */
export class SpeechSegmenter {
  private static readonly SENTENCE_END_REGEX = /[.?!…]+$/;
  private static readonly CLAUSE_BREAK_REGEX = /[,;:]+$/;

  /**
   * Resegment raw cues into speech-friendly blocks
   * - Merges short fragments (< 1.5s or incomplete sentences)
   * - Respects punctuation boundaries
   * - Enforces monotonic timestamps
   * - Caps max speech duration per block to ~7 seconds to avoid buffer bloat
   */
  static segment(cues: SubtitleCue[], options: { maxDurationSec?: number; maxGapSec?: number } = {}): SubtitleCue[] {
    if (!cues || cues.length === 0) return [];

    const maxDurationSec = options.maxDurationSec ?? 7.0;
    const maxGapSec = options.maxGapSec ?? 1.8;

    // First ensure cues are strictly sorted by start time
    const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);
    const result: SubtitleCue[] = [];

    let currentBlock: SubtitleCue | null = null;
    let mergedCount = 1;

    for (let i = 0; i < sorted.length; i++) {
      const cue = sorted[i];
      if (!cue.originalText && !cue.turkishText) continue;

      if (!currentBlock) {
        currentBlock = { ...cue, mergedFromCount: 1 };
        mergedCount = 1;
        continue;
      }

      const gap = cue.startTime - currentBlock.endTime;
      const combinedDuration = cue.endTime - currentBlock.startTime;
      const currentEndsSentence = this.SENTENCE_END_REGEX.test(currentBlock.originalText.trim());
      const sameSpeaker = (cue.speakerId || 'speaker-a') === (currentBlock.speakerId || 'speaker-a');

      // Decide if we should merge `cue` into `currentBlock`
      const shouldMerge =
        sameSpeaker &&
        gap >= -0.2 && // Allow slight overlapping ASR timestamps
        gap <= maxGapSec && // Gap between words is natural speech pause
        combinedDuration <= maxDurationSec && // Within max block duration
        (!currentEndsSentence || currentBlock.duration < 1.4); // Merge if previous was too short even if it had a dot

      if (shouldMerge) {
        // Merge cues
        const joinOriginal = this.joinText(currentBlock.originalText, cue.originalText);
        const joinTurkish = this.joinText(currentBlock.turkishText, cue.turkishText);
        currentBlock.endTime = Math.max(currentBlock.endTime, cue.endTime);
        currentBlock.duration = currentBlock.endTime - currentBlock.startTime;
        currentBlock.originalText = joinOriginal;
        currentBlock.turkishText = joinTurkish;
        mergedCount++;
        currentBlock.mergedFromCount = mergedCount;
      } else {
        // Finalize current block and start a new one
        result.push(currentBlock);
        currentBlock = { ...cue, mergedFromCount: 1 };
        mergedCount = 1;
      }
    }

    if (currentBlock) {
      result.push(currentBlock);
    }

    // Pass 2: Re-index and strictly enforce monotonic timestamps
    return this.ensureMonotonic(result);
  }

  /**
   * Ensure cues have non-decreasing start times and non-overlapping end times
   */
  private static ensureMonotonic(cues: SubtitleCue[]): SubtitleCue[] {
    const sanitized: SubtitleCue[] = [];
    let lastEnd = 0;

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      let start = Math.max(lastEnd, cue.startTime);
      let end = Math.max(start + 0.5, cue.endTime);

      sanitized.push({
        ...cue,
        id: `cue-${i}`,
        index: i,
        startTime: Number(start.toFixed(3)),
        endTime: Number(end.toFixed(3)),
        duration: Number((end - start).toFixed(3)),
      });

      lastEnd = end;
    }

    return sanitized;
  }

  /**
   * Intelligent string joining that prevents double spaces and missing punctuation
   */
  private static joinText(a: string, b: string): string {
    const tA = (a || '').trim();
    const tB = (b || '').trim();
    if (!tA) return tB;
    if (!tB) return tA;

    // Check if A ends with hyphen (word split across cues in ASR)
    if (tA.endsWith('-')) {
      return `${tA.slice(0, -1)}${tB}`;
    }

    return `${tA} ${tB}`;
  }
}
