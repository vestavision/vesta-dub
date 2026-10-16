import { describe, it, expect } from 'vitest';
import { SpeakerManager } from '../src/speaker/SpeakerManager';
import { SubtitleCue } from '../src/core/types';

describe('SpeakerManager', () => {
  it('should initialize with Speaker A (Antalia) and Speaker B (EMA)', () => {
    const manager = new SpeakerManager();
    const slotA = manager.getSlot('speaker-a');
    const slotB = manager.getSlot('speaker-b');

    expect(slotA.providerId).toBe('antalia');
    expect(slotB.providerId).toBe('ema-lightning');
    expect(slotA.speed).toBe(1.0);
  });

  it('should allow reassigning TTS provider and speed per speaker slot', () => {
    const manager = new SpeakerManager();
    manager.assignProvider('speaker-a', 'ema-lightning');
    manager.setSpeed('speaker-a', 1.25);

    const slotA = manager.getSlot('speaker-a');
    expect(slotA.providerId).toBe('ema-lightning');
    expect(slotA.speed).toBe(1.25);
  });

  it('migrates a stored Piper selection to a shipped voice', () => {
    const manager = new SpeakerManager();
    manager.updateSlot('speaker-a', { providerId: 'piper-fahrettin' });
    manager.updateSlot('speaker-b', { providerId: 'piper-fahrettin' });
    expect(manager.getSlot('speaker-a').providerId).toBe('antalia');
    expect(manager.getSlot('speaker-b').providerId).toBe('ema-lightning');
  });

  it('should return default speaker when unassigned', () => {
    const manager = new SpeakerManager();
    expect(manager.getProviderForSpeaker(undefined)).toBe('antalia');
    expect(manager.getProviderForSpeaker('non-existent')).toBe('antalia');
  });

  it('should assign a speaker identity to a specific cue', () => {
    const manager = new SpeakerManager();
    const cues: SubtitleCue[] = [
      {
        id: 'cue-0',
        index: 0,
        startTime: 0,
        endTime: 2,
        duration: 2,
        originalText: 'Hello',
        turkishText: 'Merhaba',
        speakerId: 'speaker-a',
      },
      {
        id: 'cue-1',
        index: 1,
        startTime: 2,
        endTime: 4,
        duration: 2,
        originalText: 'How are you?',
        turkishText: 'Nasılsınız?',
        speakerId: 'speaker-a',
      },
    ];

    const updated = manager.assignCueSpeaker(cues, 1, 'speaker-b');
    expect(updated[0].speakerId).toBe('speaker-a');
    expect(updated[1].speakerId).toBe('speaker-b');
  });

  it('should alternate speakers for testing when requested', () => {
    const manager = new SpeakerManager();
    const cues: SubtitleCue[] = [
      { id: 'cue-0', index: 0, startTime: 0, endTime: 2, duration: 2, originalText: '1', turkishText: '1', speakerId: 'speaker-a' },
      { id: 'cue-1', index: 1, startTime: 2, endTime: 4, duration: 2, originalText: '2', turkishText: '2', speakerId: 'speaker-a' },
      { id: 'cue-2', index: 2, startTime: 4, endTime: 6, duration: 2, originalText: '3', turkishText: '3', speakerId: 'speaker-a' },
    ];

    const alternated = manager.alternateSpeakersForTesting(cues);
    expect(alternated[0].speakerId).toBe('speaker-a');
    expect(alternated[1].speakerId).toBe('speaker-b');
    expect(alternated[2].speakerId).toBe('speaker-a');
  });
});
