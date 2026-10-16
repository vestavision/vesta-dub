/** Explicit cloud selection is the only remote mode. Everything else is local. */
export const TRANSLATION_MODE_STORAGE = 'vesta_translation_mode';

export type TranslationMode = 'local' | 'cloud';

export function normalizeTranslationMode(value: unknown): TranslationMode {
  return value === 'cloud' ? 'cloud' : 'local';
}

/** Local never requires a key. Cloud is used only when that mode was stored and a key exists. */
export function translationRoute(mode: TranslationMode, cloudKey: string | null): 'local' | 'cloud' | 'cloud_setup' {
  if (mode === 'cloud') return cloudKey ? 'cloud' : 'cloud_setup';
  return 'local';
}
