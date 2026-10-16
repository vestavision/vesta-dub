import { describe, it, expect } from 'vitest';
import { AudioDSP } from '../../src/dsp/AudioDSP';

describe('AudioDSP - Pitch Preservation & Gain Staging', () => {
  const sampleRate = 48000;
  const f0 = 440.0; // Reference A4 note
  const durationSec = 1.0;
  const numSamples = Math.round(sampleRate * durationSec);

  // Generate reference pure tone (440 Hz)
  const refSine = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    refSine[i] = 0.8 * Math.sin((2 * Math.PI * f0 * i) / sampleRate);
  }

  it('measures reference pitch accurately (440 Hz ± 1 Hz)', () => {
    const measuredHz = AudioDSP.estimatePitch(refSine, sampleRate);
    expect(measuredHz).toBeCloseTo(f0, 0);
  });

  const testFactors = [1.05, 1.10, 1.15, 1.20, 1.25];

  testFactors.forEach((factor) => {
    it(`preserves pitch within ±25 cents at ${factor}x speed via WSOLA`, () => {
      // 1. Time-stretch using WSOLA
      const stretched = AudioDSP.timeStretch(refSine, sampleRate, factor);

      // Verify duration was compressed according to factor (within 10%)
      const expectedLen = Math.round(numSamples / factor);
      expect(stretched.length).toBeGreaterThan(expectedLen * 0.9);
      expect(stretched.length).toBeLessThan(expectedLen * 1.1);

      // 2. Measure fundamental frequency of stretched signal
      const pitchStretchedHz = AudioDSP.estimatePitch(stretched, sampleRate);
      expect(pitchStretchedHz).toBeGreaterThan(0);

      // 3. Compute pitch deviation in cents
      const deviationCents = AudioDSP.frequencyToCents(pitchStretchedHz, f0);

      console.log(`[WSOLA] Factor ${factor}x -> F0 = ${pitchStretchedHz.toFixed(1)} Hz | Pitch Deviation = ${deviationCents.toFixed(1)} cents`);

      // Acceptance Target: Pitch deviation within ±25 cents
      expect(Math.abs(deviationCents)).toBeLessThan(25.0);
    });

    it(`demonstrates that naive resampling (playbackRate) fails pitch preservation at ${factor}x`, () => {
      // Theoretical pitch shift of naive playbackRate
      const naiveShiftCents = 1200 * Math.log2(factor);
      expect(naiveShiftCents).toBeGreaterThan(50); // e.g. 1.05x is +84 cents, 1.25x is +386 cents
    });
  });

  it('eliminates clipping on signals exceeding 1.0 peak amplitude', () => {
    // Generate hot signal with peaks up to 1.15 (like Antalia raw output)
    const hotSignal = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      hotSignal[i] = 1.15 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    }

    const res = AudioDSP.gainStageAndLimit(hotSignal, { targetRms: 0.10, maxPeak: 0.96 });

    expect(res.peakBefore).toBeGreaterThan(1.0);
    expect(res.peakAfter).toBeLessThanOrEqual(0.96);
    expect(res.clippedSamplesAfter).toBe(0);
  });

  it('balances RMS loudness between quiet (Antalia) and loud (Piper) inputs', () => {
    // Quiet input (RMS ~0.065)
    const quiet = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      quiet[i] = 0.09 * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
    }

    // Loud input (RMS ~0.20)
    const loud = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      loud[i] = 0.28 * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
    }

    const resQuiet = AudioDSP.gainStageAndLimit(quiet, { targetRms: 0.10 });
    const resLoud = AudioDSP.gainStageAndLimit(loud, { targetRms: 0.10 });

    // Both should be close to 0.10 RMS
    expect(resQuiet.rmsAfter).toBeGreaterThan(resQuiet.rmsBefore);
    expect(resLoud.rmsAfter).toBeLessThan(resLoud.rmsBefore);
    expect(Math.abs(resQuiet.rmsAfter - resLoud.rmsAfter)).toBeLessThan(0.04);
  });
});
