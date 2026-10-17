import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DubbingScheduler } from '../src/audio/DubbingScheduler';
import { SpeakerManager } from '../src/speaker/SpeakerManager';
import type { SubtitleCue } from '../src/core/types';
import { planBoundedContext, boundedContextTranslationEnabled, repeatsEdge } from '../src/translation/BoundedContextWindow';
import { buildCueQualityTrace, redactTraceDetail } from '../src/tts/CueQualityTrace';
import { classifyDiscourse } from '../src/tts/DiscourseMarkers';
import { prepareSpeech } from '../src/tts/FillerPreparation';
import { TurkishSpeechNormalizer } from '../src/tts/TurkishSpeechNormalizer';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/quality/v011-corpus.json', import.meta.url), 'utf8')) as {
  cases: Array<{ id: string; origin: string; sourceText: string; note: string }>;
};

function spoken(source: string, display = source, discourse = true) {
  return prepareSpeech(display, { sourceText: source, discourse });
}

describe('v0.1.1 discourse', () => {
  it('keeps yeah as an affirmation and never rewrites it to ah', () => {
    const agree = spoken('Yeah, I agree.', 'Yeah, katılıyorum.');
    expect(agree.displayText).toBe('Yeah, katılıyorum.');
    expect(agree.spokenText).toBe('Evet, katılıyorum.');
    expect(agree.spokenText.toLocaleLowerCase('tr')).not.toContain('ah');
    expect(agree.removedTokenCount).toBe(0);
    expect(agree.omitted).toBe(false);

    const kept = spoken('Yeah, I agree.', 'Evet, katılıyorum.');
    expect(kept.spokenText).toBe('Evet, katılıyorum.');
    expect(kept.discourseApplied).toEqual([]);

    const question = spoken('Yeah?', 'Yeah?');
    expect(question.spokenText).toBe('Öyle mi?');
    expect(question.omitted).toBe(false);

    const gloss = spoken('Yeah.', 'Ah.');
    expect(gloss.spokenText).toBe('Evet.');
    expect(gloss.discourseApplied.map(item => item.rule)).toContain('affirmation-not-ah');
  });

  it('preserves disagreement, questions, and different functions of the same word', () => {
    expect(spoken('Yeah, no.', 'Yeah, no.').spokenText).toBe('Yeah, no.');
    expect(spoken('yes or no', 'yes or no').spokenText).toBe('yes or no');
    expect(spoken('Well, that\'s complicated.', 'Kuyu, bu karmaşık.').spokenText).toBe('Şey, bu karmaşık.');
    expect(spoken('as well as the model', 'model de kuyu gibi').spokenText).toBe('model de kuyu gibi');
    expect(spoken('the well is deep', 'kuyu derin').spokenText).toBe('kuyu derin');
    expect(spoken('Oh, now I understand.', 'Oh, şimdi anlıyorum.').spokenText).toBe('Aa, şimdi anlıyorum.');
    expect(spoken('Oh, now I understand.', 'Şimdi anladım.').spokenText).toBe('Şimdi anladım.');
    expect(spoken('Uh, I don\'t know.', 'Uh, bilmiyorum.').spokenText).toBe('bilmiyorum.');
    expect(spoken('um there will be two files in this', "Um'de iki dosya olacak").spokenText).toBe('iki dosya olacak');
    expect(spoken('the town of Um', "Um'de iki dosya var").spokenText).toBe("Um'de iki dosya var");
    expect(spoken('Yeah, I agree.', '- Evet, katılıyorum.').displayText).toBe('- Evet, katılıyorum.');
    expect(spoken('Yeah, I agree.', '- Evet, katılıyorum.').spokenText).toBe('Evet, katılıyorum.');
    expect(spoken('uh', 'uh').filteredText).toBe('uh');
    expect(spoken('uh', 'uh').omitted).toBe(false);
    expect(spoken('Right, let\'s continue.', 'Sağ, devam edelim.').spokenText).toBe('Tamam, devam edelim.');
    expect(spoken('right now', 'right now').spokenText).toBe('right now');
    expect(spoken('on the right', 'sağda').spokenText).toBe('sağda');
    expect(spoken('Sure.', 'Sure.').spokenText).toBe('Tabii.');
    expect(spoken('make sure', 'make sure').spokenText).toBe('make sure');
    expect(spoken('Actually, the model is smaller.', 'Actually model daha küçük.').spokenText).toBe('aslında model daha küçük.');
    expect(spoken('Yeah, exactly.', 'Yeah, exactly.').spokenText).toBe('Evet, aynen.');
    expect(spoken('Yeah, exactly.', 'Evet, aynen öyle.').spokenText).toBe('Evet, aynen öyle.');
    expect(spoken('Uh-huh.', 'Uh-huh.').spokenText).toBe('Uh-huh.');
    expect(spoken('mm-hmm', 'mm-hmm').spokenText).toBe('hı hı');
    expect(spoken('Ah, I see.', 'Ah, görüyorum.').spokenText).toBe('Ah, görüyorum.');
    expect(spoken('uh-uh', 'uh-uh').spokenText).toBe('ı-ıh');
    expect(spoken('hmm', 'hmm').spokenText).toBe('hmm');
    expect(classifyDiscourse('yeah').every(item => item.fn !== 'hesitation')).toBe(true);
  });

  it('does not classify authentic acknowledgements as disposable hesitations', () => {
    for (const row of corpus.cases.filter(item => item.origin === 'authentic')) {
      const markers = classifyDiscourse(row.sourceText);
      for (const item of markers) {
        if (['yeah', 'yes', 'yep', 'right', 'sure', 'actually', 'well'].includes(item.text.toLocaleLowerCase('en-US'))) {
          expect(item.action, row.id).not.toBe('remove');
        }
        if (item.text.toLocaleLowerCase('en-US') === 'yeah') expect(item.fn, row.id).not.toBe('hesitation');
      }
      const preparation = spoken(row.sourceText, row.sourceText);
      expect(preparation.displayText).toBe(row.sourceText);
      expect(preparation.spokenText.toLocaleLowerCase('tr')).not.toMatch(/\bah\b/);
    }
  });
});

describe('v0.1.1 pronunciation', () => {
  it('speaks Tesla Model Y as Ye and leaves the display text unchanged', () => {
    expect(TurkishSpeechNormalizer.normalize('Tesla Model Y').spokenText).toBe('Tesla Model Ye');
    expect(TurkishSpeechNormalizer.normalize('Tesla Model Y').displayText).toBe('Tesla Model Y');
    const line = TurkishSpeechNormalizer.normalize('Yeni Tesla Model Y geldi.');
    expect(line.displayText).toBe('Yeni Tesla Model Y geldi.');
    expect(line.spokenText).toBe('Yeni Tesla Model Ye geldi.');
    expect(TurkishSpeechNormalizer.normalize("Tesla Model Y'nin fiyatı").spokenText).toBe("Tesla Model Ye'nin fiyatı");
    expect(TurkishSpeechNormalizer.normalize('model y parametresi', { profile: 'candidate' }).spokenText).toBe('model y parametresi');
    expect(TurkishSpeechNormalizer.normalize('Bu yay yeni bir model.').spokenText).toBe('Bu yay yeni bir model.');
    expect(TurkishSpeechNormalizer.normalize('Bu ay yeni bir model geldi.').spokenText).toBe('Bu ay yeni bir model geldi.');
    expect(TurkishSpeechNormalizer.normalize('Y koordinatı 12').spokenText).toBe('Y koordinatı on iki');
  });

  it('keeps existing technical readings and does not stack product rules', () => {
    expect(TurkishSpeechNormalizer.normalize('RTX 5090').spokenText).toBe('ar ti eks beş bin doksan');
    expect(TurkishSpeechNormalizer.normalize('GPT-4 ve ChatGPT').spokenText).toBe('ci pi ti dört ve çet ci pi ti');
    expect(TurkishSpeechNormalizer.normalize('OpenAI, NVIDIA, LLM').spokenText).toBe('opın ey ay, envidya, el el em');
    expect(TurkishSpeechNormalizer.normalize('MacBook, iPhone, YouTube, GitHub').spokenText).toBe('mekbuk, ayfon, yutub, githap');
    expect(TurkishSpeechNormalizer.normalize('Tesla Model 3 ve Tesla Model S').spokenText).toBe('Tesla Model üç ve Tesla Model S');
    expect(TurkishSpeechNormalizer.normalize('Tesla Model 3 ve Tesla Model S', { profile: 'candidate' }).spokenText).toBe('Tesla Model üç ve Tesla Model Es');
    expect(TurkishSpeechNormalizer.normalize('Tesla Model Y ve AI').spokenText).toBe('Tesla Model Ye ve ey ay');
    const stacked = TurkishSpeechNormalizer.normalize('Tesla Model Y').spokenText;
    expect(stacked.match(/Ye/g)).toHaveLength(1);
    expect(stacked).not.toMatch(/Model Model|Tesla Tesla/);
  });
});

describe('v0.1.1 context window', () => {
  const cues = [
    { id: 'a', text: 'just kind of like an intro talk um', startTime: 4.24, endTime: 8.48 },
    { id: 'b', text: 'to large language models', startTime: 6.4, endTime: 10.08 },
    { id: 'c', text: 'Yeah. All of the United States currently uses only half a terawatt on average.', startTime: 291.6, endTime: 298.56 },
    { id: 'd', text: 'The next sentence starts much later.', startTime: 320, endTime: 326 },
  ];

  it('stays off playback and never reads a future live cue', () => {
    expect(boundedContextTranslationEnabled).toBe(false);
    const live = planBoundedContext(cues, 0, 'live');
    expect(live.contextAfter).toBe('');
    expect(live.playbackEnabled).toBe(false);
    expect(live.combinedText).not.toContain('to large language models');
    const preloaded = planBoundedContext(cues, 0, 'preloaded');
    expect(preloaded.contextAfter).toBe('to large language models');
    expect(preloaded.contextBefore).toBe('');
    expect(preloaded.targetText).toBe(cues[0].text);
    expect(preloaded.combinedText).toBe(`${cues[0].text} ${cues[1].text}`);
    const complete = planBoundedContext(cues, 2, 'preloaded');
    expect(complete.contextAfter).toBe('');
    expect(complete.combinedText).toBe(cues[2].text);
    expect(repeatsEdge('parameters of the neural network', 'neural network so here I took')).toBe(true);
    expect(repeatsEdge('language model really well', 'language model is just two files')).toBe(false);
  });

  it('is not referenced by the scheduler or the content script', () => {
    const scheduler = readFileSync(new URL('../src/audio/DubbingScheduler.ts', import.meta.url), 'utf8');
    const content = readFileSync(new URL('../entrypoints/content.ts', import.meta.url), 'utf8');
    expect(scheduler).not.toContain('BoundedContextWindow');
    expect(scheduler).not.toContain('planBoundedContext');
    expect(content).not.toContain('BoundedContextWindow');
    expect(content).not.toContain('TranscriptSentenceAssembler');
  });
});

describe('v0.1.1 cue trace', () => {
  it('explains stages in memory and redacts caption text from production trace events', async () => {
    const trace = buildCueQualityTrace({ sourceText: 'Yeah, I agree.', turkishText: 'Yeah, katılıyorum.' });
    expect(trace.persist).toBe(false);
    expect(trace.stages.map(stage => stage.stage)).toEqual(['source', 'translation-display', 'filler', 'discourse', 'tts-input']);
    expect(trace.displayText).toBe('Yeah, katılıyorum.');
    expect(trace.spokenText).toBe('Evet, katılıyorum.');
    const redacted = redactTraceDetail({ text: 'SECRET_CAPTION_PHRASE', displayText: 'GİZLİ cümle', tokens: [{ text: 'SECRET', category: 'word', action: 'keep', rule: 'ordinary-word' }] });
    expect(JSON.stringify(redacted)).not.toContain('SECRET');
    expect(JSON.stringify(redacted)).not.toContain('GİZLİ');
    expect(redacted.tokenRules).toEqual([{ category: 'word', action: 'keep', rule: 'ordinary-word' }]);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    const tts = { synthesize: vi.fn().mockResolvedValue({ audio: Float32Array.from({ length: 480 }, () => 0.1), sampleRate: 48000, duration: 0.01 }) };
    const audio = { createAudioBuffer: vi.fn().mockResolvedValue({ duration: 0.01, length: 480, numberOfChannels: 1 }), unduckVideo: vi.fn() };
    const scheduler = new DubbingScheduler(audio as never, tts as never, new SpeakerManager());
    const cue: SubtitleCue = { id: 'yeah', index: 0, startTime: 1, endTime: 2, duration: 1, originalText: 'SECRET_CAPTION_PHRASE yeah', turkishText: 'GİZLİ yeah' };
    scheduler.setCues([cue]);
    await scheduler['ensureSynthesized'](cue);
    const dumped = JSON.stringify(scheduler.trace) + logs.join('\n');
    expect(dumped).not.toContain('SECRET_CAPTION_PHRASE');
    expect(dumped).not.toContain('GİZLİ');
    expect(cue.turkishText).toBe('GİZLİ yeah');
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
