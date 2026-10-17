/**
 * Conservative English discourse classification for spoken Turkish.
 *
 * The display translation is never rewritten here. A marker is rendered only when
 * the same English token survives in the Turkish text, or when a single leading
 * or trailing gloss is the known mistranslation of that marker. Ambiguous
 * tokens are preserved. "yeah" is an affirmation or a question, never a hesitation,
 * and it is never rewritten to "ah".
 */

export type DiscourseFunction =
  | 'affirmation'
  | 'agreement'
  | 'backchannel'
  | 'surprise'
  | 'hesitation'
  | 'disagreement'
  | 'question'
  | 'reaction'
  | 'adverb';

export interface DiscourseMarker {
  text: string;
  start: number;
  end: number;
  fn: DiscourseFunction;
  confidence: 'clear' | 'ambiguous';
  action: 'keep' | 'remove' | 'render';
  /** Spoken form for a surviving English token. Null means do not replace. */
  survivingSpoken: string | null;
  rule: string;
}

export interface DiscourseReplacement {
  rule: string;
  from: string;
  to: string;
}

export interface DiscourseRender {
  text: string;
  applied: DiscourseReplacement[];
}

interface Token {
  text: string;
  lower: string;
  start: number;
  end: number;
}

const TOKEN = /[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu;
const HESITATION = new Set(['uh', 'um', 'erm']);
const AFFIRMATION = new Set(['yeah', 'yes', 'yep']);
const BACKCHANNEL = new Set(['mm-hmm', 'mmhmm', 'mhm']);
const DISAGREEMENT = new Set(['uh-uh', 'mm-mm']);

function tokensOf(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map(match => ({
    text: match[0],
    lower: match[0].toLocaleLowerCase('en-US'),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function punctAfter(text: string, end: number): string {
  return /^\s*([?!.,])/.exec(text.slice(end))?.[1] ?? '';
}

function isLeading(tokens: Token[], index: number): boolean {
  return tokens.slice(0, index).every(token => HESITATION.has(token.lower) || token.lower === 'oh' || token.lower === 'ah');
}

function quoted(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 1), start);
  const after = text.slice(end, end + 1);
  return /["“”']/.test(before) || /["“”']/.test(after);
}

function marker(
  token: Token,
  fn: DiscourseFunction,
  confidence: 'clear' | 'ambiguous',
  action: DiscourseMarker['action'],
  survivingSpoken: string | null,
  rule: string,
): DiscourseMarker {
  return {
    text: token.text,
    start: token.start,
    end: token.end,
    fn,
    confidence,
    action,
    survivingSpoken: confidence === 'clear' ? survivingSpoken : null,
    rule,
  };
}

/** Classify discourse markers in the English source. Does not read the translation. */
export function classifyDiscourse(source: string): DiscourseMarker[] {
  const tokens = tokensOf(source);
  const markers: DiscourseMarker[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const punct = punctAfter(source, token.end);
    const leading = isLeading(tokens, index);
    const sole = tokens.every((item, itemIndex) => itemIndex === index || HESITATION.has(item.lower));
    const inQuotes = quoted(source, token.start, token.end);

    if (token.lower === 'all' && next?.lower === 'right') {
      markers.push({
        text: `${token.text} ${next.text}`,
        start: token.start,
        end: next.end,
        fn: 'agreement',
        confidence: inQuotes ? 'ambiguous' : 'clear',
        action: 'render',
        survivingSpoken: inQuotes ? null : 'tamam',
        rule: 'all-right-agreement',
      });
      index += 1;
      continue;
    }

    if (HESITATION.has(token.lower)) {
      const bareUh = sole && token.lower === 'uh';
      // FillerPreparation already removes a corroborated hesitation. Doing it
      // again here would drop question and measurement uses that filler keeps.
      markers.push(marker(
        token,
        'hesitation',
        bareUh || inQuotes || punct === '?' ? 'ambiguous' : 'clear',
        'keep',
        null,
        bareUh || punct === '?' ? 'bare-hesitation-kept' : index === 0 ? 'leading-hesitation' : 'hesitation-classified',
      ));
      continue;
    }

    if (DISAGREEMENT.has(token.lower)) {
      markers.push(marker(token, 'disagreement', 'clear', 'render', 'ı-ıh', 'disagreement-kept'));
      continue;
    }

    if (token.lower === 'uh-huh') {
      // The listening review preferred the spoken English token over "hı hı".
      markers.push(marker(token, 'backchannel', 'clear', 'keep', null, 'backchannel-uh-huh-kept'));
      continue;
    }

    if (BACKCHANNEL.has(token.lower)) {
      markers.push(marker(token, 'backchannel', 'clear', 'render', 'hı hı', 'backchannel-kept'));
      continue;
    }

    if (token.lower === 'hmm' || /^h+m+$/.test(token.lower)) {
      markers.push(marker(token, 'reaction', 'clear', 'keep', null, 'thinking-kept'));
      continue;
    }

    if (AFFIRMATION.has(token.lower)) {
      if (inQuotes || next?.lower === 'no' || next?.lower === 'or') {
        markers.push(marker(token, next?.lower === 'no' ? 'disagreement' : 'affirmation', 'ambiguous', 'keep', null, 'affirmation-preserved'));
        continue;
      }
      if (punct === '?' && (sole || index === tokens.length - 1 || leading)) {
        markers.push(marker(token, 'question', 'clear', 'render', 'Öyle mi?', 'affirmation-question'));
        continue;
      }
      if (leading || sole) {
        markers.push(marker(token, 'affirmation', 'clear', 'render', 'Evet', 'affirmation-kept'));
        continue;
      }
      markers.push(marker(token, 'affirmation', 'ambiguous', 'keep', null, 'affirmation-preserved'));
      continue;
    }

    if (token.lower === 'well') {
      const nounOrParticle = previous?.lower === 'as' || previous?.lower === 'the' || previous?.lower === 'a' || previous?.lower === 'an';
      if (!nounOrParticle && leading && !inQuotes) {
        markers.push(marker(token, 'reaction', 'clear', 'render', 'Şey', 'well-opener'));
      } else {
        markers.push(marker(token, 'reaction', 'ambiguous', 'keep', null, 'well-preserved'));
      }
      continue;
    }

    if (token.lower === 'right') {
      const directional = previous?.lower === 'on' || previous?.lower === 'to' || previous?.lower === 'the'
        || next?.lower === 'now' || next?.lower === 'away' || next?.lower === 'hand' || next?.lower === 'side' || next?.lower === 'left';
      if (directional || inQuotes) {
        markers.push(marker(token, 'agreement', 'ambiguous', 'keep', null, 'right-not-discourse'));
        continue;
      }
      if (punct === '?' && (sole || index === tokens.length - 1)) {
        markers.push(marker(token, 'question', 'clear', 'render', 'değil mi?', 'right-question-tag'));
        continue;
      }
      if (leading) {
        markers.push(marker(token, 'agreement', 'clear', 'render', 'Tamam', 'right-opener'));
        continue;
      }
      if (index === tokens.length - 1) {
        markers.push(marker(token, 'agreement', 'clear', 'render', 'doğru', 'right-confirmation'));
        continue;
      }
      markers.push(marker(token, 'agreement', 'ambiguous', 'keep', null, 'right-preserved'));
      continue;
    }

    if (token.lower === 'sure') {
      const verbal = previous?.lower === 'make' || previous?.lower === 'am' || previous?.lower === 'be';
      if (!verbal && !inQuotes && (leading || sole)) {
        markers.push(marker(token, 'agreement', 'clear', 'render', 'Tabii', 'sure-agreement'));
      } else {
        markers.push(marker(token, 'agreement', 'ambiguous', 'keep', null, 'sure-preserved'));
      }
      continue;
    }

    if (token.lower === 'actually') {
      markers.push(marker(token, 'adverb', inQuotes ? 'ambiguous' : 'clear', 'render', 'aslında', 'actually-kept'));
      continue;
    }

    if (token.lower === 'exactly') {
      const precise = next ? /^\d/.test(next.lower) : false;
      if (!precise && !inQuotes && (leading || sole || (previous ? AFFIRMATION.has(previous.lower) || HESITATION.has(previous.lower) : false))) {
        markers.push(marker(token, 'agreement', 'clear', 'render', 'aynen', 'exactly-agreement'));
      } else {
        markers.push(marker(token, 'agreement', 'ambiguous', 'keep', null, 'exactly-preserved'));
      }
      continue;
    }

    if (token.lower === 'oh' || token.lower === 'ah') {
      const prelude = next ? AFFIRMATION.has(next.lower) : false;
      if (prelude || inQuotes || !leading && !sole) {
        markers.push(marker(token, 'reaction', 'ambiguous', 'keep', null, prelude ? 'reaction-before-affirmation' : 'reaction-preserved'));
        continue;
      }
      if (token.lower === 'ah') {
        // The listening review preferred written "Ah" over "Aa".
        markers.push(marker(token, punct === '?' ? 'surprise' : 'reaction', 'clear', 'keep', null, 'reaction-ah-kept'));
        continue;
      }
      markers.push(marker(token, punct === '?' ? 'surprise' : 'reaction', 'clear', 'render', 'Aa', 'reaction-aa'));
    }
  }
  return markers;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Hit {
  start: number;
  end: number;
  surface: string;
}

function findWholeWord(text: string, word: string, from = 0): Hit | null {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escapeRegExp(word)})(?![\\p{L}\\p{N}])`, 'iu');
  const match = pattern.exec(text.slice(from));
  if (!match || match.index === undefined) return null;
  const start = from + match.index;
  return { start, end: start + match[1].length, surface: match[1] };
}

function findAll(text: string, word: string): Hit[] {
  const hits: Hit[] = [];
  let from = 0;
  while (from <= text.length) {
    const hit = findWholeWord(text, word, from);
    if (!hit) break;
    hits.push(hit);
    from = hit.end;
    if (hit.end === hit.start) break;
  }
  return hits;
}

function nextWord(text: string, end: number): string | null {
  return /^\s*[,;:]?\s*([\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*)/u.exec(text.slice(end))?.[1] ?? null;
}

function firstWordSpan(text: string): Hit | null {
  const match = /^\s*([\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*)/u.exec(text);
  if (!match || match.index === undefined) return null;
  const start = match.index + (match[0].length - match[1].length);
  return { start, end: start + match[1].length, surface: match[1] };
}

function lastWordSpan(text: string): Hit | null {
  const match = /([\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*)\s*$/u.exec(text);
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: match.index + match[1].length, surface: match[1] };
}

function sameWord(left: string, right: string): boolean {
  const bare = right.replace(/[.?!]+$/u, '').trim();
  return left.toLocaleLowerCase('tr') === bare.toLocaleLowerCase('tr');
}

function dropSpan(text: string, hit: Hit): string {
  let end = hit.end;
  const comma = /^\s*,/.exec(text.slice(end));
  if (comma) end += comma[0].length;
  return cleanup(text.slice(0, hit.start) + text.slice(end));
}

function replaceSpan(text: string, hit: Hit, spoken: string): string {
  let end = hit.end;
  const suffix = text.slice(end);
  const punct = /^\s*([?!.,])/.exec(suffix);
  if (punct && /[.?!…]$/u.test(spoken)) end += punct[0].length;
  return cleanup(text.slice(0, hit.start) + spoken + text.slice(end));
}

function cleanup(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/^[,\s]+/g, '')
    .trim();
}

function repairFirstWord(text: string, accepts: (word: string) => boolean, spoken: string): { text: string; from: string; to: string } | null {
  const first = firstWordSpan(text);
  if (!first || !accepts(first.surface)) return null;
  const following = nextWord(text, first.end);
  if (following && sameWord(following, spoken)) {
    return { text: dropSpan(text, first), from: first.surface, to: '' };
  }
  return { text: replaceSpan(text, first, spoken), from: first.surface, to: spoken };
}

/**
 * Apply clear marker readings to a copy of the Turkish display text.
 * The caller keeps the original display string.
 */
export function renderDiscourse(displayText: string, markers: DiscourseMarker[]): DiscourseRender {
  if (!displayText.trim()) return { text: '', applied: [] };
  let text = displayText;
  const applied: DiscourseReplacement[] = [];
  const renderedRules = new Set<string>();

  for (const item of markers) {
    if (item.confidence !== 'clear' || item.action === 'keep' || !item.survivingSpoken && item.action !== 'remove') continue;
    const hit = findWholeWord(text, item.text);
    if (!hit) continue;
    const before = hit.surface;
    if (item.action === 'remove') {
      text = dropSpan(text, hit);
      applied.push({ rule: item.rule, from: before, to: '' });
      renderedRules.add(item.rule);
      continue;
    }
    const spoken = item.survivingSpoken ?? '';
    const following = nextWord(text, hit.end);
    if (following && sameWord(following, spoken)) {
      text = dropSpan(text, hit);
      applied.push({ rule: `${item.rule}-dropped-duplicate`, from: before, to: '' });
    } else {
      text = replaceSpan(text, hit, spoken);
      applied.push({ rule: item.rule, from: before, to: spoken });
    }
    renderedRules.add(item.rule);
  }

  const leadingHesitation = markers.find(item => item.rule === 'leading-hesitation' && item.confidence === 'clear');
  if (leadingHesitation) {
    const first = firstWordSpan(text);
    if (first && /^(?:uh|um)['’][dt][aeı]$/iu.test(first.surface)) {
      applied.push({ rule: 'fused-hesitation-locative', from: first.surface, to: '' });
      text = dropSpan(text, first);
    }
  }

  const affirmation = markers.find(item => item.rule === 'affirmation-kept' && item.confidence === 'clear');
  if (affirmation && !applied.some(item => item.rule.startsWith('affirmation'))) {
    const repaired = repairFirstWord(text, word => /^(?:ah|oh|aa+)$/iu.test(word), 'Evet');
    if (repaired && repaired.text !== text) {
      applied.push({ rule: repaired.to ? 'affirmation-not-ah' : 'affirmation-not-ah-dropped-duplicate', from: repaired.from, to: repaired.to });
      text = repaired.text;
    }
  }

  const reaction = markers.find(item => item.rule === 'reaction-aa' && item.confidence === 'clear');
  if (reaction && !applied.some(item => item.rule === 'reaction-aa' || item.rule === 'affirmation-not-ah')) {
    const repaired = repairFirstWord(text, word => /^(?:ah|oh)$/iu.test(word), 'Aa');
    if (repaired && repaired.text !== text) {
      applied.push({ rule: 'reaction-aa', from: repaired.from, to: repaired.to });
      text = repaired.text;
    }
  }

  const well = markers.find(item => item.rule === 'well-opener' && item.confidence === 'clear');
  if (well && !applied.some(item => item.rule.startsWith('well-opener'))) {
    const repaired = repairFirstWord(text, word => word.toLocaleLowerCase('tr') === 'kuyu', 'Şey');
    if (repaired && repaired.text !== text) {
      applied.push({ rule: 'well-not-kuyu', from: repaired.from, to: repaired.to });
      text = repaired.text;
    }
  }

  const right = markers.find(item => item.confidence === 'clear' && (item.rule === 'right-opener' || item.rule === 'right-confirmation' || item.rule === 'right-question-tag'));
  const directionalSource = markers.some(item => item.rule === 'right-not-discourse');
  if (right?.survivingSpoken && !directionalSource && !applied.some(item => item.rule.startsWith('right-'))) {
    const hits = findAll(text, 'sağ');
    const first = firstWordSpan(text);
    const last = lastWordSpan(text);
    const hit = hits.length === 1 ? hits[0] : null;
    if (hit && (hit.start === first?.start || hit.start === last?.start)) {
      const spoken = right.survivingSpoken;
      text = replaceSpan(text, hit, spoken);
      applied.push({ rule: `${right.rule}-not-sag`, from: hit.surface, to: spoken });
    }
  }

  return { text: cleanup(text), applied };
}
