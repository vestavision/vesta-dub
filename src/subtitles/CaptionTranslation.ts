import { SubtitleCue } from '../core/types';
import { Translator } from './Translator';

export async function translateAcquiredCue(cue: SubtitleCue, isCurrent: () => boolean): Promise<SubtitleCue | null> {
  if (!isCurrent()) return null;
  const translated = cue.acquisition?.language === 'tr' ? cue.originalText : await Translator.toTurkish(cue.originalText);
  if (!isCurrent()) return null;
  if (!translated.trim()) throw new Error(`Missing Turkish translation for ${cue.id}`);
  return {...cue, turkishText:translated.trim()};
}
