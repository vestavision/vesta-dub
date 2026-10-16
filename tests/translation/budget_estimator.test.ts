import { describe, it, expect } from 'vitest';
import { DurationBudgetEstimator } from '../../src/translation/DurationBudgetEstimator';
import { SubtitleCue } from '../../src/core/types';

describe('DurationBudgetEstimator', () => {
  it('counts Turkish syllables accurately based on vowel count', () => {
    expect(DurationBudgetEstimator.countTurkishSyllables('Merhaba dünya')).toBe(5); // e, a, a, ü, a = 5
    expect(DurationBudgetEstimator.countTurkishSyllables('Yapay zeka modeli')).toBe(7); // a, a, e, a, o, e, i = 7
    expect(DurationBudgetEstimator.countTurkishSyllables('')).toBe(0);
  });

  it('calculates duration budget, silence gap, and WSOLA allowance correctly', () => {
    const cue: SubtitleCue = {
      id: 'cue-1',
      index: 0,
      startTime: 10.0,
      endTime: 12.0,
      duration: 2.0,
      originalText: 'This neural network model runs completely locally.',
      turkishText: 'Bu yapay sinir ağı modeli tamamen yerel olarak çalışıyor.',
      speakerId: 'speaker-a',
    };

    // Next cue starts at 13.0 -> silence gap = 1.0s -> availableSilenceGap = 0.8s
    // availableSpeechDuration = 2.0 + 0.8 = 2.8s
    // Actual TTS duration = 3.5s
    const budget = DurationBudgetEstimator.estimateBudget(cue, 3.5, 13.0, 'antalia');

    expect(budget.sourceDuration).toBe(2.0);
    expect(budget.availableSilenceGap).toBeCloseTo(0.8, 1);
    expect(budget.availableSpeechDuration).toBeCloseTo(2.8, 1);
    expect(budget.actualTtsDuration).toBe(3.5);
    expect(budget.safeWsolaAllowance).toBe(1.25);
    expect(budget.durationAfterWsola).toBeCloseTo(2.8, 1);
    expect(budget.targetRefinedDuration).toBeCloseTo(3.5, 1);
    expect(budget.needsRefinement).toBe(false); // 2.8 after WSOLA fits in 2.8 available
  });

  it('flags needsRefinement when speech exceeds window even after WSOLA', () => {
    const cue: SubtitleCue = {
      id: 'cue-2',
      index: 0,
      startTime: 10.0,
      endTime: 11.5,
      duration: 1.5,
      originalText: 'Dense lecture statement.',
      turkishText: 'Çok katmanlı sinirsel temsiller üzerindeki gradyan geri yayılım dinamikleri.',
      speakerId: 'speaker-a',
    };

    // Next cue starts immediately at 11.5 (gap = 0)
    // TTS duration = 4.0s. After 1.25x WSOLA -> 3.2s. Window = 1.5s -> overflow = 1.7s!
    const budget = DurationBudgetEstimator.estimateBudget(cue, 4.0, 11.5, 'antalia');

    expect(budget.needsRefinement).toBe(true);
    expect(budget.remainingUnresolvedOverflow).toBeGreaterThan(1.5);
    expect(budget.targetSyllableBudget).toBeLessThan(budget.estimatedCurrentSyllables);
  });
});
