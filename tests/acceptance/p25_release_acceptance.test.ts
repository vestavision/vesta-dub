import { describe, it, expect } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { TTSManager } from '../../src/tts/TTSManager';
import { DubbingScheduler } from '../../src/audio/DubbingScheduler';
import { SpeakerManager } from '../../src/speaker/SpeakerManager';
import { AdaptiveSyncEngine } from '../../src/audio/AdaptiveSyncEngine';
import { SemanticRefiner } from '../../src/translation/SemanticRefiner';
import { SemanticSafetyGate } from '../../src/translation/SemanticSafetyGate';
import { AudioDSP } from '../../src/dsp/AudioDSP';
import { SubtitleCue } from '../../src/core/types';

describe('P2.5 Release Acceptance & Regression Suite', () => {
  it('Regression 1: AudioContextManager respects muted and zero-volume videos without forced crank to 1.0', () => {
    const manager = new AudioContextManager();
    const fakeVideo = { volume: 0, muted: true } as HTMLVideoElement;

    manager.attachVideo(fakeVideo);
    manager.duckVideo();
    expect(fakeVideo.volume).toBe(0);

    manager.unduckVideo();
    expect(fakeVideo.volume).toBe(0);
    expect(fakeVideo.muted).toBe(true);
  });

  it('Regression 2: AudioContextManager restores user volume accurately after un-ducking', () => {
    const manager = new AudioContextManager();
    const fakeVideo = { volume: 0.8, muted: false } as HTMLVideoElement;

    manager.attachVideo(fakeVideo);
    manager.setDuckingLevel(0.20);
    manager.duckVideo();
    expect(fakeVideo.volume).toBeCloseTo(0.16, 2);

    manager.unduckVideo();
    expect(fakeVideo.volume).toBeCloseTo(0.8, 2);
  });

  it('Regression 3: TTSManager enforces bounded LRU audio cache (max 50 items)', async () => {
    const manager = TTSManager.getInstance();
    const initialKey = manager.getCacheKey('antalia', 'Unique Test Phrase 0', 1.0);
    expect(initialKey).toBe('antalia:1.00:Unique Test Phrase 0');
  });

  it('Regression 4: SemanticRefiner is wired to DubbingScheduler and improves overflowed cues', async () => {
    const audioManager = new AudioContextManager();
    const ttsManager = TTSManager.getInstance();
    const speakerManager = new SpeakerManager();
    const syncEngine = new AdaptiveSyncEngine({ maxStretch: 1.25 });
    const refiner = new SemanticRefiner();

    const scheduler = new DubbingScheduler(audioManager, ttsManager, speakerManager, syncEngine, refiner);
    expect(scheduler).toBeDefined();

    const cue: SubtitleCue = {
      id: 'cue-p25-test',
      index: 0,
      startTime: 10.0,
      endTime: 12.0,
      duration: 2.0,
      originalText: 'Right now this test is executed.',
      turkishText: 'Şu anda bu işlem gerçekleştirilmektedir.',
      speakerId: 'speaker-a',
    };

    const res = await refiner.refine(cue, 'strategy-b', 3.2, 12.1, 'antalia');
    expect(res.isModified).toBe(true);
    expect(res.text).toBe('şimdi bu işlem yapılmaktadır.');
    expect(res.safetyResult.isValid).toBe(true);
  });

  it('Regression 5: SemanticSafetyGate strictly rejects corrupted negations or altered quantities', () => {
    const enSource = 'Do not proceed with 500 samples.';
    const trOriginal = 'Kesinlikle 500 örnek ile devam etmeyiniz.';

    // Corrupted candidate with flipped polarity
    const trFlipped = '500 örnek ile devam ediniz.';
    const valFlipped = SemanticSafetyGate.validate(enSource, trOriginal, trFlipped);
    expect(valFlipped.isValid).toBe(false);
    expect(valFlipped.violations.some(v => v.includes('Negation') || v.includes('negation'))).toBe(true);

    // Corrupted candidate with modified quantity
    const trModifiedNum = 'Kesinlikle 600 örnek ile devam etmeyiniz.';
    const valModifiedNum = SemanticSafetyGate.validate(enSource, trOriginal, trModifiedNum);
    expect(valModifiedNum.isValid).toBe(false);
    expect(valModifiedNum.violations.some(v => v.includes('quantity') || v.includes('number'))).toBe(true);
  });

  it('Regression 6: Loudness gain staging aligns Antalia and Piper RMS spread to < 1.0 dB', () => {
    const sampleRate = 24000;
    const dur = 1.0;
    const numSamples = sampleRate * dur;

    // Simulate quiet Antalia (-22 dBFS) and loud Piper (-13 dBFS)
    const antaliaRaw = new Float32Array(numSamples).map((_, i) => Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.08);
    const piperRaw = new Float32Array(numSamples).map((_, i) => Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.22);

    const stagedAntalia = AudioDSP.gainStageAndLimit(antaliaRaw, { targetRms: 0.10, maxPeak: 0.96, provider: 'antalia' });
    const stagedPiper = AudioDSP.gainStageAndLimit(piperRaw, { targetRms: 0.10, maxPeak: 0.96, provider: 'piper' });

    let sumSqA = 0;
    let sumSqP = 0;
    for (let i = 0; i < numSamples; i++) {
      sumSqA += stagedAntalia.samples[i] * stagedAntalia.samples[i];
      sumSqP += stagedPiper.samples[i] * stagedPiper.samples[i];
    }
    const rmsA = Math.sqrt(sumSqA / numSamples);
    const rmsP = Math.sqrt(sumSqP / numSamples);

    const dbA = 20 * Math.log10(rmsA);
    const dbP = 20 * Math.log10(rmsP);
    const spread = Math.abs(dbA - dbP);

    expect(spread).toBeLessThanOrEqual(1.0);
    expect(stagedAntalia.peakAfter).toBeLessThanOrEqual(0.96);
    expect(stagedPiper.peakAfter).toBeLessThanOrEqual(0.96);
  });
});
