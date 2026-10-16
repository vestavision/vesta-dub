import { describe, it, expect } from 'vitest';
import { AdaptiveSyncEngine } from '../src/audio/AdaptiveSyncEngine';
import { SubtitleCue } from '../src/core/types';

describe('AdaptiveSyncEngine (P2-A Hardened)', () => {
  const engine = new AdaptiveSyncEngine({ maxStretch: 1.25, minStretch: 0.90 });

  it('Strategy 1: selects normal playback when audio duration fits within original slot', () => {
    const cue: SubtitleCue = {
      id: 'cue-0',
      index: 0,
      startTime: 10.0,
      endTime: 13.0,
      duration: 3.0,
      originalText: 'Hello world',
      turkishText: 'Merhaba dünya',
      speakerId: 'speaker-a',
    };

    // Synthesized audio is 2.8s, original slot is 3.0s
    const decision = engine.evaluate(cue, 2.8, 14.0);
    expect(decision.strategy).toBe('normal');
    expect(decision.playbackSpeed).toBe(1.0);
    expect(decision.overflowSec).toBe(0);
  });

  it('Strategy 2: absorbs subsequent silence gap when audio duration exceeds slot but fits in gap', () => {
    const cue: SubtitleCue = {
      id: 'cue-0',
      index: 0,
      startTime: 10.0,
      endTime: 12.0,
      duration: 2.0,
      originalText: 'Short text',
      turkishText: 'Kısa metin fakat biraz daha uzun ses',
      speakerId: 'speaker-a',
    };

    // Next cue starts at 15.0 -> silence gap = 3.0s -> usable availableWindow = 2.0 + min(2.0, 3.0 * 0.8) = 4.0s
    const decision = engine.evaluate(cue, 2.8, 15.0);
    expect(decision.strategy).toBe('gap_absorbed');
    expect(decision.playbackSpeed).toBe(1.0);
    expect(decision.overflowSec).toBe(0);
  });

  it('Strategy 3: applies bounded time stretching when audio exceeds available window up to maxStretch', () => {
    const cue: SubtitleCue = {
      id: 'cue-0',
      index: 0,
      startTime: 10.0,
      endTime: 12.0,
      duration: 2.0,
      originalText: 'Fast speech',
      turkishText: 'Hızlı konuşulan bir cümle',
      speakerId: 'speaker-a',
    };

    const decision = engine.evaluate(cue, 2.8, 12.5);
    expect(decision.strategy).toBe('time_stretched');
    expect(decision.playbackSpeed).toBeCloseTo(1.17, 1);
    expect(decision.playbackSpeed).toBeLessThanOrEqual(1.25);
    expect(decision.overflowSec).toBe(0);
  });

  it('Strategy 4: suggests safe concise phrasing when required speed exceeds maxStretch', () => {
    const cue: SubtitleCue = {
      id: 'cue-0',
      index: 0,
      startTime: 10.0,
      endTime: 11.5,
      duration: 1.5,
      originalText: 'Long phrase',
      turkishText: 'Şu anda bu işlem tamamlandı',
      speakerId: 'speaker-a',
    };

    const decision = engine.evaluate(cue, 2.7, 11.5);
    expect(decision.strategy).toBe('concise_resynthesized');
    expect(decision.playbackSpeed).toBe(1.25);
    expect(decision.conciseText).toBeDefined();
    expect(decision.conciseText).toContain('şimdi');
  });

  it('Strategy 5: explicitly marks unresolved overflow compromise without silent truncation', () => {
    const cue: SubtitleCue = {
      id: 'cue-0',
      index: 0,
      startTime: 10.0,
      endTime: 11.0,
      duration: 1.0,
      originalText: 'Unshortenable',
      turkishText: 'Özgün ve yalın anlatım',
      speakerId: 'speaker-a',
    };

    const decision = engine.evaluate(cue, 2.5, 11.0);
    expect(decision.strategy).toBe('unresolved_overflow_compromise');
    expect(decision.playbackSpeed).toBe(1.25);
    expect(decision.isCompromised).toBe(true);
    expect(decision.compromiseSec).toBeGreaterThan(0);
  });

  it('Information Preservation: strictly prevents dropping negations and numbers', () => {
    // Negation test
    const negationText = 'Bu sistem kesinlikle çalışmıyor ve uygun değil.';
    const resNeg = engine.suggestSafeConcisePhonology(negationText);
    if (resNeg) {
      expect(resNeg.toLowerCase()).toContain('değil');
    }

    // Number & currency test
    const numberText = 'Toplam maliyet 1.250 TL olup %18 KDV uygulanmıştır.';
    const resNum = engine.suggestSafeConcisePhonology(numberText);
    if (resNum) {
      expect(resNum).toContain('1.250');
      expect(resNum).toContain('TL');
      expect(resNum).toContain('%18');
    }
  });
});
