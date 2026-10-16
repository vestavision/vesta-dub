import { configureOrt } from "./ortConfig";
/**
 * Antalia-2 Mini Browser Inference Engine
 * Flow-matching neural Turkish TTS with 48 kHz vocoder output.
 */

import * as ort from 'onnxruntime-web';

export const ANTALIA_SAMPLE_RATE = 48000;
const N_FFT = 2048;
const HOP = 512;
const STACK = 2;
const N_MELS = 128;
const BINS = N_FFT / 2 + 1;
const MAX_DUR = 60;
const SPACE_ID = 3;
const M = N_FFT / 2;

const f32 = Math.fround;

// Precompute Hann window and trigonometric tables
const WINDOW = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));
}

const COS_N = new Float64Array(M);
const SIN_N = new Float64Array(M);
for (let k = 0; k < M; k++) {
  const phi = (2 * Math.PI * k) / N_FFT;
  COS_N[k] = Math.cos(phi);
  SIN_N[k] = Math.sin(phi);
}

const W_TABLE = new Float64Array(2 * M);
for (let k = 0; k < M; k++) {
  const phi = (2 * Math.PI * k) / M;
  W_TABLE[2 * k] = Math.cos(phi);
  W_TABLE[2 * k + 1] = Math.sin(phi);
}

const BIT_REV = new Uint32Array(M);
const BITS = Math.round(Math.log2(M));
for (let i = 0; i < M; i++) {
  let rev = 0;
  for (let j = 0; j < BITS; j++) {
    if ((i >> j) & 1) rev |= 1 << (BITS - 1 - j);
  }
  BIT_REV[i] = rev;
}

function inverseFFT(xr: Float64Array, xi: Float64Array): void {
  for (let i = 0; i < M; i++) {
    const j = BIT_REV[i];
    if (j > i) {
      const tr = xr[i]; xr[i] = xr[j]; xr[j] = tr;
      const ti = xi[i]; xi[i] = xi[j]; xi[j] = ti;
    }
  }
  for (let len = 2; len <= M; len <<= 1) {
    const half = len >> 1;
    const step = M / len;
    for (let start = 0; start < M; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = W_TABLE[2 * k * step];
        const wi = W_TABLE[2 * k * step + 1];
        const a = start + k;
        const b = a + half;
        const tr = xr[b] * wr - xi[b] * wi;
        const ti = xr[b] * wi + xi[b] * wr;
        xr[b] = xr[a] - tr; xi[b] = xi[a] - ti;
        xr[a] += tr; xi[a] += ti;
      }
    }
  }
}

export function istft(re: Float32Array, im: Float32Array, T: number, legacyRotation = false): Float32Array {
  const n = N_FFT + HOP * (T - 1);
  const y = new Float64Array(n);
  const env = new Float64Array(n);
  const zr = new Float64Array(M);
  const zi = new Float64Array(M);
  const fr = new Float32Array(BINS * T);
  const fi = new Float32Array(BINS * T);

  for (let k = 0; k < BINS; k++) {
    const row = k * T;
    for (let t = 0; t < T; t++) {
      fr[t * BINS + k] = re[row + t];
      fi[t * BINS + k] = im[row + t];
    }
  }

  for (let t = 0; t < T; t++) {
    const base = t * BINS;
    for (let k = 0; k < M; k++) {
      const ar = fr[base + k];
      const ai = k === 0 ? 0 : fi[base + k];
      const br = fr[base + M - k];
      const bi = k === 0 ? 0 : -fi[base + M - k];
      const er = ar + br;
      const ei = ai + bi;
      const dr = ar - br;
      const di = ai - bi;
      const or_val = dr * COS_N[k] - di * SIN_N[k];
      const oi_val = dr * SIN_N[k] + di * COS_N[k];
      zr[k] = er - (legacyRotation ? or_val : oi_val);
      zi[k] = ei + (legacyRotation ? oi_val : or_val);
    }
    inverseFFT(zr, zi);
    const off = t * HOP;
    for (let m_idx = 0; m_idx < M; m_idx++) {
      const i = 2 * m_idx;
      const w0 = WINDOW[i];
      const w1 = WINDOW[i + 1];
      y[off + i] += (zr[m_idx] / N_FFT) * w0;
      y[off + i + 1] += (zi[m_idx] / N_FFT) * w1;
      env[off + i] += w0 * w0;
      env[off + i + 1] += w1 * w1;
    }
  }

  const a = N_FFT / 2;
  const len = n - N_FFT;
  const out = new Float32Array(T * HOP);
  for (let i = 0; i < len; i++) {
    const e = env[a + i];
    out[i] = y[a + i] / (e > 1e-11 ? e : 1);
  }
  return out;
}

export class TorchRandn {
  private s: Uint32Array;
  private i: number;

  constructor(seed: number) {
    const s = new Uint32Array(624);
    s[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      s[i] = (Math.imul(1812433253, s[i - 1] ^ (s[i - 1] >>> 30)) + i) >>> 0;
    }
    this.s = s;
    this.i = 624;
  }

  private u32(): number {
    const s = this.s;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (s[k] & 0x80000000) | (s[(k + 1) % 624] & 0x7fffffff);
        s[k] = s[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = s[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  randn(n: number, scale = 1): Float32Array {
    const out = new Float32Array(n);
    const u = new Float32Array(16);
    const sc = f32(scale);
    for (let b = 0; b < n; b += 16) {
      for (let j = 0; j < 16; j++) {
        u[j] = (this.u32() & 0xffffff) * 5.9604644775390625e-8;
      }
      for (let j = 0; j < 8; j++) {
        const r = f32(Math.sqrt(f32(-2 * f32(Math.log(f32(1 - u[j]))))));
        const th = f32(2 * Math.PI * u[j + 8]);
        out[b + j] = f32(f32(r * f32(Math.cos(th))) * sc);
        out[b + j + 8] = f32(f32(r * f32(Math.sin(th))) * sc);
      }
    }
    return out;
  }
}

const roundHalfEven = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

export function durations(logd: Float32Array, ids: number[], speed: number, gemStretch = 1): number[] {
  const L = ids.length;
  const ld = Float32Array.from(logd);
  if (gemStretch !== 1) {
    const g = f32(Math.log(gemStretch));
    for (let j = 2; j < L - 1; j++) {
      if (ids[j] === ids[j - 1] && ids[j] !== SPACE_ID) ld[j] = f32(ld[j] + g);
      else if (ids[j - 1] === SPACE_ID && ids[j] === ids[j - 2]) ld[j - 1] = f32(ld[j - 1] + g);
    }
  }
  const sp = f32(speed);
  const dur = new Array<number>(L);
  for (let j = 0; j < L; j++) {
    dur[j] = Math.min(MAX_DUR, Math.max(1, roundHalfEven(f32(f32(Math.exp(ld[j])) / sp))));
  }
  return dur;
}

export function frameIndex(dur: number[]): BigInt64Array {
  let total = 0;
  for (let i = 0; i < dur.length; i++) total += dur[i];
  if (total % 2 !== 0) total += 1; // round up to multiple of 2

  const idx = new BigInt64Array(total);
  let pos = 0;
  for (let i = 0; i < dur.length; i++) {
    const d = dur[i];
    const val = BigInt(i);
    for (let k = 0; k < d; k++) {
      if (pos < total) idx[pos++] = val;
    }
  }
  while (pos < total) idx[pos++] = BigInt(dur.length - 1);
  return idx;
}

export const ANTALIA_SYMBOLS = [
  '<pad>', '<bos>', '<eos>', ' ', '.', ',', '?', '!', "'", '-', ':', ';',
  'a', 'b', 'c', 'ç', 'd', 'e', 'f', 'g', 'ğ', 'h', 'ı', 'i', 'j', 'k',
  'l', 'm', 'n', 'o', 'ö', 'p', 'q', 'r', 's', 'ş', 't', 'u', 'ü', 'v',
  'w', 'x', 'y', 'z', 'â', 'î', 'û'
];

export class AntaliaEngine {
  private sessions: {
    text: ort.InferenceSession;
    cond: ort.InferenceSession;
    flow: ort.InferenceSession;
    vocoder: ort.InferenceSession;
  };
  private symbolId: Map<string, number>;

  constructor(sessions: {
    text: ort.InferenceSession;
    cond: ort.InferenceSession;
    flow: ort.InferenceSession;
    vocoder: ort.InferenceSession;
  }) {
    this.sessions = sessions;
    this.symbolId = new Map(ANTALIA_SYMBOLS.map((c, i) => [c, i]));
  }

  static async create(buffers: {
    text: ArrayBuffer | Uint8Array;
    cond: ArrayBuffer | Uint8Array;
    flow: ArrayBuffer | Uint8Array;
    vocoder: ArrayBuffer | Uint8Array;
  }): Promise<AntaliaEngine> {
    configureOrt();
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    };

    const [text, cond, flow, vocoder] = await Promise.all([
      ort.InferenceSession.create(buffers.text instanceof Uint8Array ? buffers.text : new Uint8Array(buffers.text), opts),
      ort.InferenceSession.create(buffers.cond instanceof Uint8Array ? buffers.cond : new Uint8Array(buffers.cond), opts),
      ort.InferenceSession.create(buffers.flow instanceof Uint8Array ? buffers.flow : new Uint8Array(buffers.flow), opts),
      ort.InferenceSession.create(buffers.vocoder instanceof Uint8Array ? buffers.vocoder : new Uint8Array(buffers.vocoder), opts),
    ]);

    return new AntaliaEngine({ text, cond, flow, vocoder });
  }

  encode(text: string): number[] {
    const normalized = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
    const ids: number[] = [1]; // BOS
    for (const c of normalized) {
      const id = this.symbolId.get(c);
      if (id !== undefined && id > 2) {
        ids.push(id);
      }
    }
    ids.push(2); // EOS
    return ids;
  }

  async synthesize(text: string, options: { steps?: number; speed?: number; cfg?: number; seed?: number; diagnostic?: (re: Float32Array, im: Float32Array, frames: number) => void } = {}): Promise<{
    audio: Float32Array;
    duration: number;
    sampleRate: number;
    timings: Record<string, number>;
  }> {
    const steps = options.steps ?? 8;
    const speed = options.speed ?? 1.0;
    const cfg = options.cfg ?? 2.0;
    const seed = options.seed ?? 42;

    const timings: Record<string, number> = {};
    const t0 = performance.now();

    // 1. Text encoding
    const prefix = 'ee, ';
    const suffix = ' ee.';
    const ids = this.encode(prefix + text + suffix);
    const L = ids.length;
    const nPre = this.encode(prefix).length - 2;
    const nSuf = this.encode(suffix).length - 2;

    // 2. Text model
    const textTensor = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, L]);
    const r1 = await this.sessions.text.run({ ids: textTensor });
    const dur = durations(r1.logd.data as Float32Array, ids, speed, 1.3);
    timings.textMs = performance.now() - t0;

    // 3. Condition model
    const tCond = performance.now();
    const idx = frameIndex(dur);
    const T = idx.length;
    const N = T / STACK;
    const idxTensor = new ort.Tensor('int64', idx, [1, T]);
    const r2 = await this.sessions.cond.run({ h: r1.h, idx: idxTensor });
    timings.condMs = performance.now() - tCond;

    // 4. Flow matching
    const tFlow = performance.now();
    const rng = new TorchRandn(seed);
    let x: ort.Tensor = new ort.Tensor('float32', rng.randn(N * N_MELS * STACK, 0.6), [1, N, N_MELS * STACK]);
    const dtv = 1 / steps;
    const dt = new ort.Tensor('float32', new Float32Array([dtv]), [1]);
    const cfgT = new ort.Tensor('float32', new Float32Array([cfg]), [1]);

    for (let i = 0; i < steps; i++) {
      const timeTensor = new ort.Tensor('float32', new Float32Array([i * dtv]), [1]);
      const r = await this.sessions.flow.run({
        x,
        ctok: r2.ctok,
        cnull: r2.cnull,
        t: timeTensor,
        dt,
        cfg: cfgT,
      });
      timeTensor.dispose();
      x.dispose();
      x = r.x_next as ort.Tensor;
    }
    timings.flowMs = performance.now() - tFlow;

    // 5. Vocoder
    const tVoc = performance.now();
    const r4 = await this.sessions.vocoder.run({ z: x });
    timings.vocoderMs = performance.now() - tVoc;

    // 6. ISTFT
    const tIstft = performance.now();
    options.diagnostic?.(new Float32Array(r4.re.data as Float32Array), new Float32Array(r4.im.data as Float32Array), T);
    let audio = istft(r4.re.data as Float32Array, r4.im.data as Float32Array, T);
    timings.istftMs = performance.now() - tIstft;

    // Cut prefix and suffix away
    let cum = 0, a = 0, b = 0;
    for (let j = 0; j < L; j++) {
      cum += dur[j];
      if (j === nPre) a = cum;
      if (j === L - 2 - nSuf) b = cum;
    }
    audio = audio.slice(a * HOP, b * HOP);

    // Apply smooth raised-cosine fade
    const fade = Math.floor((12 * ANTALIA_SAMPLE_RATE) / 1000);
    if (audio.length > 2 * fade) {
      for (let i = 0; i < fade; i++) audio[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / fade));
      const off = audio.length - fade;
      for (let i = 0; i < fade; i++) audio[off + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / fade));
    }

    // Clean up tensors
    for (const k of [r1.h, r1.logd, r2.ctok, r2.cnull, x, r4.mel, r4.re, r4.im, textTensor, idxTensor, dt, cfgT]) {
      k.dispose();
    }

    timings.totalMs = performance.now() - t0;
    return {
      audio,
      duration: audio.length / ANTALIA_SAMPLE_RATE,
      sampleRate: ANTALIA_SAMPLE_RATE,
      timings,
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.sessions.text.release(),
      this.sessions.cond.release(),
      this.sessions.flow.release(),
      this.sessions.vocoder.release(),
    ]);
  }
}
