/**
 * Experimental translator for reconstructed sentence units.
 *
 * The unofficial Google endpoint accepts one `q` string. It has no field for
 * context that must not appear in the output. Context is sent on tagged lines
 * and discarded. If the tags do not come back, each target is translated alone.
 * A 429 stops the batch; it is not fanned out into retries.
 *
 * Previous context is the sentence before a batch. Following context is sent
 * only when the last unit in the batch is not already a complete sentence.
 * In-batch neighbors are real targets and are returned as their own lines.
 */

import { isTranslationRateLimit, TranslationRateLimitError } from './TranslationRateLimit';
import {
  findSemanticCompromises,
  GlossaryRestore,
  protectSource,
  restoreProtected,
} from './ContextualTranslator';

export interface ContextUnit {
  id: string;
  text: string;
  /** Complete units do not pull the following sentence into the request. */
  completeness?: 'complete' | 'partial' | 'uncertain';
}

export interface ContextTranslation {
  id: string;
  sourceText: string;
  turkish: string;
  protectedText: string;
  /** Original English context. Informing text, not part of the translation. */
  contextBefore: string;
  contextAfter: string;
  contextPolicy: 'none' | 'previous' | 'following' | 'previous_and_following';
  /** True when a hidden context line was included for this unit. */
  contextUsed: boolean;
  /** True when a context-only word survived into the candidate and was discarded. */
  contextLeak: boolean;
  aligned: boolean;
  fallback: 'none' | 'target_only' | 'untranslated';
  compromises: string[];
  /** Transport calls made by the time this unit was finalized. */
  requests: number;
}

interface PreparedUnit {
  unit: ContextUnit;
  protectedText: string;
  restores: GlossaryRestore[];
  contextBefore: string;
  contextAfter: string;
  contextBeforeProtected: string;
  contextAfterProtected: string;
  contextPolicy: ContextTranslation['contextPolicy'];
}

const EXTRA_GLOSSARY: Array<{ pattern: RegExp; placeholder: string; turkish: string; source: string }> = [
  { pattern: /\bGPUs\b/g, placeholder: 'ZXGPUS', turkish: "GPU'lar", source: 'GPUs' },
  { pattern: /\bGPU\b/g, placeholder: 'ZXGPU', turkish: 'GPU', source: 'GPU' },
  { pattern: /\bLlama\b/g, placeholder: 'ZXLLAMA', turkish: 'Llama', source: 'Llama' },
  { pattern: /\bTransformer\b/g, placeholder: 'ZXTRANS', turkish: 'Transformer', source: 'Transformer' },
  { pattern: /\bWikipedia\b/g, placeholder: 'ZXWIKI', turkish: 'Wikipedia', source: 'Wikipedia' },
  { pattern: /\bYouTube\b/g, placeholder: 'ZXYT', turkish: 'YouTube', source: 'YouTube' },
  { pattern: /\bmeta\b/g, placeholder: 'ZXMETA2', turkish: 'Meta', source: 'meta' },
];

export class ContextTranslationRateLimit extends TranslationRateLimitError {
  constructor(retryAfterMs: number | null, readonly translations: ContextTranslation[]) {
    super(retryAfterMs, translations);
    this.name = 'ContextTranslationRateLimit';
  }
}

export async function translateWithContext(
  units: ContextUnit[],
  translate: (text: string) => Promise<string>,
  isCurrent: () => boolean = () => true,
): Promise<ContextTranslation[]> {
  const prepared = units.map((unit, index) => prepareUnit(units, index));
  const results: ContextTranslation[] = prepared.map(item => emptyResult(item));
  let requests = 0;

  for (let offset = 0; offset < prepared.length; offset += 3) {
    if (!isCurrent()) break;
    const slice = prepared.slice(offset, offset + 3);
    const hiddenBefore = slice[0].contextBeforeProtected;
    const last = slice[slice.length - 1];
    const hiddenAfter = last.unit.completeness === 'complete' ? '' : last.contextAfterProtected;
    const request = buildRequest(hiddenBefore, slice.map(item => item.protectedText), hiddenAfter);
    requests += 1;
    let parsed: string[] | null = null;
    try {
      const response = await translate(request);
      if (!isCurrent()) break;
      parsed = parseTargetLines(response, slice.length);
    } catch (error) {
      if (isTranslationRateLimit(error)) throw stopped(results, offset, requests, error);
      parsed = null;
    }

    if (!parsed) {
      for (let index = 0; index < slice.length; index++) {
        if (!isCurrent()) break;
        try {
          requests += 1;
          const alone = await translateOne(slice[index], translate);
          results[offset + index] = finish(slice[index], alone, {
            contextUsed: false,
            contextLeak: false,
            aligned: false,
            fallback: 'target_only',
            requests,
          });
        } catch (error) {
          if (isTranslationRateLimit(error)) throw stopped(results, offset + index, requests, error);
          results[offset + index].compromises = [`translation_error:${messageOf(error)}`];
          results[offset + index].fallback = 'untranslated';
          results[offset + index].requests = requests;
        }
      }
      continue;
    }

    for (let index = 0; index < slice.length; index++) {
      if (!isCurrent()) break;
      const item = slice[index];
      const restored = restoreProtected(parsed[index] || '', item.restores);
      const leaked = leaksContext(restored, item.contextBefore, item.contextAfter, item.unit.text);
      const contextUsed = (index === 0 && Boolean(hiddenBefore)) || (index === slice.length - 1 && Boolean(hiddenAfter));
      if (!leaked) {
        results[offset + index] = finish(item, restored, {
          contextUsed,
          contextLeak: false,
          aligned: true,
          fallback: 'none',
          requests,
        });
        continue;
      }
      try {
        requests += 1;
        const alone = await translateOne(item, translate);
        results[offset + index] = finish(item, alone, {
          contextUsed: false,
          contextLeak: true,
          aligned: false,
          fallback: 'target_only',
          requests,
        });
      } catch (error) {
        if (isTranslationRateLimit(error)) throw stopped(results, offset + index, requests, error);
        const kept = finish(item, restored, {
          contextUsed,
          contextLeak: true,
          aligned: true,
          fallback: 'none',
          requests,
        });
        kept.compromises = [...kept.compromises.filter(itemName => itemName !== 'context_leak_rejected'), 'context_leak_unresolved', `translation_error:${messageOf(error)}`];
        results[offset + index] = kept;
      }
    }
  }

  return results;
}

async function translateOne(item: PreparedUnit, translate: (text: string) => Promise<string>): Promise<string> {
  return translate(item.protectedText);
}

export function buildRequest(contextBefore: string, targets: string[], contextAfter: string): string {
  const lines: string[] = [];
  if (contextBefore.trim()) lines.push(`<c0> ${contextBefore.trim()}`);
  targets.forEach((target, index) => lines.push(`<t${index}> ${target.trim()}`));
  if (contextAfter.trim()) lines.push(`<c1> ${contextAfter.trim()}`);
  return lines.join('\n');
}

export function parseTargetLines(response: string, expected: number): string[] | null {
  if (expected <= 0) return [];
  const found = new Map<number, string>();
  const pattern = /<t\s*(\d+)\s*>\s*([\s\S]*?)(?=<t\s*\d+\s*>|<c\s*\d+\s*>|$)/gi;
  for (const match of response.matchAll(pattern)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= expected || found.has(index)) continue;
    found.set(index, match[2].replace(/\s+/g, ' ').trim());
  }
  if (found.size !== expected) return null;
  return Array.from({ length: expected }, (_, index) => found.get(index) || '');
}

/** Context-only English words that survive untranslated count as leakage. Translated sense shifts are not visible here. */
export function leaksContext(turkish: string, contextBefore: string, contextAfter: string, target: string): boolean {
  const output = turkish.toLowerCase();
  const targetWords = distinctiveWords(target);
  for (const context of [contextBefore, contextAfter]) {
    const snippet = context.replace(/\s+/g, ' ').trim();
    if (snippet.length >= 24 && output.includes(snippet.toLowerCase())) return true;
    for (const word of distinctiveWords(snippet)) {
      if (targetWords.has(word)) continue;
      if (new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(turkish)) return true;
    }
  }
  return false;
}

function prepareUnit(units: ContextUnit[], index: number): PreparedUnit {
  const unit = units[index];
  const before = index > 0 ? units[index - 1].text.trim() : '';
  const after = index + 1 < units.length ? units[index + 1].text.trim() : '';
  const follow = unit.completeness !== 'complete' && Boolean(after);
  const contextPolicy: PreparedUnit['contextPolicy'] = before && follow
    ? 'previous_and_following'
    : before ? 'previous' : follow ? 'following' : 'none';
  const guarded = protectExperimental(unit.text);
  return {
    unit,
    protectedText: guarded.text,
    restores: guarded.restores,
    contextBefore: before,
    contextAfter: follow ? after : '',
    contextBeforeProtected: before ? protectExperimental(before).text : '',
    contextAfterProtected: follow ? protectExperimental(after).text : '',
    contextPolicy,
  };
}

export function protectExperimental(text: string): { text: string; restores: GlossaryRestore[] } {
  const restores: GlossaryRestore[] = [];
  let protectedText = text;
  for (const rule of EXTRA_GLOSSARY) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(protectedText)) continue;
    rule.pattern.lastIndex = 0;
    protectedText = protectedText.replace(rule.pattern, rule.placeholder);
    restores.push({ placeholder: rule.placeholder, turkish: rule.turkish, source: rule.source });
  }
  const base = protectSource(protectedText);
  return { text: base.text, restores: [...restores, ...base.restores] };
}

function emptyResult(item: PreparedUnit): ContextTranslation {
  return {
    id: item.unit.id,
    sourceText: item.unit.text,
    turkish: '',
    protectedText: item.protectedText,
    contextBefore: item.contextBefore,
    contextAfter: item.contextAfter,
    contextPolicy: item.contextPolicy,
    contextUsed: false,
    contextLeak: false,
    aligned: false,
    fallback: 'untranslated',
    compromises: ['not_translated'],
    requests: 0,
  };
}

function finish(
  item: PreparedUnit,
  turkish: string,
  flags: { contextUsed: boolean; contextLeak: boolean; aligned: boolean; fallback: ContextTranslation['fallback']; requests: number },
): ContextTranslation {
  const clean = turkish.replace(/\s+/g, ' ').trim();
  const compromises = findSemanticCompromises(item.unit.text, clean);
  if (flags.contextLeak && flags.fallback === 'target_only') compromises.push('context_leak_rejected');
  return {
    id: item.unit.id,
    sourceText: item.unit.text,
    turkish: clean,
    protectedText: item.protectedText,
    contextBefore: item.contextBefore,
    contextAfter: item.contextAfter,
    contextPolicy: item.contextPolicy,
    contextUsed: flags.contextUsed,
    contextLeak: flags.contextLeak,
    aligned: flags.aligned,
    fallback: flags.fallback,
    compromises,
    requests: flags.requests,
  };
}

function stopped(results: ContextTranslation[], from: number, requests: number, error: unknown): ContextTranslationRateLimit {
  for (let index = from; index < results.length; index++) {
    if (results[index].turkish.trim()) continue;
    results[index] = { ...results[index], turkish: '', fallback: 'untranslated', compromises: ['translation_rate_limited'], requests };
  }
  const retryAfterMs = error instanceof TranslationRateLimitError ? error.retryAfterMs : null;
  return new ContextTranslationRateLimit(retryAfterMs, results);
}

const CONTEXT_STOPWORDS = new Set([
  'that', 'with', 'this', 'from', 'have', 'were', 'they', 'them', 'then', 'than', 'into', 'your',
  'just', 'very', 'here', 'been', 'does', 'what', 'when', 'some', 'only', 'also', 'such', 'over',
  'after', 'before', 'about', 'there', 'their', 'would', 'could', 'should', 'because', 'which',
  'where', 'really', 'being', 'those', 'these', 'other', 'while', 'every',
]);

function distinctiveWords(text: string): Set<string> {
  const words = text.match(/[A-Za-z][A-Za-z0-9]{1,}/g) || [];
  return new Set(words.map(word => word.toLowerCase()).filter(word => word.length >= 4 && !CONTEXT_STOPWORDS.has(word)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
