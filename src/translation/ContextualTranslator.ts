/**
 * Context-aware Turkish translation for assembled sentences.
 * Uses the existing Google Translate path. No new model and no paid API.
 * Technical terms are protected before translation so fragment-level MT
 * cannot turn "LLMs" into "films".
 * A rate-limited batch is not split into per-sentence requests.
 */

import { isTranslationRateLimit, TranslationRateLimitError } from './TranslationRateLimit';

export interface GlossaryRestore {
  placeholder: string;
  turkish: string;
  source: string;
}

export interface SentenceTranslation {
  turkish: string;
  compromises: string[];
  aligned: boolean;
  protectedText: string;
}

interface GlossaryRule {
  pattern: RegExp;
  placeholder: string;
  turkish: string;
  source: string;
}

const GLOSSARY: GlossaryRule[] = [
  { pattern: /\bLLMs\b/gi, placeholder: 'ZXLLMS', turkish: 'büyük dil modelleri', source: 'LLMs' },
  { pattern: /\bLLM\b/gi, placeholder: 'ZXLLM', turkish: 'büyük dil modeli', source: 'LLM' },
  { pattern: /\bOpenAI\b/g, placeholder: 'ZXOPENAI', turkish: 'OpenAI', source: 'OpenAI' },
  { pattern: /\bGPT-4o\b/gi, placeholder: 'ZXGPT4O', turkish: 'GPT-4o', source: 'GPT-4o' },
  { pattern: /\bGPT-4\b/gi, placeholder: 'ZXGPT4', turkish: 'GPT-4', source: 'GPT-4' },
  { pattern: /\bGPT-3\.5\b/gi, placeholder: 'ZXGPT35', turkish: 'GPT-3.5', source: 'GPT-3.5' },
  { pattern: /\bGPTs\b/gi, placeholder: 'ZXGPTS', turkish: 'GPT modelleri', source: 'GPTs' },
  { pattern: /\bGPT\b/gi, placeholder: 'ZXGPT', turkish: 'GPT', source: 'GPT' },
  { pattern: /\bMacBooks\b/gi, placeholder: 'ZXMACBOOKS', turkish: 'MacBooklar', source: 'MacBooks' },
  { pattern: /\bMacBook\b/gi, placeholder: 'ZXMACBOOK', turkish: 'MacBook', source: 'MacBook' },
  { pattern: /\bA\.I\.\b/gi, placeholder: 'ZXAI', turkish: 'AI', source: 'A.I.' },
  { pattern: /\bAI\b/g, placeholder: 'ZXAI', turkish: 'AI', source: 'AI' },
  { pattern: /\bRTX\b/g, placeholder: 'ZXRTX', turkish: 'RTX', source: 'RTX' },
  { pattern: /\bMeta\b/g, placeholder: 'ZXMETA', turkish: 'Meta', source: 'Meta' },
];

export function protectSource(text: string): { text: string; restores: GlossaryRestore[] } {
  const restores: GlossaryRestore[] = [];
  let protectedText = text;
  if (/\bweird\b/i.test(protectedText) && /\bstrange\b/i.test(protectedText)) {
    protectedText = protectedText.replace(/\bweird\b/gi, 'ZXWEIRD').replace(/\bstrange\b/gi, 'ZXSTRANGE');
    restores.push(
      { placeholder: 'ZXWEIRD', turkish: 'tuhaf', source: 'weird' },
      { placeholder: 'ZXSTRANGE', turkish: 'garip', source: 'strange' },
    );
  }
  for (const rule of GLOSSARY) {
    if (!rule.pattern.test(protectedText)) continue;
    rule.pattern.lastIndex = 0;
    protectedText = protectedText.replace(rule.pattern, rule.placeholder);
    restores.push({ placeholder: rule.placeholder, turkish: rule.turkish, source: rule.source });
  }
  return { text: protectedText, restores };
}

export function restoreProtected(text: string, restores: GlossaryRestore[]): string {
  let out = text;
  for (const item of restores) {
    out = out.replaceAll(item.placeholder, item.turkish);
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function findSemanticCompromises(source: string, translated: string): string[] {
  const issues: string[] = [];
  const repetition = translated.matchAll(/(\b[\p{L}]{3,}\b)\s+ve\s+\1\b/giu);
  for (const match of repetition) {
    const word = match[1];
    const sourceRepeats = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(source);
    if (!sourceRepeats) issues.push(`unnatural_repetition:${word.toLowerCase()}`);
  }
  if (/\bZX[A-Z0-9]+\b/.test(translated)) issues.push('unrestored_placeholder');
  if (translated.trim() && source.trim() && translated.trim() === source.trim() && source.trim().length > 12) {
    issues.push('untranslated_passthrough');
  }
  return issues;
}

export function splitTranslatedBatch(translated: string, expected: number): { lines: string[]; aligned: boolean } {
  const lines = translated.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (expected <= 1) return { lines: [translated.trim()], aligned: true };
  return { lines, aligned: lines.length === expected };
}

export async function translateSentences(
  sentences: string[],
  translate: (text: string) => Promise<string>,
  isCurrent: () => boolean = () => true,
): Promise<SentenceTranslation[]> {
  const prepared = sentences.map(sentence => {
    const protectedSource = protectSource(sentence);
    return { source: sentence, ...protectedSource };
  });
  const results: SentenceTranslation[] = prepared.map(item => ({
    turkish: '',
    compromises: ['not_translated'],
    aligned: false,
    protectedText: item.text,
  }));

  for (let offset = 0; offset < prepared.length; offset += 3) {
    if (!isCurrent()) break;
    const slice = prepared.slice(offset, offset + 3);
    const request = slice.map(item => item.text).join('\n');
    let aligned = false;
    let lines: string[] = [];
    try {
      const response = await translate(request);
      if (!isCurrent()) break;
      const split = splitTranslatedBatch(response, slice.length);
      aligned = split.aligned;
      lines = split.lines;
    } catch (error) {
      if (isTranslationRateLimit(error)) throw rateLimitStopped(results, offset, error);
      aligned = false;
      lines = [];
      for (let i = 0; i < slice.length; i++) {
        results[offset + i].compromises = [`translation_error:${error instanceof Error ? error.message : String(error)}`];
      }
    }

    if (!aligned) {
      for (let i = 0; i < slice.length; i++) {
        if (!isCurrent()) break;
        try {
          const alone = slice.length === 1 && lines[0] ? lines[0] : await translate(slice[i].text);
          const turkish = restoreProtected(alone, slice[i].restores);
          results[offset + i] = {
            turkish,
            compromises: findSemanticCompromises(slice[i].source, turkish),
            aligned: false,
            protectedText: slice[i].text,
          };
        } catch (error) {
          if (isTranslationRateLimit(error)) throw rateLimitStopped(results, offset + i, error);
          results[offset + i].compromises = [`translation_error:${error instanceof Error ? error.message : String(error)}`];
        }
      }
      continue;
    }

    for (let i = 0; i < slice.length; i++) {
      const turkish = restoreProtected(lines[i] || '', slice[i].restores);
      results[offset + i] = {
        turkish,
        compromises: findSemanticCompromises(slice[i].source, turkish),
        aligned: true,
        protectedText: slice[i].text,
      };
    }
  }

  return results;
}

function rateLimitStopped(results: SentenceTranslation[], from: number, error: unknown): TranslationRateLimitError {
  for (let i = from; i < results.length; i++) {
    if (results[i].turkish.trim()) continue;
    results[i] = { ...results[i], turkish: '', compromises: ['translation_rate_limited'], aligned: false };
  }
  const retryAfterMs = error instanceof TranslationRateLimitError ? error.retryAfterMs : null;
  return new TranslationRateLimitError(retryAfterMs, results);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
