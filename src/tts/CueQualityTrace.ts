import { prepareSpeech, type FillerContext, type SpeechPreparation } from './FillerPreparation';

/**
 * In-memory explanation of one cue. Production logging must not persist this
 * object: it contains caption text so a developer or a test can see each stage.
 */
export interface CueQualityTrace {
  schema: 'vesta.cue-quality.v0.1.1';
  persist: false;
  sourceText: string;
  displayText: string;
  filteredText: string;
  spokenText: string;
  omitted: boolean;
  fillerRemoved: number;
  discourseApplied: SpeechPreparation['discourseApplied'];
  stages: Array<{ stage: string; chars: number; text: string; notes: string[] }>;
}

const CAPTION_KEYS = new Set([
  'text',
  'displayText',
  'originalText',
  'turkishText',
  'spokenText',
  'sourceText',
  'filteredText',
  'tokens',
  'debugOriginalText',
  'debugTurkishText',
]);

/** Drop caption strings before they reach the console or the rolling trace. */
export function redactTraceDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'tokens' && Array.isArray(value)) {
      out.tokenRules = value.map(item => {
        if (!item || typeof item !== 'object') return {};
        const token = item as Record<string, unknown>;
        return { category: token.category, action: token.action, rule: token.rule };
      });
      continue;
    }
    if (CAPTION_KEYS.has(key)) {
      out[`${key}Chars`] = typeof value === 'string' ? value.length : null;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function buildCueQualityTrace(input: { sourceText: string; turkishText: string } & FillerContext): CueQualityTrace {
  const preparation = prepareSpeech(input.turkishText, input);
  const notes = preparation.discourseApplied.map(item => `${item.rule}:${item.from}->${item.to}`);
  return {
    schema: 'vesta.cue-quality.v0.1.1',
    persist: false,
    sourceText: input.sourceText ?? '',
    displayText: preparation.displayText,
    filteredText: preparation.filteredText,
    spokenText: preparation.spokenText,
    omitted: preparation.omitted,
    fillerRemoved: preparation.removedTokenCount,
    discourseApplied: preparation.discourseApplied,
    stages: [
      { stage: 'source', chars: (input.sourceText ?? '').length, text: input.sourceText ?? '', notes: ['English source used as evidence. Not a production log.'] },
      { stage: 'translation-display', chars: preparation.displayText.length, text: preparation.displayText, notes: ['Turkish display text is unchanged.'] },
      { stage: 'filler', chars: preparation.filteredText.length, text: preparation.filteredText, notes: [`removed:${preparation.removedTokenCount}`] },
      { stage: 'discourse', chars: preparation.spokenText.length, text: preparation.spokenText, notes: notes.length ? notes : ['no spoken discourse change'] },
      { stage: 'tts-input', chars: preparation.spokenText.length, text: preparation.spokenText, notes: [preparation.omitted ? 'omitted' : 'speak'] },
    ],
  };
}
