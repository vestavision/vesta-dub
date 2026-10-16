import { SubtitleCue, SubtitleTrack } from '../core/types';
import { SentenceTranslation, translateSentences } from '../translation/ContextualTranslator';
import { isTranslationRateLimit, TranslationRateLimitError } from '../translation/TranslationRateLimit';
import { TranscriptSentenceAssembler } from './TranscriptSentenceAssembler';

/** Rate limit raised after any sentences translated earlier in the same call are copied onto cues. */
export class PreloadedTranslationRateLimit extends TranslationRateLimitError {
  constructor(retryAfterMs: number | null, readonly cues: SubtitleCue[]) {
    super(retryAfterMs);
    this.name = 'PreloadedTranslationRateLimit';
  }
}

export interface StartupTranslation {
  cues: SubtitleCue[];
  translatedIndexes: number[];
  sentenceCount: number;
  fragmentCount: number;
  dedupedTokens: number;
}

/**
 * Prefer the spoken-language track. A Turkish translation track is YouTube's
 * per-fragment MT and is not the speech we should dub from when an ASR source exists.
 */
export function selectSpokenSourceTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  if (!tracks.length) return null;
  const asr = tracks.filter(track => track.kind === 'asr');
  return asr.find(track => track.languageCode === 'en')
    || asr.find(track => track.languageCode !== 'tr')
    || asr.find(track => track.languageCode === 'tr')
    || tracks.find(track => track.languageCode === 'en')
    || tracks.find(track => track.languageCode === 'tr')
    || tracks[0];
}

export function prepareSpokenCues(cues: SubtitleCue[], languageCode: string, idPrefix = 'sent'): SubtitleCue[] {
  const sentences = TranscriptSentenceAssembler.assemble(cues);
  return TranscriptSentenceAssembler.toCues(sentences, languageCode, idPrefix);
}

export function startupIndexes(cues: SubtitleCue[], videoTimeSec: number, horizonSec = 18, limit = 8): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.endTime < videoTimeSec - 0.4) continue;
    if (cue.startTime > videoTimeSec + horizonSec && indexes.length >= 3) break;
    indexes.push(i);
    if (indexes.length >= limit) break;
  }
  if (indexes.length === 0 && cues.length > 0) {
    const next = cues.findIndex(cue => cue.endTime > videoTimeSec);
    const start = next < 0 ? cues.length - 1 : next;
    for (let i = start; i < Math.min(cues.length, start + 4); i++) indexes.push(i);
  }
  return indexes;
}

export async function translateCueIndexes(
  cues: SubtitleCue[],
  indexes: number[],
  translate: (text: string) => Promise<string>,
  isCurrent: () => boolean,
): Promise<SubtitleCue[]> {
  if (indexes.length === 0) return cues;
  const source = cues.map(cue => ({ ...cue }));
  try {
    const translations = await translateSentences(indexes.map(index => source[index].originalText), translate, isCurrent);
    return applyTranslations(source, indexes, translations);
  } catch (error) {
    if (error instanceof PreloadedTranslationRateLimit) throw error;
    if (!isTranslationRateLimit(error)) throw error;
    const partial = error instanceof TranslationRateLimitError && Array.isArray(error.partial)
      ? error.partial as SentenceTranslation[]
      : undefined;
    const applied = partial ? applyTranslations(source, indexes, partial) : source;
    const retryAfterMs = error instanceof TranslationRateLimitError ? error.retryAfterMs : null;
    throw new PreloadedTranslationRateLimit(retryAfterMs, applied);
  }
}

function applyTranslations(cues: SubtitleCue[], indexes: number[], translations: SentenceTranslation[]): SubtitleCue[] {
  const next = cues.map(cue => ({ ...cue }));
  indexes.forEach((cueIndex, resultIndex) => {
    const result = translations[resultIndex];
    if (!result?.turkish.trim()) return;
    const cue = next[cueIndex];
    next[cueIndex] = {
      ...cue,
      turkishText: result.turkish,
      assembly: cue.assembly ? {
        ...cue.assembly,
        semanticCompromises: result.compromises,
        contextAligned: result.aligned,
      } : cue.assembly,
    };
  });
  return next;
}

export function translationCoverage(cues: SubtitleCue[]): { translated: number; pending: number; compromises: number } {
  let translated = 0;
  let pending = 0;
  let compromises = 0;
  for (const cue of cues) {
    if (cue.turkishText?.trim()) translated += 1;
    else pending += 1;
    compromises += cue.assembly?.semanticCompromises?.length || 0;
  }
  return { translated, pending, compromises };
}

/** Publish bounded windows immediately; never wait for the entire native track. */
export async function translateCueWindows(
  cues: SubtitleCue[],
  indexes: number[],
  translate: (text: string) => Promise<string>,
  isCurrent: () => boolean,
  onWindow: (entries: Array<{ index: number; cue: SubtitleCue }>) => void,
  windowSize = 6,
): Promise<void> {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('Invalid translation window size');
  for (let offset = 0; offset < indexes.length && isCurrent(); offset += windowSize) {
    const windowIndexes = indexes.slice(offset, offset + windowSize);
    try {
      const updated = await translateCueIndexes(cues, windowIndexes, translate, isCurrent);
      if (!isCurrent()) return;
      publishWindow(updated, windowIndexes, onWindow);
    } catch (error) {
      if (error instanceof PreloadedTranslationRateLimit && isCurrent()) {
        publishWindow(error.cues, windowIndexes, onWindow);
      }
      throw error;
    }
  }
}

function publishWindow(
  cues: SubtitleCue[],
  windowIndexes: number[],
  onWindow: (entries: Array<{ index: number; cue: SubtitleCue }>) => void,
): void {
  onWindow(windowIndexes.filter(index => cues[index]?.turkishText?.trim()).map(index => ({ index, cue: cues[index] })));
}
