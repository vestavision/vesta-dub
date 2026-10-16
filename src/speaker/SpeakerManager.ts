import { SpeakerSlot, TTSProviderId, SubtitleCue } from '../core/types';
import { migrateStoredProvider } from './VoiceMigration';

export class SpeakerManager {
  private slots: Map<string, SpeakerSlot> = new Map();
  private defaultSpeakerId = 'speaker-a';

  constructor() {
    this.resetDefaults();
  }

  resetDefaults(): void {
    this.slots.clear();
    this.slots.set('speaker-a', {
      id: 'speaker-a',
      name: 'Konuşmacı A (Birincil)',
      providerId: 'antalia',
      speed: 1.0,
    });
    this.slots.set('speaker-b', {
      id: 'speaker-b',
      name: 'Konuşmacı B (İkincil)',
      providerId: 'ema-lightning',
      speed: 1.0,
    });
    this.defaultSpeakerId = 'speaker-a';
  }

  getSlot(speakerId?: string): SpeakerSlot {
    const slot = this.slots.get(speakerId || this.defaultSpeakerId);
    if (!slot) {
      return this.slots.get(this.defaultSpeakerId)!;
    }
    return slot;
  }

  getAllSlots(): SpeakerSlot[] {
    return Array.from(this.slots.values());
  }

  updateSlot(speakerId: string, updates: Partial<SpeakerSlot>): void {
    const existing = this.getSlot(speakerId);
    const providerId = updates.providerId !== undefined
      ? migrateStoredProvider(speakerId, updates.providerId)
      : existing.providerId;
    this.slots.set(speakerId, {
      ...existing,
      ...updates,
      id: speakerId,
      providerId,
    });
  }

  assignProvider(speakerId: string, providerId: TTSProviderId): void {
    this.updateSlot(speakerId, { providerId });
  }

  setSpeed(speakerId: string, speed: number): void {
    this.updateSlot(speakerId, { speed: Math.max(0.5, Math.min(2.0, speed)) });
  }

  getProviderForSpeaker(speakerId?: string): TTSProviderId {
    const slot = this.getSlot(speakerId || this.defaultSpeakerId);
    return slot.providerId;
  }

  getDefaultSpeakerId(): string {
    return this.defaultSpeakerId;
  }

  setDefaultSpeakerId(speakerId: string): void {
    if (this.slots.has(speakerId)) {
      this.defaultSpeakerId = speakerId;
    }
  }

  /**
   * Assign a speaker identity to a specific cue
   */
  assignCueSpeaker(cues: SubtitleCue[], cueIndex: number, speakerId: string): SubtitleCue[] {
    if (cueIndex < 0 || cueIndex >= cues.length) return cues;
    return cues.map((cue, idx) => {
      if (idx === cueIndex) {
        return { ...cue, speakerId };
      }
      return cue;
    });
  }

  /**
   * Alternate speakers between segments for demonstration/testing
   */
  alternateSpeakersForTesting(cues: SubtitleCue[]): SubtitleCue[] {
    return cues.map((cue, idx) => ({
      ...cue,
      speakerId: idx % 2 === 0 ? 'speaker-a' : 'speaker-b',
    }));
  }
}
