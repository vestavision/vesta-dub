/**
 * AudioDSP
 * High-performance digital signal processing module for Vesta Dub.
 * Features:
 * 1. Pitch-Preserving Time-Scale Modification (WSOLA)
 * 2. Fundamental Frequency (F0) Pitch Estimation via Normalized Autocorrelation & Parabolic Interpolation
 * 3. Loudness Balancing & Soft-Knee Peak Limiting (Zero Clipping)
 */

export interface GainStageResult {
  samples: Float32Array;
  peakBefore: number;
  peakAfter: number;
  rmsBefore: number;
  rmsAfter: number;
  clippedSamplesBefore: number;
  clippedSamplesAfter: number;
}

export class AudioDSP {
  /**
   * WSOLA (Waveform Similarity Overlap-Add) Time-Scale Modification
   * Preserves pitch while changing playback speed/duration.
   */
  static timeStretch(
    input: Float32Array,
    sampleRate: number,
    speedFactor: number
  ): Float32Array {
    if (speedFactor <= 0) throw new Error('Speed factor must be positive');
    if (Math.abs(speedFactor - 1.0) < 0.001 || input.length === 0) {
      return new Float32Array(input);
    }

    const winSize = Math.round(sampleRate * 0.025); // ~25 ms window
    const synHop = Math.round(winSize / 2);
    const anaHop = Math.round(synHop * speedFactor);
    const maxDelta = Math.round(winSize / 2);

    const window = new Float32Array(winSize);
    for (let i = 0; i < winSize; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winSize - 1)));
    }

    const outLen = Math.ceil(input.length / speedFactor) + winSize;
    const output = new Float32Array(outLen);
    const weight = new Float32Array(outLen);

    for (let i = 0; i < winSize && i < input.length; i++) {
      output[i] += input[i] * window[i];
      weight[i] += window[i];
    }

    let synPos = synHop;
    let anaPos = anaHop;
    let prevOptimalPos = 0;

    while (anaPos + winSize + maxDelta < input.length) {
      const naturalRefPos = prevOptimalPos + synHop;
      let bestDelta = 0;
      let maxCorr = -Infinity;

      for (let delta = -maxDelta; delta <= maxDelta; delta++) {
        const candPos = anaPos + delta;
        if (candPos < 0 || candPos + winSize >= input.length) continue;

        let dot = 0;
        let e1 = 0;
        let e2 = 0;
        for (let i = 0; i < winSize; i++) {
          const sCand = input[candPos + i];
          const sRef = input[naturalRefPos + i];
          dot += sCand * sRef;
          e1 += sCand * sCand;
          e2 += sRef * sRef;
        }

        const norm = Math.sqrt(e1 * e2 + 1e-9);
        const corr = dot / norm;
        if (corr > maxCorr) {
          maxCorr = corr;
          bestDelta = delta;
        }
      }

      const optimalPos = anaPos + bestDelta;
      prevOptimalPos = optimalPos;

      for (let i = 0; i < winSize; i++) {
        const idx = synPos + i;
        output[idx] += input[optimalPos + i] * window[i];
        weight[idx] += window[i];
      }

      synPos += synHop;
      anaPos += anaHop;
    }

    const res = new Float32Array(synPos);
    for (let i = 0; i < synPos; i++) {
      res[i] = weight[i] > 1e-4 ? output[i] / weight[i] : output[i];
    }
    return res;
  }

  /**
   * Fundamental Frequency (F0) Pitch Estimation via Autocorrelation & Parabolic Interpolation
   */
  static estimatePitch(
    samples: Float32Array,
    sampleRate: number,
    minFreq = 70,
    maxFreq = 700
  ): number {
    const minPeriod = Math.floor(sampleRate / maxFreq);
    const maxPeriod = Math.ceil(sampleRate / minFreq);

    const len = samples.length;
    if (len < maxPeriod * 2) return 0;

    const windowLen = Math.min(len - maxPeriod, Math.floor(sampleRate * 0.05));
    let energy0 = 0;
    for (let i = 0; i < windowLen; i++) energy0 += samples[i] * samples[i];
    if (energy0 < 1e-6) return 0;

    let bestLag = -1;
    let maxCorr = -1;
    const corrs: number[] = [];

    for (let lag = minPeriod; lag <= maxPeriod; lag++) {
      let dot = 0;
      let energyLag = 0;
      for (let i = 0; i < windowLen; i++) {
        const s0 = samples[i];
        const sLag = samples[i + lag];
        dot += s0 * sLag;
        energyLag += sLag * sLag;
      }
      const norm = Math.sqrt(energy0 * energyLag + 1e-9);
      const corr = dot / norm;
      corrs[lag] = corr;

      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag > minPeriod && bestLag < maxPeriod && maxCorr > 0.65) {
      const prev = corrs[bestLag - 1] ?? maxCorr;
      const next = corrs[bestLag + 1] ?? maxCorr;
      const denom = prev - 2 * maxCorr + next;
      const delta = Math.abs(denom) > 1e-9 ? 0.5 * (prev - next) / denom : 0;
      return sampleRate / (bestLag + delta);
    }

    if (bestLag > 0 && maxCorr > 0.65) {
      return sampleRate / bestLag;
    }

    return 0;
  }

  /**
   * Convert frequency ratio to cents
   */
  static frequencyToCents(measuredHz: number, referenceHz: number): number {
    if (measuredHz <= 0 || referenceHz <= 0) return 0;
    return 1200 * Math.log2(measuredHz / referenceHz);
  }

  /**
   * Gain Staging, Loudness Balancing & Soft-Knee Peak Limiter
   */
  static gainStageAndLimit(
    input: Float32Array,
    options: {
      targetRms?: number;
      maxPeak?: number;
      provider?: 'antalia' | 'ema' | 'piper';
    } = {}
  ): GainStageResult {
    const targetRms = options.targetRms ?? 0.10;
    const maxPeak = options.maxPeak ?? 0.96; // -0.35 dBFS headroom

    const len = input.length;
    if (len === 0) {
      return {
        samples: new Float32Array(0),
        peakBefore: 0,
        peakAfter: 0,
        rmsBefore: 0,
        rmsAfter: 0,
        clippedSamplesBefore: 0,
        clippedSamplesAfter: 0,
      };
    }

    let sumSq = 0;
    let peakBefore = 0;
    let clippedBefore = 0;

    for (let i = 0; i < len; i++) {
      const abs = Math.abs(input[i]);
      if (abs > peakBefore) peakBefore = abs;
      if (abs >= 0.999) clippedBefore++;
      sumSq += abs * abs;
    }

    const rmsBefore = Math.sqrt(sumSq / len);

    let gain = 1.0;
    if (rmsBefore > 0.005) {
      const idealGain = targetRms / rmsBefore;
      gain = Math.max(0.4, Math.min(2.0, idealGain));
    }

    const threshold = 0.82;
    const output = new Float32Array(len);
    let peakAfter = 0;
    let sumSqAfter = 0;
    let clippedAfter = 0;

    for (let i = 0; i < len; i++) {
      let x = input[i] * gain;
      const absX = Math.abs(x);

      if (absX > threshold) {
        const excess = absX - threshold;
        const compressed = threshold + Math.tanh(excess * 1.5) * (maxPeak - threshold);
        x = (x / absX) * compressed;
      }

      if (x > maxPeak) x = maxPeak;
      else if (x < -maxPeak) x = -maxPeak;

      output[i] = x;
      const absOut = Math.abs(x);
      if (absOut > peakAfter) peakAfter = absOut;
      if (absOut >= 0.999) clippedAfter++;
      sumSqAfter += absOut * absOut;
    }

    const rmsAfter = Math.sqrt(sumSqAfter / len);

    return {
      samples: output,
      peakBefore: Number(peakBefore.toFixed(4)),
      peakAfter: Number(peakAfter.toFixed(4)),
      rmsBefore: Number(rmsBefore.toFixed(4)),
      rmsAfter: Number(rmsAfter.toFixed(4)),
      clippedSamplesBefore: clippedBefore,
      clippedSamplesAfter: clippedAfter,
    };
  }
}
