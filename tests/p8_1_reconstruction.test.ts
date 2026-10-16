import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  coverageGaps,
  reconstructTranscript,
  ReconstructionCue,
  tokenizeText,
} from '../src/subtitles/TranscriptReconstructor';
import { experimentalContextualTranslationEnabled, translationPipeline } from '../src/translation/ContextualTranslationFlag';

const cue = (index: number, start: number, end: number, text: string, extra: Partial<ReconstructionCue> = {}): ReconstructionCue => ({
  id: `cue-${index}`,
  index,
  startTime: start,
  endTime: end,
  text,
  role: 'utterance',
  ...extra,
});

describe('P8.1 transcript reconstruction', () => {
  it('joins a punctuated thought that was split across cues', () => {
    const result = reconstructTranscript([
      cue(0, 0, 1.8, "I think that what we're seeing"),
      cue(1, 1.8, 3.4, 'with these models is'),
      cue(2, 3.4, 5.6, 'a fundamental change in computing.'),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].text).toBe("I think that what we're seeing with these models is a fundamental change in computing.");
    expect(result.units[0].completeness).toBe('complete');
    expect(result.units[0].boundary.forced).toBe(false);
    expect(result.units[0].sourceCueIds).toEqual(['cue-0', 'cue-1', 'cue-2']);
    expect(coverageGaps(result)).toEqual({ missing: [], duplicated: [] });
  });

  it('splits a standard caption at its own punctuation without using cue boundaries', () => {
    const result = reconstructTranscript([
      cue(0, 118.08, 122.64, 'in solar panels. You have to get permits. Try getting the permits for that. See what happens.'),
    ]);
    expect(result.units.map(unit => unit.text)).toEqual([
      'in solar panels.',
      'You have to get permits.',
      'Try getting the permits for that.',
      'See what happens.',
    ]);
    expect(result.units.every(unit => unit.completeness === 'complete')).toBe(true);
  });

  it('keeps the authentic process repetition when word times do not overlap', () => {
    const result = reconstructTranscript([
      cue(126, 268.16, 272.199, 'competition very involved process'),
      cue(127, 269.759, 274.24, "process so basically what we're doing"),
    ]);
    const text = result.units.map(unit => unit.text).join(' ');
    expect(text.match(/\bprocess\b/g)).toHaveLength(2);
    expect(result.drops).toHaveLength(0);
    expect(result.unresolvedOverlaps[0]?.text).toBe('process');
    expect(coverageGaps(result).missing).toEqual([]);
  });

  it('keeps the authentic chunk repetition instead of deleting overlapping cue text', () => {
    const result = reconstructTranscript([
      cue(1056, 2214.44, 2217.76, 'consume words they just go chunk chunk'),
      cue(1057, 2215.96, 2219.8, 'chunk chunk chunk chunk chunk and then'),
    ]);
    const source = tokenizeText('consume words they just go chunk chunk chunk chunk chunk chunk chunk and then');
    const kept = result.units.flatMap(unit => unit.tokens.map(token => token.text));
    expect(kept).toEqual(source);
    expect(result.drops).toHaveLength(0);
  });

  it('drops a rolling snapshot prefix and a time-aligned duplicate, and does not join a hyphen', () => {
    const rolling = reconstructTranscript([
      cue(0, 10, 14, 'if you can predict the next word', { role: 'rolling_snapshot' }),
      cue(1, 12, 16, 'the next word very accurately now', { role: 'rolling_snapshot' }),
    ]);
    expect(rolling.units.map(unit => unit.text).join(' ')).toBe('if you can predict the next word very accurately now');
    expect(rolling.drops.map(drop => drop.reason)).toEqual(['rolling_snapshot_overlap', 'rolling_snapshot_overlap', 'rolling_snapshot_overlap']);

    const duplicate = reconstructTranscript([
      cue(0, 1.0, 2.4, 'think of llms as kind of'),
      cue(1, 1.1, 2.5, 'think of llms as kind of'),
    ]);
    expect(duplicate.units).toHaveLength(1);
    expect(duplicate.units[0].text).toBe('think of llms as kind of');
    expect(duplicate.drops).toHaveLength(6);

    const hyphen = reconstructTranscript([
      cue(0, 0, 1.2, 'train-'),
      cue(1, 1.2, 2.2, 'ing data.'),
    ]);
    expect(hyphen.units[0].text).toContain('train-');
    expect(hyphen.units.map(unit => unit.text).join(' ')).toBe('train- ing data.');
    expect(hyphen.units.some(unit => unit.uncertainty.includes('hyphen_left_unjoined'))).toBe(true);
  });

  it('does not invent a speaker and does not merge explicit turns or split Dr.', () => {
    const plain = reconstructTranscript([
      cue(0, 0, 2, 'Hello there friends.'),
      cue(1, 2.2, 4, 'I agree with that.'),
    ]);
    expect(plain.units.every(unit => unit.speakerId === undefined)).toBe(true);

    const turns = reconstructTranscript([
      cue(0, 0, 1.4, 'Dr. Smith spoke today.', { speakerId: 'a', speakerExplicit: true }),
      cue(1, 1.5, 2.6, 'I agree.', { speakerId: 'b', speakerExplicit: true }),
    ]);
    expect(turns.units.map(unit => unit.text)).toEqual(['Dr. Smith spoke today.', 'I agree.']);
    expect(turns.units.map(unit => unit.speakerId)).toEqual(['a', 'b']);
    expect(turns.units[0].boundary.kind).toBe('punctuation');
  });

  it('keeps a percent sign and does not strand the last word of a punctuated sentence', () => {
    const percent = reconstructTranscript([cue(0, 164.16, 170.48, 'The atmosphere alone results in about a 30% loss of energy.')]);
    expect(percent.units.map(unit => unit.text)).toEqual(['The atmosphere alone results in about a 30% loss of energy.']);
    const tail = reconstructTranscript([
      cue(0, 311.94, 321.2, "Those who have lived in software land don't realize they're about to have a hard lesson in hardware."),
    ]);
    expect(tail.units.map(unit => unit.text)).toEqual([
      "Those who have lived in software land don't realize they're about to have a hard lesson in hardware.",
    ]);
  });

  it('marks a hard cut on long unpunctuated speech and still covers every token', () => {
    const words = Array.from({ length: 46 }, (_, index) => `word${index}`);
    const result = reconstructTranscript([
      cue(0, 0, 20, words.join(' ')),
    ]);
    expect(result.units.length).toBeGreaterThan(1);
    expect(result.units.some(unit => unit.boundary.forced)).toBe(true);
    expect(result.units.every(unit => unit.tokens.length <= 28)).toBe(true);
    expect(result.units.map(unit => unit.tokens.map(token => token.text).join(' ')).join(' ')).toBe(words.join(' '));
    expect(coverageGaps(result)).toEqual({ missing: [], duplicated: [] });
    expect(result.drops).toHaveLength(0);
  });

  it('breaks a long unit before a clause starter instead of inside a noun phrase', () => {
    const text = 'we have already walked through the training objective in quite a lot of detail so the next question is how the parameters are stored';
    const result = reconstructTranscript([cue(0, 0, 9.5, text)]);
    const joined = result.units.map(unit => unit.text);
    expect(joined.join(' ')).toBe(text);
    expect(joined.some(unit => unit.endsWith(' detail'))).toBe(true);
    expect(joined.some(unit => unit.startsWith('so the next'))).toBe(true);
    expect(joined.some(unit => /\ba$/.test(unit) || unit.endsWith(' the'))).toBe(false);
  });
});

describe('P8.1 pipeline flag', () => {
  it('stays off and is not referenced by playback', () => {
    expect(experimentalContextualTranslationEnabled).toBe(false);
    expect(translationPipeline()).toBe('production');
    expect(translationPipeline(true)).toBe('experimental');
    const content = readFileSync('entrypoints/content.ts', 'utf8');
    const scheduler = readFileSync('src/audio/DubbingScheduler.ts', 'utf8');
    expect(content).not.toContain('TranscriptReconstructor');
    expect(content).not.toContain('ContextAwareTranslator');
    expect(content).not.toContain('experimentalContextualTranslationEnabled');
    expect(content).toContain('speechResegmentationEnabled: false');
    expect(scheduler).not.toContain('TranscriptReconstructor');
    expect(scheduler).not.toContain('ContextAwareTranslator');
  });
});
