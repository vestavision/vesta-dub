import { SubtitleCue, TTSProviderId } from '../core/types';

export interface DurationBudget {
  sourceStartTime: number;
  sourceEndTime: number;
  sourceDuration: number;
  availableSilenceGap: number;
  availableSpeechDuration: number;
  actualTtsDuration: number;
  requiredCompressionRatio: number;
  safeWsolaAllowance: number;
  durationAfterWsola: number;
  remainingUnresolvedOverflow: number;
  targetRefinedDuration: number;
  targetSyllableBudget: number;
  estimatedCurrentSyllables: number;
  needsRefinement: boolean;
}

export interface CalibrationProfile {
  providerId: TTSProviderId;
  name: string;
  syllablesPerSec: number;
  charsPerSec: number;
}

export const CALIBRATION_PROFILES: Partial<Record<TTSProviderId, CalibrationProfile>> = {
  'antalia': {
    providerId: 'antalia',
    name: 'Antalia-2 Mini (48kHz Flow Matching)',
    syllablesPerSec: 4.65,
    charsPerSec: 14.2,
  },
};

/**
 * DurationBudgetEstimator
 * Computes exact timing constraints, available silence gaps, safe WSOLA allowances,
 * and target duration/syllable budgets for English-to-Turkish video dubbing.
 */
export class DurationBudgetEstimator {
  private static readonly TURKISH_VOWELS = /[aeıioöuüâîû]/gi;

  /**
   * Estimate the number of syllables in a Turkish text string.
   * In Turkish phonology, every vowel corresponds to exactly one syllable.
   */
  static countTurkishSyllables(text: string): number {
    if (!text) return 0;
    const matches = text.match(this.TURKISH_VOWELS);
    return matches ? matches.length : 0;
  }

  /**
   * Calculate duration budget for a given subtitle cue
   *
   * @param cue The subtitle cue containing timestamps and translation
   * @param ttsDuration Real synthesized TTS duration in seconds (if already cached/synthesized)
   * @param nextCueStartTime Start time of the subsequent cue for silence gap calculation
   * @param providerId TTS provider calibration profile (default: 'antalia')
   */
  static estimateBudget(
    cue: SubtitleCue,
    ttsDuration?: number,
    nextCueStartTime?: number,
    providerId: TTSProviderId = 'antalia'
  ): DurationBudget {
    // EMA has no production calibration: retain baseline estimation/refinement heuristics and prefer measured duration for the timing budget.
    const profile = CALIBRATION_PROFILES[providerId] || CALIBRATION_PROFILES['antalia']!;

    const sourceDuration = Math.max(0.2, cue.endTime - cue.startTime);

    // Calculate silence gap allowance (up to 80% of silence before next cue, capped at 2.0s)
    let availableSilenceGap = 0;
    if (nextCueStartTime !== undefined && nextCueStartTime > cue.endTime) {
      const rawGap = nextCueStartTime - cue.endTime;
      availableSilenceGap = Math.min(2.0, rawGap * 0.8);
    }

    const availableSpeechDuration = Number((sourceDuration + availableSilenceGap).toFixed(3));

    const textToEstimate = cue.turkishText || cue.originalText || '';
    const estimatedCurrentSyllables = this.countTurkishSyllables(textToEstimate);

    // Prefer actual cached TTS duration; fallback to calibrated model profile
    let actualTtsDuration: number;
    if (ttsDuration !== undefined && ttsDuration > 0) {
      actualTtsDuration = Number(ttsDuration.toFixed(3));
    } else {
      // Profile-based estimate: duration = syllables / syllablesPerSec + sentence boundary overhead (0.2s)
      const estimatedSec = (estimatedCurrentSyllables / profile.syllablesPerSec) + 0.15;
      actualTtsDuration = Number(Math.max(0.3, estimatedSec).toFixed(3));
    }

    // Required compression ratio
    const requiredCompressionRatio = Number((actualTtsDuration / availableSpeechDuration).toFixed(2));

    // Safe WSOLA stretch factor (capped at 1.25x to preserve natural timbre)
    const maxSafeStretch = 1.25;
    const safeWsolaAllowance = Number(Math.max(1.0, Math.min(maxSafeStretch, requiredCompressionRatio)).toFixed(2));

    // Audio duration when played under safe WSOLA time-stretching
    const durationAfterWsola = Number((actualTtsDuration / safeWsolaAllowance).toFixed(3));

    // Remaining overflow that exceeds available speech duration even after WSOLA
    const remainingUnresolvedOverflow = Number(Math.max(0, durationAfterWsola - availableSpeechDuration).toFixed(3));

    // Target duration budget for semantic refinement:
    // Audio duration must be <= availableSpeechDuration * 1.25 to fit cleanly with WSOLA
    const targetRefinedDuration = Number((availableSpeechDuration * maxSafeStretch).toFixed(3));

    // Auxiliary target syllable budget
    const targetSyllableBudget = Math.max(2, Math.floor(targetRefinedDuration * profile.syllablesPerSec));

    // Refinement is needed if remaining overflow is > 50 ms
    const needsRefinement = remainingUnresolvedOverflow > 0.05;

    return {
      sourceStartTime: cue.startTime,
      sourceEndTime: cue.endTime,
      sourceDuration,
      availableSilenceGap,
      availableSpeechDuration,
      actualTtsDuration,
      requiredCompressionRatio,
      safeWsolaAllowance,
      durationAfterWsola,
      remainingUnresolvedOverflow,
      targetRefinedDuration,
      targetSyllableBudget,
      estimatedCurrentSyllables,
      needsRefinement,
    };
  }
}
