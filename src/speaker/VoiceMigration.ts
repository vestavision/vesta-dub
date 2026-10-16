import type { TTSProviderId } from '../core/types';

/** Stored id from builds that offered Piper Fahrettin. That voice is not shipped. */
export const REMOVED_PIPER_PROVIDER = 'piper-fahrettin';

export function migrateStoredProvider(speakerId: string, value: unknown): TTSProviderId {
  if (value === 'antalia' || value === 'ema-lightning') return value;
  return speakerId === 'speaker-b' ? 'ema-lightning' : 'antalia';
}
