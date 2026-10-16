/**
 * Bounded sentence reconstruction for P8.1.
 *
 * This is not `TranscriptSentenceAssembler`. That assembler stays disabled:
 * on the reference ASR track it cut almost every group at 12 seconds and
 * dropped repeated tokens without time-aligned provenance.
 *
 * Cues are not sentences. Punctuation may be absent. The reconstructor joins
 * tokens in cue order, drops a repeated prefix only when it is a rolling
 * snapshot or the word times actually overlap, and otherwise keeps the words.
 * A length cut is marked forced. No words are invented and no speaker is
 * inferred from a missing id.
 *
 * `preserveAttachments` is an offline experiment. The default call does not
 * use it, and playback must not pass it.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'e.g', 'ie', 'i.e',
  'am', 'pm', 'a.m', 'p.m', 'inc', 'ltd', 'co', 'gen', 'col', 'vol', 'fig', 'al',
  'approx', 'dept', 'est', 'avg', 'u.s', 'u.k', 'u.s.a',
]);

const DANGLING = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'and', 'or', 'but', 'if', 'as', 'at', 'by',
  'from', 'into', 'about', 'over', 'that', 'which', 'who', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'this', 'these', 'those', 'my', 'your', 'our', 'their', 'its', 'his', 'her', 'not', 'just',
  'very', 'really', 'uh', 'um', 'erm',
]);

const CLAUSE_START = new Set(['so', 'but', 'because', 'although', 'however', 'okay', 'ok', 'now', 'well', 'then']);

/** Finite copula and auxiliary forms. Used only by the optional attachment pass. */
const COPULA_AUX = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being']);

/**
 * Closed-class words that do not safely end a translation unit.
 * "like" and "kind" are included here and are not in DANGLING, so the default
 * segmenter does not treat them as dangling.
 */
const INCOMPLETE = new Set([
  'of', 'to', 'in', 'on', 'for', 'with', 'and', 'or', 'a', 'an', 'the',
  'that', 'which', 'who', 'whose', 'what', 'about', 'into', 'from', 'by', 'as', 'at',
  'like', 'kind', 'sort', 'this', 'these', 'those', 'my', 'your', 'our', 'their',
  'really', 'very', 'just', 'uh', 'um', 'erm', 'not',
]);

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'times', 'point', 'percent',
]);

const HESITATION = new Set(['uh', 'um', 'erm']);

/** Offline attachment extension. One hard event may absorb at most this many following tokens. */
const ATTACHMENT_TOKENS = 8;
const ATTACHMENT_SEC = 12;

const TOKEN_RE = /["“”']?[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*-?%?["“”']?[.!?…,;:]*/g;

export interface ReconstructionWord {
  text: string;
  start: number;
  end: number;
}

export interface ReconstructionCue {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  text: string;
  rawText?: string;
  /** Utterance cues keep ambiguous repetitions. Rolling snapshots drop a repeated prefix. */
  role?: 'utterance' | 'rolling_snapshot';
  speakerId?: string;
  /** Set only when the caption payload itself named a speaker. */
  speakerExplicit?: boolean;
  /** When present, these word strings are the source tokens. */
  words?: ReconstructionWord[];
}

export interface SourceToken {
  sourceIndex: number;
  text: string;
  norm: string;
  cueId: string;
  cueIndex: number;
  tokenIndex: number;
  start: number;
  end: number;
  speakerId?: string;
  speakerExplicit: boolean;
  rolling: boolean;
  ambiguity?: 'repeated_across_overlapping_cues';
}

export type BoundaryKind = 'punctuation' | 'pause' | 'clause' | 'turn' | 'length' | 'end';

export interface UnitBoundary {
  kind: BoundaryKind;
  forced: boolean;
  reason: string;
}

export interface SourceSpan {
  cueId: string;
  cueIndex: number;
  tokenStart: number;
  tokenEnd: number;
  text: string;
  startTime: number;
  endTime: number;
}

export interface ReconstructedUnit {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  tokens: SourceToken[];
  sourceCueIds: string[];
  spans: SourceSpan[];
  boundary: UnitBoundary;
  /** complete: closed by punctuation. partial: pause, clause, or track end. uncertain: dangling or hard cut. */
  completeness: 'complete' | 'partial' | 'uncertain';
  uncertainty: string[];
  speakerId?: string;
}

export type DropReason = 'time_aligned_revision' | 'rolling_snapshot_overlap';

export interface RevisionDrop {
  sourceIndex: number;
  cueId: string;
  cueIndex: number;
  tokenIndex: number;
  text: string;
  start: number;
  end: number;
  reason: DropReason;
}

export interface UnresolvedOverlap {
  cueId: string;
  cueIndex: number;
  text: string;
  tokens: number;
}

export interface ReconstructionResult {
  units: ReconstructedUnit[];
  drops: RevisionDrop[];
  unresolvedOverlaps: UnresolvedOverlap[];
  sourceTokenCount: number;
  limits: ReconstructionLimits;
}

export interface ReconstructionLimits {
  pauseSec: number;
  rollingPauseSec: number;
  softWords: number;
  hardWords: number;
  softSec: number;
  hardSec: number;
  clauseMinWords: number;
  clauseMinSec: number;
}

/**
 * Optional offline experiment. Omitting it, or leaving `preserveAttachments`
 * false, keeps the P8.1 segmenter. Playback must not set this flag.
 */
export interface ReconstructionOptions {
  preserveAttachments?: boolean;
}

export type ForcedEdgeKind =
  | 'split_before_verb'
  | 'split_quantity'
  | 'split_proper_name'
  | 'split_complement'
  | 'split_before_hesitation'
  | 'plausible_clause_marker'
  | 'no_marked_safe_boundary';

const DEFAULT_LIMITS: ReconstructionLimits = {
  pauseSec: 0.9,
  rollingPauseSec: 2.5,
  softWords: 18,
  hardWords: 28,
  softSec: 6.5,
  hardSec: 8.5,
  clauseMinWords: 8,
  clauseMinSec: 3.2,
};

export function reconstructTranscript(
  cues: ReconstructionCue[],
  limits: Partial<ReconstructionLimits> = {},
  options: ReconstructionOptions = {},
): ReconstructionResult {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const { tokens, drops, unresolvedOverlaps } = commitTokens(cues || []);
  const units = segmentTokens(tokens, resolved, options);
  return {
    units,
    drops,
    unresolvedOverlaps,
    sourceTokenCount: tokens.length + drops.length,
    limits: resolved,
  };
}

export function coverageGaps(result: ReconstructionResult): { missing: number[]; duplicated: number[] } {
  const seen = new Map<number, number>();
  for (const unit of result.units) {
    for (const token of unit.tokens) seen.set(token.sourceIndex, (seen.get(token.sourceIndex) || 0) + 1);
  }
  for (const drop of result.drops) seen.set(drop.sourceIndex, (seen.get(drop.sourceIndex) || 0) + 1);
  const missing: number[] = [];
  const duplicated: number[] = [];
  for (let index = 0; index < result.sourceTokenCount; index++) {
    const count = seen.get(index) || 0;
    if (count === 0) missing.push(index);
    else if (count > 1) duplicated.push(index);
  }
  return { missing, duplicated };
}

export function fromSubtitleCues(cues: Array<{ id: string; index: number; startTime: number; endTime: number; originalText: string; speakerId?: string }>): ReconstructionCue[] {
  return cues.map(cue => ({
    id: cue.id,
    index: cue.index,
    startTime: cue.startTime,
    endTime: cue.endTime,
    text: cue.originalText,
    role: 'utterance' as const,
  }));
}

function commitTokens(cues: ReconstructionCue[]): { tokens: SourceToken[]; drops: RevisionDrop[]; unresolvedOverlaps: UnresolvedOverlap[] } {
  const ordered = [...cues].filter(cue => (cue.text || cue.words?.length)).sort((a, b) => a.startTime - b.startTime || a.index - b.index);
  const tokens: SourceToken[] = [];
  const drops: RevisionDrop[] = [];
  const unresolvedOverlaps: UnresolvedOverlap[] = [];
  let sourceIndex = 0;
  let previousCue: ReconstructionCue | null = null;

  for (const cue of ordered) {
    const incoming = tokenizeCue(cue, sourceIndex);
    sourceIndex += incoming.length;
    if (incoming.length === 0) continue;
    const overlap = suffixPrefixSize(tokens, incoming);
    const rolling = cue.role === 'rolling_snapshot';
    const aligned = overlap > 0 && overlapIsTimeAligned(tokens, incoming, overlap);
    if (overlap > 0 && (rolling || aligned)) {
      const reason: DropReason = rolling ? 'rolling_snapshot_overlap' : 'time_aligned_revision';
      for (let i = 0; i < overlap; i++) {
        const token = incoming[i];
        drops.push({
          sourceIndex: token.sourceIndex,
          cueId: token.cueId,
          cueIndex: token.cueIndex,
          tokenIndex: token.tokenIndex,
          text: token.text,
          start: token.start,
          end: token.end,
          reason,
        });
      }
      tokens.push(...incoming.slice(overlap));
    } else {
      if (overlap > 0 && cuesOverlap(previousCue, cue)) {
        for (let i = 0; i < overlap; i++) incoming[i].ambiguity = 'repeated_across_overlapping_cues';
        unresolvedOverlaps.push({
          cueId: cue.id,
          cueIndex: cue.index,
          text: incoming.slice(0, overlap).map(token => token.text).join(' '),
          tokens: overlap,
        });
      }
      tokens.push(...incoming);
    }
    previousCue = cue;
  }
  return { tokens, drops, unresolvedOverlaps };
}

function tokenizeCue(cue: ReconstructionCue, sourceIndex: number): SourceToken[] {
  const surfaces = cue.words?.length
    ? cue.words.map(word => ({ text: word.text.trim(), start: word.start, end: word.end })).filter(word => word.text)
    : interpolate(tokenizeText(cue.text), cue.startTime, cue.endTime);
  return surfaces.map((word, tokenIndex) => ({
    sourceIndex: sourceIndex + tokenIndex,
    text: word.text,
    norm: normalizeWord(word.text),
    cueId: cue.id,
    cueIndex: cue.index,
    tokenIndex,
    start: word.start,
    end: Math.max(word.end, word.start),
    speakerId: cue.speakerExplicit ? cue.speakerId : undefined,
    speakerExplicit: Boolean(cue.speakerExplicit && cue.speakerId),
    rolling: cue.role === 'rolling_snapshot',
  }));
}

export function tokenizeText(text: string): string[] {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return [];
  return collapsed.match(TOKEN_RE)?.map(token => token.trim()).filter(Boolean) ?? [];
}

function interpolate(words: string[], start: number, end: number): ReconstructionWord[] {
  if (words.length === 0) return [];
  const span = Math.max(0.05, end - start);
  const step = span / words.length;
  return words.map((text, index) => ({
    text,
    start: start + index * step,
    end: start + (index + 1) * step,
  }));
}

function segmentTokens(
  tokens: SourceToken[],
  limits: ReconstructionLimits,
  options: ReconstructionOptions = {},
): ReconstructedUnit[] {
  const units: ReconstructedUnit[] = [];
  let bucket: SourceToken[] = [];
  let absorbLeft = 0;
  let holdUntil = -1;
  let extended = false;
  const preserve = Boolean(options.preserveAttachments);

  const flush = (boundary: UnitBoundary) => {
    if (bucket.length === 0) return;
    units.push(makeUnit(bucket, boundary, units.length));
    bucket = [];
    absorbLeft = 0;
    holdUntil = -1;
    extended = false;
  };

  const applyAttachmentHardCut = (token: SourceToken, previous: SourceToken, open: boolean) => {
    const projected = token.end - bucket[0].start;
    if (absorbLeft === 0 && isDangling(previous) && !CLAUSE_START.has(token.norm) && !open) absorbLeft = 3;
    if (absorbLeft > 0 && !CLAUSE_START.has(token.norm) && projected <= limits.hardSec + 2 && !open) {
      absorbLeft -= 1;
      return;
    }
    if (CLAUSE_START.has(token.norm) && !isDangling(previous)) {
      flush({ kind: 'clause', forced: true, reason: 'length_budget_at_clause' });
      absorbLeft = 0;
      return;
    }
    const cut = safeCut(bucket, true);
    if (cut !== null) {
      const head = bucket.slice(0, cut);
      const tail = bucket.slice(cut);
      bucket = head;
      flush({ kind: 'clause', forced: true, reason: 'hard_limit_at_earlier_clause' });
      bucket = tail;
      return;
    }
    const peeled = peelDangling(bucket, true);
    const headLast = peeled.head[peeled.head.length - 1];
    const tailFirst = peeled.tail[0];
    const peeledOpen = Boolean(headLast && tailFirst && attachmentOpen(headLast, tailFirst));
    bucket = peeled.head;
    flush({
      kind: 'length',
      forced: true,
      reason: open || peeledOpen ? 'attachment_unresolved' : 'hard_length_without_safe_boundary',
    });
    bucket = peeled.tail;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = bucket[bucket.length - 1];
    if (previous) {
      const rollingPause = token.rolling && previous.rolling;
      const pauseAt = rollingPause ? limits.rollingPauseSec : limits.pauseSec;
      const gap = token.start - previous.end;
      const finishSentence = sentenceFits(bucket, tokens, index, 12);
      const holding = preserve && index < holdUntil;
      const overHard = preserve
        ? exceedsAttachmentHard(bucket, tokens, index, limits)
        : exceedsHard(bucket, token, limits);
      if (speakerTurn(previous, token)) flush({ kind: 'turn', forced: false, reason: 'explicit_speaker_changed' });
      else if (gap > pauseAt) flush({ kind: 'pause', forced: false, reason: `gap_${gap.toFixed(2)}s` });
      else if (!holding && !finishSentence && softClauseCut(bucket, token, limits)) {
        const overBudget = bucket.length >= limits.softWords || durationOf(bucket) >= limits.softSec;
        flush({
          kind: 'clause',
          forced: overBudget,
          reason: overBudget ? 'length_budget_at_clause' : 'clause_start',
        });
      } else if (!holding && !finishSentence && overHard) {
        if (!preserve) {
          const projected = token.end - bucket[0].start;
          if (absorbLeft === 0 && isDangling(previous) && !CLAUSE_START.has(token.norm)) absorbLeft = 3;
          if (absorbLeft > 0 && !CLAUSE_START.has(token.norm) && projected <= limits.hardSec + 2) {
            absorbLeft -= 1;
          } else if (CLAUSE_START.has(token.norm) && !isDangling(previous)) {
            flush({ kind: 'clause', forced: true, reason: 'length_budget_at_clause' });
            absorbLeft = 0;
          } else {
            const cut = safeCut(bucket);
            if (cut !== null) {
              const head = bucket.slice(0, cut);
              const tail = bucket.slice(cut);
              bucket = head;
              flush({ kind: 'clause', forced: true, reason: 'hard_limit_at_earlier_clause' });
              bucket = tail;
            } else {
              const peeled = peelDangling(bucket);
              bucket = peeled.head;
              flush({ kind: 'length', forced: true, reason: 'hard_length_without_safe_boundary' });
              bucket = peeled.tail;
            }
          }
        } else {
          const open = attachmentOpen(previous, token);
          if (open && !extended) {
            const extendTo = attachmentExtensionEnd(tokens, index, bucket[0].start);
            if (extendTo > index) {
              holdUntil = extendTo;
              extended = true;
              absorbLeft = 0;
            } else {
              applyAttachmentHardCut(token, previous, true);
            }
          } else {
            applyAttachmentHardCut(token, previous, open);
          }
        }
      }
    }
    bucket.push(token);
    if (isSentenceEnding(token.text)) flush({ kind: 'punctuation', forced: false, reason: 'sentence_punctuation' });
  }
  flush({ kind: 'end', forced: false, reason: 'track_end' });
  return units;
}

/** Keep a short punctuated tail on the current unit instead of stranding the last words. */
function sentenceFits(bucket: SourceToken[], tokens: SourceToken[], index: number, maxSec: number): boolean {
  if (bucket.length === 0) return false;
  const start = bucket[0].start;
  for (let cursor = index; cursor < Math.min(tokens.length, index + 8); cursor++) {
    const token = tokens[cursor];
    if (token.end - start > maxSec) return false;
    if (cursor > index && token.start - tokens[cursor - 1].end > 0.9) return false;
    if (isSentenceEnding(token.text)) return true;
  }
  return false;
}

function makeUnit(bucket: SourceToken[], boundary: UnitBoundary, index: number): ReconstructedUnit {
  const uncertainty = new Set<string>();
  if (boundary.forced) uncertainty.add(`forced:${boundary.reason}`);
  for (const token of bucket) {
    if (token.ambiguity) uncertainty.add(token.ambiguity);
    if (/-$/.test(token.text)) uncertainty.add('hyphen_left_unjoined');
  }
  const last = bucket[bucket.length - 1];
  const dangling = isDangling(last);
  if (dangling) uncertainty.add('ends_on_function_word');
  const endsOnClauseMarker = CLAUSE_START.has(last.norm) && boundary.kind !== 'punctuation';
  if (endsOnClauseMarker) uncertainty.add('ends_on_clause_marker');
  let completeness: ReconstructedUnit['completeness'] = 'partial';
  if (boundary.kind === 'punctuation' && !dangling) completeness = 'complete';
  else if (boundary.kind === 'length' || dangling || endsOnClauseMarker) completeness = 'uncertain';
  const speakerIds = [...new Set(bucket.filter(token => token.speakerExplicit && token.speakerId).map(token => token.speakerId as string))];
  return {
    id: `unit-${index}`,
    text: bucket.map(token => token.text).join(' '),
    startTime: round3(bucket[0].start),
    endTime: round3(Math.max(last.end, bucket[0].start)),
    tokens: bucket,
    sourceCueIds: [...new Set(bucket.map(token => token.cueId))],
    spans: spansOf(bucket),
    boundary,
    completeness,
    uncertainty: [...uncertainty],
    speakerId: speakerIds.length === 1 ? speakerIds[0] : undefined,
  };
}

function spansOf(bucket: SourceToken[]): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const token of bucket) {
    const current = spans[spans.length - 1];
    if (current && current.cueId === token.cueId && token.tokenIndex === current.tokenEnd) {
      current.tokenEnd = token.tokenIndex + 1;
      current.text = `${current.text} ${token.text}`;
      current.endTime = round3(token.end);
    } else {
      spans.push({
        cueId: token.cueId,
        cueIndex: token.cueIndex,
        tokenStart: token.tokenIndex,
        tokenEnd: token.tokenIndex + 1,
        text: token.text,
        startTime: round3(token.start),
        endTime: round3(token.end),
      });
    }
  }
  return spans;
}

function softClauseCut(bucket: SourceToken[], token: SourceToken, limits: ReconstructionLimits): boolean {
  if (bucket.length < limits.clauseMinWords) return false;
  if (durationOf(bucket) < limits.clauseMinSec && bucket.length < limits.softWords) return false;
  if (!CLAUSE_START.has(token.norm)) return false;
  const previous = bucket[bucket.length - 1];
  return !isDangling(previous);
}

function exceedsHard(bucket: SourceToken[], token: SourceToken, limits: ReconstructionLimits): boolean {
  if (bucket.length + 1 > limits.hardWords) return true;
  const start = bucket[0].start;
  const projected = token.end - start;
  if (projected <= limits.hardSec) return false;
  // Overlapping ASR clocks can place the next word before the bucket opened.
  return token.end > start;
}

/**
 * Attachment-pass duration. A JSON3 word end is often the cue end, which can
 * sit after the next word has already started. That overshoot is not extra
 * speech. The default segmenter still uses the raw end.
 */
function projectedEnd(tokens: SourceToken[], index: number): number {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (next && next.start >= token.start && next.start < token.end) return next.start;
  return token.end;
}

function exceedsAttachmentHard(
  bucket: SourceToken[],
  tokens: SourceToken[],
  index: number,
  limits: ReconstructionLimits,
): boolean {
  if (bucket.length === 0) return false;
  if (bucket.length + 1 > limits.hardWords) return true;
  const end = projectedEnd(tokens, index);
  const start = bucket[0].start;
  if (end - start <= limits.hardSec) return false;
  return end > start;
}

function peelDangling(bucket: SourceToken[], keepCopula = false): { head: SourceToken[]; tail: SourceToken[] } {
  let index = bucket.length;
  while (index > 6 && isDangling(bucket[index - 1])) {
    if (keepCopula && COPULA_AUX.has(bucket[index - 1].norm)) break;
    index -= 1;
  }
  if (index === bucket.length) return { head: bucket, tail: [] };
  return { head: bucket.slice(0, index), tail: bucket.slice(index) };
}

function safeCut(bucket: SourceToken[], avoidAttachments = false): number | null {
  for (let index = bucket.length - 1; index >= 6; index--) {
    const token = bucket[index];
    const previous = bucket[index - 1];
    if (isDangling(previous)) continue;
    if (avoidAttachments && attachmentOpen(previous, token)) continue;
    const gap = token.start - previous.end;
    if (CLAUSE_START.has(token.norm) || /[,;:]$/.test(previous.text) || gap > 0.35) return index;
  }
  return null;
}

function attachmentExtensionEnd(tokens: SourceToken[], index: number, bucketStart: number): number {
  if (index <= 0 || index >= tokens.length) return index;
  if (!attachmentOpen(tokens[index - 1], tokens[index])) return index;
  let end = index;
  const last = Math.min(tokens.length, index + ATTACHMENT_TOKENS);
  for (let cursor = index; cursor < last; cursor++) {
    const token = tokens[cursor];
    if (projectedEnd(tokens, cursor) - bucketStart > ATTACHMENT_SEC) break;
    if (cursor > index) {
      const prev = tokens[cursor - 1];
      if (token.start - prev.end > 0.9) break;
      if (CLAUSE_START.has(token.norm)) break;
      if (isSentenceEnding(prev.text)) break;
    }
    end = cursor + 1;
    if (isSentenceEnding(token.text)) break;
  }
  return end;
}

function isNumberLike(token: SourceToken): boolean {
  if (NUMBER_WORDS.has(token.norm)) return true;
  if (token.text.includes('%')) return true;
  return /\d/.test(token.norm);
}

function isProperName(token: SourceToken): boolean {
  if (CLAUSE_START.has(token.norm) || COPULA_AUX.has(token.norm)) return false;
  const core = token.text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (core.length < 2 || core === 'I') return false;
  return /^[A-Z]/.test(core);
}

function isContentHead(token: SourceToken): boolean {
  if (!token.norm) return false;
  if (CLAUSE_START.has(token.norm) || COPULA_AUX.has(token.norm) || INCOMPLETE.has(token.norm)) return false;
  if (isNumberLike(token)) return false;
  return true;
}

/** True when a hard cut between these tokens would split an open syntactic attachment. */
export function attachmentOpen(left: SourceToken, right: SourceToken): boolean {
  if (right.start - left.end > 0.9) return false;
  if (CLAUSE_START.has(right.norm) || isSentenceEnding(left.text)) return false;
  if (isNumberLike(left) && (isContentHead(right) || isNumberLike(right) || COPULA_AUX.has(right.norm))) return true;
  if (isProperName(left) && isProperName(right)) return true;
  if (COPULA_AUX.has(left.norm) || INCOMPLETE.has(left.norm)) return true;
  if (COPULA_AUX.has(right.norm)) return true;
  return false;
}

/**
 * Analyst label for a forced edge. This is not a human judgment.
 * Clause markers are candidates only.
 */
export function classifyForcedEdge(left: SourceToken, right: SourceToken): { kind: ForcedEdgeKind; attachmentOpen: boolean } {
  const open = attachmentOpen(left, right);
  let kind: ForcedEdgeKind;
  if (COPULA_AUX.has(right.norm)) kind = 'split_before_verb';
  else if (isNumberLike(left) && (isContentHead(right) || isNumberLike(right))) kind = 'split_quantity';
  else if (isProperName(left) && isProperName(right)) kind = 'split_proper_name';
  else if (INCOMPLETE.has(left.norm) || COPULA_AUX.has(left.norm)) kind = 'split_complement';
  else if (HESITATION.has(right.norm)) kind = 'split_before_hesitation';
  else if (CLAUSE_START.has(right.norm)) kind = 'plausible_clause_marker';
  else kind = 'no_marked_safe_boundary';
  return { kind, attachmentOpen: open };
}

function durationOf(bucket: SourceToken[]): number {
  if (bucket.length === 0) return 0;
  return Math.max(0, bucket[bucket.length - 1].end - bucket[0].start);
}

function speakerTurn(previous: SourceToken, token: SourceToken): boolean {
  return previous.speakerExplicit && token.speakerExplicit && previous.speakerId !== token.speakerId;
}

function isDangling(token: SourceToken | undefined): boolean {
  if (!token) return false;
  if (isSentenceEnding(token.text)) return false;
  return DANGLING.has(token.norm);
}

function suffixPrefixSize(committed: SourceToken[], incoming: SourceToken[]): number {
  if (committed.length === 0 || incoming.length === 0) return 0;
  const max = Math.min(16, committed.length, incoming.length);
  for (let size = max; size >= 1; size--) {
    let matched = true;
    for (let index = 0; index < size; index++) {
      const left = committed[committed.length - size + index].norm;
      if (!left || left !== incoming[index].norm) {
        matched = false;
        break;
      }
    }
    if (matched) return size;
  }
  return 0;
}

function overlapIsTimeAligned(committed: SourceToken[], incoming: SourceToken[], size: number): boolean {
  for (let index = 0; index < size; index++) {
    const left = committed[committed.length - size + index];
    const right = incoming[index];
    if (timeOverlapRatio(left.start, left.end, right.start, right.end) < 0.35) return false;
  }
  return true;
}

function timeOverlapRatio(startA: number, endA: number, startB: number, endB: number): number {
  const overlap = Math.min(endA, endB) - Math.max(startA, startB);
  if (overlap <= 0) return 0;
  const shortest = Math.min(endA - startA, endB - startB);
  if (shortest <= 0) return 0;
  return overlap / shortest;
}

function cuesOverlap(previous: ReconstructionCue | null, cue: ReconstructionCue): boolean {
  if (!previous) return false;
  return Math.min(previous.endTime, cue.endTime) - Math.max(previous.startTime, cue.startTime) > 0.05;
}

export function normalizeWord(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase();
}

export function isSentenceEnding(token: string): boolean {
  if (!/[.!?…]["“”')\]]*$/.test(token)) return false;
  const stripped = token.replace(/["“”')\]]+$/g, '');
  if (/\d+\.\d+$/.test(stripped)) return false;
  const core = stripped.replace(/[.!?…]+$/g, '').replace(/["“”')\]]+$/g, '').toLowerCase();
  if (!core) return false;
  if (ABBREVIATIONS.has(core)) return false;
  if (/^[a-z]$/.test(core)) return false;
  return true;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}
