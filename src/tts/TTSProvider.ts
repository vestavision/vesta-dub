import { SynthesisOptions, SynthesisResult, TTSProviderId } from '../core/types';

export interface TTSProvider {
  readonly id: TTSProviderId;
  readonly name: string;
  readonly sampleRate: number;
  readonly isLoaded: boolean;
  readonly sizeBytes: number;

  /**
   * Load model weights from cache or network
   */
  load(onProgress?: (loaded: number, total: number) => void): Promise<void>;

  /**
   * Synthesize Turkish text to raw PCM Float32 audio
   */
  synthesize(text: string, options?: SynthesisOptions): Promise<SynthesisResult>;

  /**
   * Free memory and release ONNX sessions
   */
  dispose(): Promise<void>;
}
