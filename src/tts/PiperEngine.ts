import { configureOrt } from "./ortConfig";
/**
 * Piper Turkish Neural TTS Engine
 * Variational Inference for Text-to-Speech (VITS) at 22,050 Hz.
 */

import * as ort from 'onnxruntime-web';
import { TurkishPhonemizer, PiperVoiceConfig } from './TurkishPhonemizer';

export const PIPER_SAMPLE_RATE = 22050;

export class PiperEngine {
  private session: ort.InferenceSession;
  private phonemizer: TurkishPhonemizer;
  private config: PiperVoiceConfig;

  constructor(session: ort.InferenceSession, config: PiperVoiceConfig) {
    this.session = session;
    this.config = config;
    this.phonemizer = new TurkishPhonemizer(config.phoneme_id_map);
  }

  static async create(modelBuffer: ArrayBuffer | Uint8Array, config: PiperVoiceConfig): Promise<PiperEngine> {
    configureOrt();
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    };

    const session = await ort.InferenceSession.create(modelBuffer instanceof Uint8Array ? modelBuffer : new Uint8Array(modelBuffer), opts);
    return new PiperEngine(session, config);
  }

  async synthesize(text: string, options: { speed?: number } = {}): Promise<{
    audio: Float32Array;
    duration: number;
    sampleRate: number;
    timings: Record<string, number>;
  }> {
    const t0 = performance.now();
    const timings: Record<string, number> = {};

    // 1. Text to phoneme IDs
    const tPhoneme = performance.now();
    const phonemeIds = this.phonemizer.textToIds(text);
    timings.textMs = performance.now() - tPhoneme;

    const seqLen = phonemeIds.length;
    const inputTensor = new ort.Tensor('int64', BigInt64Array.from(phonemeIds.map(BigInt)), [1, seqLen]);
    const inputLengthsTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(seqLen)]), [1]);

    // Scales
    const noiseScale = this.config.inference?.noise_scale ?? 0.667;
    // Speed control: Piper length_scale is inverse speed (lower is faster)
    const baseLengthScale = this.config.inference?.length_scale ?? 1.0;
    const speedRatio = options.speed && options.speed > 0 ? options.speed : 1.0;
    const lengthScale = baseLengthScale / speedRatio;
    const noiseW = this.config.inference?.noise_w ?? 0.8;

    const scalesTensor = new ort.Tensor('float32', new Float32Array([noiseScale, lengthScale, noiseW]), [3]);

    const feeds: Record<string, ort.Tensor> = {
      input: inputTensor,
      input_lengths: inputLengthsTensor,
      scales: scalesTensor,
    };

    // 2. Inference
    const tInfer = performance.now();
    const results = await this.session.run(feeds);
    timings.inferenceMs = performance.now() - tInfer;

    const outputName = this.session.outputNames[0];
    const outputTensor = results[outputName];
    const rawAudio = outputTensor.data as Float32Array;

    // Clone audio data because tensors might be recycled
    const audio = new Float32Array(rawAudio.length);
    audio.set(rawAudio);

    // Clean up
    inputTensor.dispose();
    inputLengthsTensor.dispose();
    scalesTensor.dispose();
    outputTensor.dispose();

    timings.totalMs = performance.now() - t0;
    const duration = audio.length / PIPER_SAMPLE_RATE;

    return {
      audio,
      duration,
      sampleRate: PIPER_SAMPLE_RATE,
      timings,
    };
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}
