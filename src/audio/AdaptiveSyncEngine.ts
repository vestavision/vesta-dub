import { CueSyncMetadata, SubtitleCue, SyncStrategy } from '../core/types';

export interface SyncDecision {
  playbackSpeed: number; // 1.0 - 1.25 (WSOLA pitch-preserved time-stretch speed)
  strategy: SyncStrategy;
  conciseText?: string;
  overflowSec: number;
  availableWindow: number;
  isCompromised?: boolean;
  compromiseSec?: number;
}

/**
 * AdaptiveSyncEngine (P2-A Hardened)
 * Computes optimal playback speed, silence gap absorption, and conservative semantic phrasing
 * when translated Turkish speech exceeds the original caption time slot.
 *
 * Guarantees:
 * 1. Zero silent truncation of sentence endings.
 * 2. Zero information loss: never drops negations, numbers, conditions, units, or causal terms.
 * 3. Transparent reporting of synchronization compromises.
 */
export class AdaptiveSyncEngine {
  private maxStretch: number;
  private minStretch: number;

  constructor(options: { maxStretch?: number; minStretch?: number } = {}) {
    this.maxStretch = options.maxStretch ?? 1.25; // Maximum 25% acceleration to preserve naturalness
    this.minStretch = options.minStretch ?? 0.90; // Up to 10% slowdown if slot is huge
  }

  /**
   * Evaluate a cue against its synthesized audio duration and neighboring silence gap
   */
  evaluate(
    cue: SubtitleCue,
    audioDuration: number,
    nextCueStartTime?: number
  ): SyncDecision {
    const originalSlot = cue.duration;
    // Calculate total available window including silence until the next cue
    let availableWindow = originalSlot;
    if (nextCueStartTime !== undefined && nextCueStartTime > cue.endTime) {
      const silenceGap = nextCueStartTime - cue.endTime;
      // We can safely absorb up to 80% of the silence gap without running into the next speaker
      availableWindow += Math.min(2.0, silenceGap * 0.8);
    }

    const overflowSec = Math.max(0, audioDuration - originalSlot);

    // Strategy 1: Fits comfortably within original slot
    if (audioDuration <= originalSlot * 1.02) {
      return {
        playbackSpeed: 1.0,
        strategy: 'normal',
        overflowSec: 0,
        availableWindow,
      };
    }

    // Strategy 2: Fits by absorbing subsequent silence gap
    if (audioDuration <= availableWindow * 1.02) {
      return {
        playbackSpeed: 1.0,
        strategy: 'gap_absorbed',
        overflowSec: 0,
        availableWindow,
      };
    }

    // Strategy 3: Bounded time-stretching within maxStretch (1.0x - 1.25x)
    const requiredSpeed = audioDuration / availableWindow;

    if (requiredSpeed <= this.maxStretch) {
      return {
        playbackSpeed: Number(requiredSpeed.toFixed(2)),
        strategy: 'time_stretched',
        overflowSec: 0,
        availableWindow,
      };
    }

    // Strategy 4: Severe overflow (> 25% longer) -> Try safe semantic compression
    const conciseCandidate = this.suggestSafeConcisePhonology(cue.turkishText);
    if (conciseCandidate && conciseCandidate !== cue.turkishText) {
      const remainingOverflow = Math.max(0, audioDuration / this.maxStretch - availableWindow);
      return {
        playbackSpeed: this.maxStretch,
        strategy: 'concise_resynthesized',
        conciseText: conciseCandidate,
        overflowSec: Number(remainingOverflow.toFixed(2)),
        availableWindow,
      };
    }

    // Strategy 5: Unavoidable overflow -> Explicitly mark synchronization compromise
    // We preserve the full speech by playing at maxStretch without silent sentence truncations.
    const compromiseSec = Number((audioDuration / this.maxStretch - availableWindow).toFixed(2));
    return {
      playbackSpeed: this.maxStretch,
      strategy: 'unresolved_overflow_compromise',
      overflowSec: compromiseSec,
      availableWindow,
      isCompromised: true,
      compromiseSec,
    };
  }

  /**
   * Safe Semantic Compression for Turkish Text
   * Conservative rules that shorten verbose phrasing while strictly preserving:
   * - Negations (değil, yok, asla, hiç, vb.)
   * - Numbers, currencies, and percentages
   * - Names and technical acronyms
   * - Conditions (eğer, ise) and causal conjunctions (çünkü, dolayısıyla)
   * - Physical units
   */
  suggestSafeConcisePhonology(text: string): string | null {
    if (!text || text.trim().length === 0) return null;

    // 1. Extract protected semantic tokens before transformation
    const protectedElements = this.extractProtectedElements(text);

    // 2. Apply conservative phrase consolidations
    let shortened = text
      // Temporal adverbs to concise equivalents
      .replace(/(?<![\p{L}\p{N}])[şs]u anda(?![\p{L}\p{N}])/giu, 'şimdi')
      // Contrastive conjunctions (preserves contrastive logic)
      .replace(/(?<![\p{L}\p{N}])bununla birlikte(?![\p{L}\p{N}])/giu, 'ancak')
      // Emphatic clitic consolidation
      .replace(/(?<![\p{L}\p{N}])gerçekten de(?![\p{L}\p{N}])/giu, 'gerçekten')
      // Reflexive consolidation
      .replace(/(?<![\p{L}\p{N}])kendi kendine(?![\p{L}\p{N}])/giu, 'kendisi')
      // Normalize excess spaces
      .replace(/\s{2,}/g, ' ')
      .trim();

    // If nothing changed, return null
    if (shortened === text || shortened.length >= text.length) {
      return null;
    }

    // 3. Verify semantic integrity: candidate must contain all protected elements
    if (!this.verifyProtectedElements(shortened, protectedElements)) {
      // Revert if any protected information was compromised
      return null;
    }

    return shortened;
  }

  /**
   * Identifies all critical semantic elements that must never be dropped
   */
  private extractProtectedElements(text: string): {
    numbers: string[];
    negations: string[];
    conditionsAndCausal: string[];
    units: string[];
  } {
    const lower = text.toLowerCase();

    // 1. Numbers, digits, percentages
    const numberMatches = text.match(/\b\d+([.,]\d+)?\b|[%₺$€]|\b(bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yüz|bin|milyon)\b/gi) || [];

    // 2. Negation markers
    const negationTokens = ['değil', 'yok', 'asla', 'hiç', 'olmaz', 'olamaz', 'yapamaz', 'etmez'];
    const foundNegations = negationTokens.filter(tok => new RegExp(`\\b${tok}\\b`, 'iu').test(lower));

    // 3. Conditionals and causal links
    const conditionalTokens = ['ise', 'eğer', 'çünkü', 'dolayısıyla', 'bu yüzden', 'nedeniyle'];
    const foundConditions = conditionalTokens.filter(tok => new RegExp(`\\b${tok}\\b`, 'iu').test(lower));

    // 4. Units
    const unitTokens = ['tl', 'kg', 'km', 'ms', 'hz', 'gb', 'mb', 'saat', 'dakika', 'saniye'];
    const foundUnits = unitTokens.filter(tok => new RegExp(`\\b${tok}\\b`, 'iu').test(lower));

    return {
      numbers: numberMatches.map(s => s.toLowerCase()),
      negations: foundNegations,
      conditionsAndCausal: foundConditions,
      units: foundUnits,
    };
  }

  /**
   * Verifies that candidate text still retains every single protected element
   */
  private verifyProtectedElements(
    candidate: string,
    protectedInfo: {
      numbers: string[];
      negations: string[];
      conditionsAndCausal: string[];
      units: string[];
    }
  ): boolean {
    const candidateLower = candidate.toLowerCase();

    // Check numbers
    for (const num of protectedInfo.numbers) {
      if (!candidateLower.includes(num)) return false;
    }

    // Check negations
    for (const neg of protectedInfo.negations) {
      if (!new RegExp(`\\b${neg}\\b`, 'iu').test(candidateLower)) return false;
    }

    // Check conditions & causal links
    for (const cond of protectedInfo.conditionsAndCausal) {
      if (!new RegExp(`\\b${cond}\\b`, 'iu').test(candidateLower)) return false;
    }

    // Check units
    for (const unit of protectedInfo.units) {
      if (!new RegExp(`\\b${unit}\\b`, 'iu').test(candidateLower)) return false;
    }

    return true;
  }
}
