import { describe, expect, it } from 'vitest';
import { TranslationRateLimitError } from '../src/translation/TranslationRateLimit';
import {
  buildRequest,
  leaksContext,
  parseTargetLines,
  protectExperimental,
  translateWithContext,
  ContextTranslationRateLimit,
} from '../src/translation/ContextAwareTranslator';
import { predictTiming, segmentTurkish } from '../src/eval/SpeechTimingShadow';

describe('P8.1 context-aware translation', () => {
  it('returns only target lines and keeps glossary terms', async () => {
    const requests: string[] = [];
    const results = await translateWithContext([
      { id: 'a', text: 'Llama is an LLM.', completeness: 'complete' },
      { id: 'b', text: 'The GPU stays local.', completeness: 'partial' },
    ], async text => {
      requests.push(text);
      return text.replace('<c0> ', '<c0> ONCEKI ').replace(/<t(\d)> /g, '<t$1> TR ');
    });
    expect(results.map(result => result.turkish)).toEqual([
      'TR Llama is an büyük dil modeli.',
      'TR The GPU stays local.',
    ]);
    expect(results[0].turkish).not.toContain('ONCEKI');
    expect(results[0].turkish).not.toContain('<c0>');
    expect(results[0].contextBefore).toBe('');
    expect(results[1].contextBefore).toContain('Llama');
    expect(results.every(result => result.aligned)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('ZXLLAMA');
    expect(requests[0]).toContain('ZXLLM');
    expect(requests[0]).toContain('ZXGPU');
    expect(requests[0]).not.toContain('<c1>');
  });

  it('sends following context only for an incomplete batch edge and rejects a context leak', async () => {
    const requests: string[] = [];
    const results = await translateWithContext([
      { id: 'a', text: 'One complete sentence here.', completeness: 'complete' },
      { id: 'b', text: 'Two complete sentence here.', completeness: 'complete' },
      { id: 'c', text: 'The weights are open.', completeness: 'uncertain' },
      { id: 'd', text: 'Ruth Handler appears later.', completeness: 'complete' },
    ], async text => {
      requests.push(text);
      if (text.includes('<c1>')) return '<t0> TR one\n<t1> TR two\n<t2> TR weights Ruth\n<c1> Ruth Handler appears later.';
      return `TR ${text}`;
    });
    expect(requests[0]).toContain('<c1>');
    expect(requests[0]).toContain('Ruth Handler');
    expect(results[2].fallback).toBe('target_only');
    expect(results[2].contextLeak).toBe(true);
    expect(results[2].turkish).not.toMatch(/\bRuth\b/);
    expect(results[2].compromises).toContain('context_leak_rejected');
    expect(results[0].turkish).toBe('TR one');
    expect(results[0].contextLeak).toBe(false);
    expect(leaksContext('TR Ruth', '', 'Ruth Handler appears later.', 'The weights are open.')).toBe(true);
  });

  it('does not fan out a rate-limited batch', async () => {
    let calls = 0;
    const error = translateWithContext([
      { id: 'a', text: 'First sentence here.', completeness: 'complete' },
      { id: 'b', text: 'Second sentence here.', completeness: 'complete' },
      { id: 'c', text: 'Third sentence here.', completeness: 'complete' },
    ], async () => {
      calls += 1;
      throw new TranslationRateLimitError(1200);
    });
    await expect(error).rejects.toBeInstanceOf(ContextTranslationRateLimit);
    expect(calls).toBe(1);
  });

  it('falls back once per target when tags are lost, then stops on 429', async () => {
    let calls = 0;
    await expect(translateWithContext([
      { id: 'a', text: 'Alpha sentence one.', completeness: 'complete' },
      { id: 'b', text: 'Beta sentence two.', completeness: 'complete' },
    ], async () => {
      calls += 1;
      if (calls === 1) return 'tek satir';
      throw new TranslationRateLimitError(null);
    })).rejects.toBeInstanceOf(ContextTranslationRateLimit);
    expect(calls).toBe(2);
  });

  it('parses tagged lines and protects experimental terms before the base glossary', () => {
    expect(parseTargetLines('<c0> hidden\n<t0> bir\n<t1> iki\n<c1> sonra', 2)).toEqual(['bir', 'iki']);
    expect(parseTargetLines('çeviri yok', 2)).toBeNull();
    const protectedSource = protectExperimental('meta released Llama on YouTube');
    expect(protectedSource.text).toContain('ZXMETA2');
    expect(protectedSource.text).toContain('ZXLLAMA');
    expect(protectedSource.text).toContain('ZXYT');
    expect(buildRequest('before', ['one'], '').startsWith('<c0> before')).toBe(true);
  });
});

describe('P8.1 timing shadow', () => {
  it('does not estimate speech duration without Turkish and does not split a short sentence', () => {
    const [missing] = predictTiming([{ id: 'a', text: 'Hello there.', turkish: '', startTime: 0, endTime: 2 }]);
    expect(missing.estimateBasis).toBe('not_estimated');
    expect(missing.estimatedSpeechSec).toBeNull();
    expect(missing.firstAudioWaitSec).toBe(2);

    const [present] = predictTiming([{
      id: 'b',
      text: 'Hello there.',
      turkish: 'Merhaba, nasılsın bugün?',
      startTime: 1,
      endTime: 3.5,
    }]);
    expect(present.estimateBasis).toBe('antalia_syllables_per_sec');
    expect(present.segments).toEqual([{ text: present.spokenText, reason: 'whole_unit' }]);
    expect(present.segmentsCoverTranslation).toBe(true);
    expect(present.overlapNext).toBe(false);
  });

  it('segments a long Turkish sentence on punctuation without dropping words', () => {
    const spoken = 'Bu modeller bilgisayar teknolojisinde köklü bir değişimi temsil ediyor. Aynı cümle ikinci parçada da sürüyor ve anlamı korunuyor.';
    const parts = segmentTurkish(spoken, 9.5);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(part => part.text).join(' ')).toBe(spoken);
    expect(parts.every(part => part.reason === 'punctuation')).toBe(true);
  });
});
