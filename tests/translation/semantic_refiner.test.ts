import { describe, it, expect } from 'vitest';
import { SemanticRefiner } from '../../src/translation/SemanticRefiner';
import { SubtitleCue } from '../../src/core/types';

describe('SemanticRefiner', () => {
  const refiner = new SemanticRefiner();

  it('Strategy A: retains original translation unchanged', async () => {
    const cue: SubtitleCue = {
      id: 'cue-1',
      index: 0,
      startTime: 0.0,
      endTime: 1.5,
      duration: 1.5,
      originalText: 'Right now, we are waiting.',
      turkishText: 'Şu anda bir şekilde beklemekteyiz.',
      speakerId: 'speaker-a',
    };

    const res = await refiner.refine(cue, 'strategy-a', 2.8, 1.5);
    expect(res.strategyUsed).toBe('strategy-a');
    expect(res.text).toBe(cue.turkishText);
    expect(res.isModified).toBe(false);
  });

  it('Strategy B: shortens redundant phrasing while maintaining semantic integrity', async () => {
    const cue: SubtitleCue = {
      id: 'cue-2',
      index: 0,
      startTime: 0.0,
      endTime: 1.5,
      duration: 1.5,
      originalText: 'Right now, this process was completed.',
      turkishText: 'Şu anda bu işlem bir şekilde tamamlandı.',
      speakerId: 'speaker-a',
    };

    // TTS takes 3.0s, available window is only 1.5s -> needs refinement!
    const res = await refiner.refine(cue, 'strategy-b', 3.0, 1.5);
    expect(res.strategyUsed).toBe('strategy-b');
    expect(res.isModified).toBe(true);
    expect(res.text).toContain('şimdi bu işlem tamamlandı');
    expect(res.syllablesSaved).toBeGreaterThan(0);
    expect(res.safetyResult.isValid).toBe(true);
  });

  it('falls back to original translation if shortening would violate semantic safety', async () => {
    const cue: SubtitleCue = {
      id: 'cue-3',
      index: 0,
      startTime: 0.0,
      endTime: 1.0,
      duration: 1.0,
      originalText: 'This is not correct.',
      turkishText: 'Bu doğru değil.',
      speakerId: 'speaker-a',
    };

    const res = await refiner.refine(cue, 'strategy-b', 2.5, 1.0);
    // Cannot shorten "Bu doğru değil" without losing "değil" or "doğru" -> fallback to original!
    expect(res.text).toBe('Bu doğru değil.');
  });
});
