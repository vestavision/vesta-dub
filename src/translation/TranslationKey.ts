/** Session-only Cloud Translation credential. Content scripts must not read this key. */

export const TRANSLATION_KEY_STORAGE = 'vesta_cloud_translate_key';

const KEY_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

/** Accept a user-pasted API key. Reject blanks and values that cannot be a Google API key. */
export function normalizeTranslationKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!KEY_PATTERN.test(key)) return null;
  return key;
}
