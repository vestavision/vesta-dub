import { SynthesisOptions, SynthesisResult, TTSProviderId } from '../core/types';
import { TTSProvider } from './TTSProvider';
import { AntaliaEngine, ANTALIA_SAMPLE_RATE } from './AntaliaEngine';
import { ModelStorage } from './ModelStorage';

export class AntaliaProvider implements TTSProvider {
  readonly id: TTSProviderId = 'antalia';
  readonly name = 'Antalia-2 Mini (48 kHz Erkek)';
  readonly sampleRate = ANTALIA_SAMPLE_RATE;
  readonly sizeBytes = 15_493_500; // ~14.8 MB

  private engine: AntaliaEngine | null = null;
  private loadingPromise: Promise<void> | null = null;

  get isLoaded(): boolean {
    return this.engine !== null;
  }

  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.engine) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const files = ['text.fp16.onnx', 'cond.fp16.onnx', 'flow.fp16.onnx', 'vocoder.fp16.onnx'];
      const fileSizes = [2_058_376, 315_081, 5_221_397, 7_898_746];
      const totalExpected = fileSizes.reduce((a, b) => a + b, 0);
      const loadedPerFile = [0, 0, 0, 0];

      const reportProgress = () => {
        if (!onProgress) return;
        const sum = loadedPerFile.reduce((a, b) => a + b, 0);
        onProgress(sum, totalExpected);
      };

      const [text, cond, flow, vocoder] = await Promise.all([
        ModelStorage.fetchCached('antalia/text.fp16.onnx', '', (l) => {
          loadedPerFile[0] = l;
          reportProgress();
        }),
        ModelStorage.fetchCached('antalia/cond.fp16.onnx', '', (l) => {
          loadedPerFile[1] = l;
          reportProgress();
        }),
        ModelStorage.fetchCached('antalia/flow.fp16.onnx', '', (l) => {
          loadedPerFile[2] = l;
          reportProgress();
        }),
        ModelStorage.fetchCached('antalia/vocoder.fp16.onnx', '', (l) => {
          loadedPerFile[3] = l;
          reportProgress();
        }),
      ]);

      this.engine = await AntaliaEngine.create({ text, cond, flow, vocoder });
    })();

    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async synthesize(text: string, options: SynthesisOptions = {}): Promise<SynthesisResult> {
    if (!this.engine) {
      await this.load();
    }
    if (!this.engine) {
      throw new Error('Antalia motoru başlatılamadı.');
    }

    const res = await this.engine.synthesize(text, {
      speed: options.speed,
      steps: options.steps ?? 8,
    });

    return {
      audio: res.audio,
      sampleRate: this.sampleRate,
      duration: res.duration,
      timings: res.timings,
    };
  }

  async dispose(): Promise<void> {
    if (this.engine) {
      await this.engine.dispose();
      this.engine = null;
    }
  }
}
