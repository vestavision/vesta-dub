import { CueAssembly, SubtitleCue } from '../core/types';

export interface AssembledSentence {
  text: string;
  startTime: number;
  endTime: number;
  cueIds: string[];
  cueIndexes: number[];
  confidence: number;
  boundary: CueAssembly['boundary'];
  dedupedTokens: number;
  tokenCount: number;
  speakerId?: string;
}

interface TimedToken {
  text: string;
  start: number;
  end: number;
  cueId: string;
  cueIndex: number;
  speakerId?: string;
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'e.g', 'ie', 'i.e',
  'am', 'pm', 'a.m', 'p.m', 'inc', 'ltd', 'co', 'gen', 'col', 'vol', 'fig', 'al',
  'approx', 'dept', 'est', 'avg', 'u.s', 'u.k', 'u.s.a',
]);

/**
 * Rebuilds stable sentences from timestamped ASR fragments.
 * Drops only rolling-revision overlaps. Keeps intentional repetition.
 * Does not invent words.
 */
export class TranscriptSentenceAssembler {
  static assemble(
    cues: SubtitleCue[],
    options: { maxDurationSec?: number; gapBreakSec?: number; revisionGapSec?: number } = {},
  ): AssembledSentence[] {
    const maxDurationSec = options.maxDurationSec ?? 12;
    const gapBreakSec = options.gapBreakSec ?? 1.15;
    const revisionGapSec = options.revisionGapSec ?? 0.75;
    const sorted = [...(cues || [])].filter(c => (c.originalText || '').trim()).sort((a, b) => a.startTime - b.startTime || a.index - b.index);

    const tokens: TimedToken[] = [];
    let deduped = 0;

    for (const cue of sorted) {
      const words = cue.originalText.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      const span = Math.max(0.05, cue.endTime - cue.startTime);
      const step = span / words.length;

      const incoming = words.map((text, i) => ({
        text,
        start: cue.startTime + i * step,
        end: cue.startTime + (i + 1) * step,
        cueId: cue.id,
        cueIndex: cue.index,
        speakerId: cue.speakerId,
      }));

      const speakerChanged = tokens.length > 0 && (incoming[0].speakerId || 'speaker-a') !== (tokens[tokens.length - 1].speakerId || 'speaker-a');
      if (speakerChanged) {
        // A speaker change is a hard boundary. Keep every incoming token.
        tokens.push(...incoming);
        continue;
      }

      const overlap = suffixPrefixOverlap(tokens, incoming.map(t => t.text));
      const gap = tokens.length ? incoming[0].start - tokens[tokens.length - 1].end : 0;
      const fullyRepeated = overlap === incoming.length && overlap > 0;
      const revision = tokens.length > 0 && gap < revisionGapSec;

      if (fullyRepeated && revision) {
        deduped += incoming.length;
        continue;
      }
      const drop = revision && !fullyRepeated ? overlap : 0;
      if (drop > 0) deduped += drop;
      const kept = incoming.slice(drop);
      if (kept.length === 0) continue;

      const last = tokens[tokens.length - 1];
      if (last && /-$/.test(last.text) && kept.length) {
        last.text = `${last.text.slice(0, -1)}${kept[0].text}`;
        last.end = kept[0].end;
        last.cueId = kept[0].cueId;
        tokens.push(...kept.slice(1));
      } else {
        tokens.push(...kept);
      }
    }

    const sentences: AssembledSentence[] = [];
    let bucket: TimedToken[] = [];

    const flush = (boundary: CueAssembly['boundary']) => {
      if (bucket.length === 0) return;
      const text = bucket.map(t => t.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) {
        bucket = [];
        return;
      }
      const endedByPunct = boundary === 'punctuation';
      const confidence = endedByPunct ? 0.9 : boundary === 'gap' || boundary === 'speaker' ? 0.72 : boundary === 'duration' ? 0.58 : 0.64;
      sentences.push({
        text,
        startTime: bucket[0].start,
        endTime: Math.max(bucket[bucket.length - 1].end, bucket[0].start + 0.2),
        cueIds: [...new Set(bucket.map(t => t.cueId))],
        cueIndexes: [...new Set(bucket.map(t => t.cueIndex))],
        confidence: Number(confidence.toFixed(2)),
        boundary,
        dedupedTokens: 0,
        tokenCount: bucket.length,
        speakerId: bucket[0].speakerId,
      });
      bucket = [];
    };

    const originalDeduped = deduped;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const prev = bucket[bucket.length - 1];
      if (prev) {
        const gap = token.start - prev.end;
        const speakerChanged = (token.speakerId || 'speaker-a') !== (prev.speakerId || 'speaker-a');
        if (speakerChanged) flush('speaker');
        else if (gap > gapBreakSec) flush('gap');
      }
      if (bucket.length > 0) {
        const projected = token.end - bucket[0].start;
        if (projected > maxDurationSec) flush('duration');
      }
      bucket.push(token);
      if (isSentenceEnding(token.text)) flush('punctuation');
    }
    flush('end');

    if (sentences.length > 0 && originalDeduped > 0) {
      // Total dropped rolling-revision tokens. Stored once so reports do not
      // treat the same drop as a per-sentence rate.
      sentences[0].dedupedTokens = originalDeduped;
    }

    return sentences;
  }

  static toCues(sentences: AssembledSentence[], languageCode: string, idPrefix = 'sent'): SubtitleCue[] {
    const spokenTurkish = languageCode.toLowerCase().startsWith('tr');
    let lastEnd = 0;
    return sentences.map((sentence, index) => {
      const start = Math.max(lastEnd, sentence.startTime);
      const end = Math.max(start + 0.2, sentence.endTime, sentence.startTime);
      lastEnd = end;
      const assembly: CueAssembly = {
        sourceCueIds: sentence.cueIds,
        confidence: sentence.confidence,
        boundary: sentence.boundary,
        dedupedTokens: sentence.dedupedTokens,
        tokenCount: sentence.tokenCount,
      };
      return {
        id: `${idPrefix}-${index}`,
        index,
        startTime: Number(start.toFixed(3)),
        endTime: Number(end.toFixed(3)),
        duration: Number((end - start).toFixed(3)),
        originalText: sentence.text,
        turkishText: spokenTurkish ? sentence.text : '',
        speakerId: sentence.speakerId || 'speaker-a',
        mergedFromCount: sentence.cueIds.length,
        isAutoGenerated: true,
        assembly,
      };
    });
  }
}

function normalizeWord(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.'’%-]+$/g, '').toLowerCase();
}

function suffixPrefixOverlap(committed: TimedToken[], incoming: string[]): number {
  if (committed.length === 0 || incoming.length === 0) return 0;
  const max = Math.min(12, committed.length, incoming.length);
  const incomingNorm = incoming.map(normalizeWord);
  for (let size = max; size >= 1; size--) {
    let matched = true;
    for (let i = 0; i < size; i++) {
      const left = normalizeWord(committed[committed.length - size + i].text);
      if (!left || left !== incomingNorm[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return size;
  }
  return 0;
}

function isSentenceEnding(token: string): boolean {
  if (!/[.!?…]["')\]]*$/.test(token)) return false;
  const stripped = token.replace(/["')\]]+$/g, '');
  if (/\d+\.\d+$/.test(stripped)) return false;
  const core = stripped.replace(/\.+$/g, '').toLowerCase();
  if (ABBREVIATIONS.has(core)) return false;
  if (/^[a-z]$/.test(core)) return false;
  return true;
}
