import { SubtitleCue, TTSProviderId } from '../core/types';
import { DurationBudgetEstimator, DurationBudget } from './DurationBudgetEstimator';
import { SemanticSafetyGate, SemanticSafetyResult } from './SemanticSafetyGate';
import { NeuralParaphraseAdapter } from './NeuralParaphraseAdapter';

export type RefinementStrategy = 'strategy-a' | 'strategy-b' | 'strategy-c';

export interface RefinementResult {
  text: string;
  originalText: string;
  strategyUsed: RefinementStrategy;
  budget: DurationBudget;
  safetyResult: SemanticSafetyResult;
  syllablesSaved: number;
  durationReductionPct: number;
  latencyMs: number;
  isModified: boolean;
}

/**
 * SemanticRefiner
 * Implements duration-aware Turkish semantic refinement for Vesta Dub.
 * - Strategy A: Original translation (Control baseline)
 * - Strategy B: Conservative deterministic refinement (Auditable rules + SemanticSafetyGate)
 * - Strategy C: Compact neural refinement (Web Worker + SemanticSafetyGate + fallback)
 */
export class SemanticRefiner {
  private neuralAdapter: NeuralParaphraseAdapter;

  constructor(neuralAdapter = new NeuralParaphraseAdapter()) {
    this.neuralAdapter = neuralAdapter;
  }

  getNeuralAdapter(): NeuralParaphraseAdapter {
    return this.neuralAdapter;
  }

  /**
   * Refine a subtitle cue's Turkish translation based on duration budget
   */
  async refine(
    cue: SubtitleCue,
    strategy: RefinementStrategy = 'strategy-b',
    ttsDuration?: number,
    nextCueStartTime?: number,
    providerId: TTSProviderId = 'antalia'
  ): Promise<RefinementResult> {
    const t0 = performance.now();
    const originalText = cue.turkishText || cue.originalText || '';
    const budget = DurationBudgetEstimator.estimateBudget(cue, ttsDuration, nextCueStartTime, providerId);

    // Baseline validation for original text
    const baseSafety: SemanticSafetyResult = {
      isValid: true,
      safetyScore: 1.0,
      violations: [],
      preservedFeatures: {
        numbers: true,
        units: true,
        namedEntities: true,
        negationPolarity: true,
        comparisons: true,
        conditions: true,
        causals: true,
        technicalTerms: true,
        sentenceMood: true,
      },
    };

    // If timing fits cleanly without overflow, or Strategy A requested, preserve original
    if (strategy === 'strategy-a' || !budget.needsRefinement) {
      return {
        text: originalText,
        originalText,
        strategyUsed: 'strategy-a',
        budget,
        safetyResult: baseSafety,
        syllablesSaved: 0,
        durationReductionPct: 0,
        latencyMs: performance.now() - t0,
        isModified: false,
      };
    }

    let candidateText = originalText;
    let chosenStrategy: RefinementStrategy = 'strategy-a';

    if (strategy === 'strategy-b') {
      candidateText = this.applyDeterministicRefinement(originalText, budget.targetSyllableBudget);
      chosenStrategy = 'strategy-b';
    } else if (strategy === 'strategy-c') {
      // Attempt neural refinement; fallback to deterministic if model unavailable
      const neuralRes = await this.neuralAdapter.refine(cue.originalText, originalText, budget.targetSyllableBudget);
      if (neuralRes.strategyUsed === 'neural' && neuralRes.text !== originalText) {
        candidateText = neuralRes.text;
        chosenStrategy = 'strategy-c';
      } else {
        candidateText = this.applyDeterministicRefinement(originalText, budget.targetSyllableBudget);
        chosenStrategy = 'strategy-b';
      }
    }

    // Pass through SemanticSafetyGate
    const safetyResult = SemanticSafetyGate.validate(cue.originalText, originalText, candidateText);

    // Count syllable delta
    const origSyllables = budget.estimatedCurrentSyllables;
    const candSyllables = DurationBudgetEstimator.countTurkishSyllables(candidateText);
    const syllablesSaved = origSyllables - candSyllables;

    // Reject candidate if safety checks failed or if no syllables were saved
    if (!safetyResult.isValid || syllablesSaved <= 0) {
      return {
        text: originalText,
        originalText,
        strategyUsed: 'strategy-a', // Fallback to baseline
        budget,
        safetyResult,
        syllablesSaved: 0,
        durationReductionPct: 0,
        latencyMs: performance.now() - t0,
        isModified: false,
      };
    }

    const durationReductionPct = Number(((syllablesSaved / origSyllables) * 100).toFixed(1));

    return {
      text: candidateText,
      originalText,
      strategyUsed: chosenStrategy,
      budget,
      safetyResult,
      syllablesSaved,
      durationReductionPct,
      latencyMs: performance.now() - t0,
      isModified: true,
    };
  }

  /**
   * Strategy B: Conservative deterministic linguistic reductions
   * Applied in priority order of linguistic safety
   */
  applyDeterministicRefinement(text: string, targetSyllableBudget: number): string {
    if (!text || text.trim().length === 0) return text;

    let res = text;

    // 1. Redundant fillers and modal adverbs (zero semantic impact)
    res = res
      .replace(/(?<![\p{L}\p{N}])bir şekilde(?![\p{L}\p{N}])/giu, '')
      .replace(/(?<![\p{L}\p{N}])öylece(?![\p{L}\p{N}])/giu, '')
      .replace(/(?<![\p{L}\p{N}])açıkçası(?![\p{L}\p{N}])/giu, '')
      .replace(/(?<![\p{L}\p{N}])genel olarak(?![\p{L}\p{N}])/giu, 'genelde');

    // 2. Verbose temporal adverbs to concise equivalents
    res = res
      .replace(/(?<![\p{L}\p{N}])[şs]u anda(?![\p{L}\p{N}])/giu, 'şimdi')
      .replace(/(?<![\p{L}\p{N}])bu esnada(?![\p{L}\p{N}])/giu, 'o sırada')
      .replace(/(?<![\p{L}\p{N}])hemen ardından(?![\p{L}\p{N}])/giu, 'ardından');

    // 3. Conjunction & transition consolidation
    res = res
      .replace(/(?<![\p{L}\p{N}])bununla birlikte(?![\p{L}\p{N}])/giu, 'ancak')
      .replace(/(?<![\p{L}\p{N}])buna ek olarak(?![\p{L}\p{N}])/giu, 'ayrıca')
      .replace(/(?<![\p{L}\p{N}])bundan dolayı(?![\p{L}\p{N}])/giu, 'bu nedenle')
      .replace(/(?<![\p{L}\p{N}])ilk olarak(?![\p{L}\p{N}])/giu, 'önce')
      .replace(/(?<![\p{L}\p{N}])sonuç olarak(?![\p{L}\p{N}])/giu, 'özetle');

    // 4. Reflexives & clitic consolidation
    res = res
      .replace(/(?<![\p{L}\p{N}])gerçekten de(?![\p{L}\p{N}])/giu, 'gerçekten')
      .replace(/(?<![\p{L}\p{N}])kendi kendine(?![\p{L}\p{N}])/giu, 'kendisi');

    // 5. Periphrastic verb contractions (reduces auxiliary syllables)
    res = res
      .replace(/(?<![\p{L}\p{N}])yardımcı olmak(?![\p{L}\p{N}])/giu, 'yardım etmek')
      .replace(/(?<![\p{L}\p{N}])tercih etmekteyiz(?![\p{L}\p{N}])/giu, 'seçiyoruz')
      .replace(/(?<![\p{L}\p{N}])inceleme yapmak(?![\p{L}\p{N}])/giu, 'incelemek')
      .replace(/(?<![\p{L}\p{N}])gerçekleştirilmektedir(?![\p{L}\p{N}])/giu, 'yapılmaktadır');

    // Clean up extra whitespace and punctuation spacing
    res = res
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1')
      .trim();

    return res;
  }
}
