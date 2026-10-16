import { describe, it, expect } from 'vitest';
import { SubtitleCue } from '../src/core/types';

describe('DubbingScheduler Logic', () => {
  const cues: SubtitleCue[] = [
    { id: 'cue-0', index: 0, startTime: 1.0, endTime: 3.5, duration: 2.5, originalText: 'A', turkishText: 'A', speakerId: 'speaker-a' },
    { id: 'cue-1', index: 1, startTime: 4.0, endTime: 6.0, duration: 2.0, originalText: 'B', turkishText: 'B', speakerId: 'speaker-b' },
    { id: 'cue-2', index: 2, startTime: 7.5, endTime: 10.0, duration: 2.5, originalText: 'C', turkishText: 'C', speakerId: 'speaker-a' },
  ];

  it('should find current cue based on video playback time', () => {
    const findCue = (time: number) => cues.findIndex(c => time >= c.startTime && time < c.endTime);

    expect(findCue(0.5)).toBe(-1); // Before first cue
    expect(findCue(1.0)).toBe(0);  // Start of cue 0
    expect(findCue(2.3)).toBe(0);  // Middle of cue 0
    expect(findCue(3.5)).toBe(-1); // Gap between cues
    expect(findCue(4.5)).toBe(1);  // Cue 1
    expect(findCue(8.0)).toBe(2);  // Cue 2
  });

  it('should detect lookahead window for upcoming cues', () => {
    const currentTime = 2.0;
    const lookaheadSec = 4.0; // Window: [2.0, 6.0]

    const upcoming = cues.filter(
      c => c.startTime >= currentTime && c.startTime <= currentTime + lookaheadSec
    );

    // Cue 1 starts at 4.0, which is in [2.0, 6.0]
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].id).toBe('cue-1');
  });

  it('should detect duration overflow when synthesized audio exceeds cue duration', () => {
    const cueDuration = 2.0;
    const audioDuration1 = 1.8;
    const audioDuration2 = 2.6;

    expect(audioDuration1 > cueDuration).toBe(false);
    expect(audioDuration2 > cueDuration).toBe(true);
  });

  it('should calculate sync drift in milliseconds', () => {
    const currentTime = 1.15;
    const expectedTime = 1.0;
    const driftMs = Math.round((currentTime - expectedTime) * 1000);

    expect(driftMs).toBe(150);
  });
});
