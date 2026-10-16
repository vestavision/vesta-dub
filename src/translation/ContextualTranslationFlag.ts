/**
 * P8.1 experimental contextual translation.
 * Playback does not read this flag. The default remains the P8.0 per-cue translator.
 * Promotion requires the human-review gate in docs/p8.1-human-acceptance.md.
 */
export const experimentalContextualTranslationEnabled = false;

export type TranslationPipeline = 'production' | 'experimental';

export function translationPipeline(enabled: boolean = experimentalContextualTranslationEnabled): TranslationPipeline {
  return enabled ? 'experimental' : 'production';
}
