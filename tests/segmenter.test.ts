import { describe, it, expect } from 'vitest';
import { SpeechSegmenter } from '../src/subtitles/SpeechSegmenter';
import { SubtitleCue } from '../src/core/types';

describe('SpeechSegmenter', () => {
  it('merges fragmented ASR subtitles into complete sentences', () => {
    const rawCues: SubtitleCue[] = [
      { id: '1', index: 0, startTime: 1.0, endTime: 1.8, duration: 0.8, originalText: 'Bu yapay zeka', turkishText: 'Bu yapay zeka' },
      { id: '2', index: 1, startTime: 1.9, endTime: 2.6, duration: 0.7, originalText: 'modeli çok', turkishText: 'modeli çok' },
      { id: '3', index: 2, startTime: 2.7, endTime: 3.8, duration: 1.1, originalText: 'hızlı çalışıyor.', turkishText: 'hızlı çalışıyor.' },
    ];

    const segmented = SpeechSegmenter.segment(rawCues);
    expect(segmented.length).toBe(1);
    expect(segmented[0].turkishText).toBe('Bu yapay zeka modeli çok hızlı çalışıyor.');
    expect(segmented[0].startTime).toBe(1.0);
    expect(segmented[0].endTime).toBe(3.8);
    expect(segmented[0].mergedFromCount).toBe(3);
  });

  it('preserves sentence boundaries and does not merge across different sentences when long enough', () => {
    const rawCues: SubtitleCue[] = [
      { id: '1', index: 0, startTime: 1.0, endTime: 3.2, duration: 2.2, originalText: 'İlk cümle bitti.', turkishText: 'İlk cümle bitti.' },
      { id: '2', index: 1, startTime: 3.5, endTime: 5.5, duration: 2.0, originalText: 'İkinci cümle başladı.', turkishText: 'İkinci cümle başladı.' },
    ];

    const segmented = SpeechSegmenter.segment(rawCues);
    expect(segmented.length).toBe(2);
    expect(segmented[0].turkishText).toBe('İlk cümle bitti.');
    expect(segmented[1].turkishText).toBe('İkinci cümle başladı.');
  });

  it('splits or limits segment duration when exceeding maxDurationSec', () => {
    const rawCues: SubtitleCue[] = [
      { id: '1', index: 0, startTime: 0.0, endTime: 4.0, duration: 4.0, originalText: 'Burası uzun bir giriş konuşması ve', turkishText: 'Burası uzun bir giriş konuşması ve' },
      { id: '2', index: 1, startTime: 4.1, endTime: 8.5, duration: 4.4, originalText: 'burada konuşmacı nefes almadan devam ediyor.', turkishText: 'burada konuşmacı nefes almadan devam ediyor.' },
    ];

    const segmented = SpeechSegmenter.segment(rawCues, { maxDurationSec: 6.0 });
    // Total duration 8.5s > 6.0s, so they should not merge into one block
    expect(segmented.length).toBe(2);
  });

  it('strictly enforces monotonic timestamps without backward jumps', () => {
    const overlappingCues: SubtitleCue[] = [
      { id: '1', index: 0, startTime: 2.0, endTime: 4.0, duration: 2.0, originalText: 'Birinci parça.', turkishText: 'Birinci parça.' },
      { id: '2', index: 1, startTime: 3.5, endTime: 5.0, duration: 1.5, originalText: 'İkinci parça.', turkishText: 'İkinci parça.' },
    ];

    const segmented = SpeechSegmenter.segment(overlappingCues);
    expect(segmented.length).toBe(2);
    expect(segmented[0].startTime).toBe(2.0);
    expect(segmented[0].endTime).toBe(4.0);
    // Second cue start time must be >= first cue end time
    expect(segmented[1].startTime).toBeGreaterThanOrEqual(segmented[0].endTime);
  });

  it('handles hyphenated words split across cues gracefully', () => {
    const splitCues: SubtitleCue[] = [
      { id: '1', index: 0, startTime: 0.5, endTime: 1.2, duration: 0.7, originalText: 'oto-', turkishText: 'oto-' },
      { id: '2', index: 1, startTime: 1.3, endTime: 2.0, duration: 0.7, originalText: 'mobil', turkishText: 'mobil' },
    ];

    const segmented = SpeechSegmenter.segment(splitCues);
    expect(segmented.length).toBe(1);
    expect(segmented[0].turkishText).toBe('otomobil');
  });

  it('does not merge cues across different speakers', () => {
    const speakerCues: SubtitleCue[] = [
      { id: '1', index: 0, startTime: 1.0, endTime: 2.0, duration: 1.0, originalText: 'Merhaba.', turkishText: 'Merhaba.', speakerId: 'speaker-1' },
      { id: '2', index: 1, startTime: 2.2, endTime: 3.2, duration: 1.0, originalText: 'Nasılsınız?', turkishText: 'Nasılsınız?', speakerId: 'speaker-2' },
    ];

    const segmented = SpeechSegmenter.segment(speakerCues);
    expect(segmented.length).toBe(2);
    expect(segmented[0].speakerId).toBe('speaker-1');
    expect(segmented[1].speakerId).toBe('speaker-2');
  });
});
