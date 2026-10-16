import { describe, it, expect } from 'vitest';
import {
  durations,
  frameIndex,
  istft,
  ANTALIA_SYMBOLS,
  ANTALIA_SAMPLE_RATE,
} from '../src/tts/AntaliaEngine';

describe('AntaliaEngine utilities', () => {
  it('should correctly expand durations from logd values', () => {
    // 3 symbols, logd = [0, 0, 0] -> exp(0) = 1
    const logd = new Float32Array([0, 0, 0]);
    const ids = [1, 14, 2]; // BOS, 'a', EOS
    const dur = durations(logd, ids, 1.0, 1.0);

    expect(dur).toHaveLength(3);
    expect(dur[0]).toBeGreaterThanOrEqual(1);
    expect(dur[1]).toBeGreaterThanOrEqual(1);
    expect(dur[2]).toBeGreaterThanOrEqual(1);
  });

  it('should generate valid frameIndex array rounded up to a multiple of 2', () => {
    const dur = [2, 3, 2]; // sum = 7 -> rounded to 8
    const idx = frameIndex(dur);

    expect(idx.length % 2).toBe(0);
    expect(idx.length).toBe(8);
    expect(idx[0]).toBe(0n);
    expect(idx[1]).toBe(0n);
    expect(idx[2]).toBe(1n);
  });

  it('should execute ISTFT without throwing NaN and return valid PCM length', () => {
    const T = 4; // 4 frames
    const bins = 2048 / 2 + 1; // 1025
    const re = new Float32Array(bins * T);
    const im = new Float32Array(bins * T);

    // Put a small non-zero component in bin 10
    for (let t = 0; t < T; t++) {
      re[10 * T + t] = 0.5;
    }

    const pcm = istft(re, im, T);
    expect(pcm).toHaveLength(T * 512);
    expect(Number.isNaN(pcm[0])).toBe(false);
  });

  it('should define standard symbols matching Antalia-2 vocabulary', () => {
    expect(ANTALIA_SYMBOLS[0]).toBe('<pad>');
    expect(ANTALIA_SYMBOLS[1]).toBe('<bos>');
    expect(ANTALIA_SYMBOLS[2]).toBe('<eos>');
    expect(ANTALIA_SYMBOLS[3]).toBe(' ');
    expect(ANTALIA_SYMBOLS).toContain('ç');
    expect(ANTALIA_SYMBOLS).toContain('ğ');
    expect(ANTALIA_SYMBOLS).toContain('ı');
    expect(ANTALIA_SYMBOLS).toContain('ş');
    expect(ANTALIA_SAMPLE_RATE).toBe(48000);
  });
});
