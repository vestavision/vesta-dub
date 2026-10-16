import { describe, expect, it } from 'vitest';
import { alignSpeaker, SpeakerTimeline, type SpeakerSegment } from '../src/speaker/SpeakerAlignment';
import { auditJson3 } from '../src/speaker/SpeakerMetadataAudit';
import { SpeakerManager } from '../src/speaker/SpeakerManager';
const s = (speakerId: string, a: number, b: number, confidence: number | null = null): SpeakerSegment =>
  ({ speakerId, sourceStartMs: a, sourceEndMs: b, confidence, provenance: 'local-diarization' });
describe('P6 conservative phrase alignment', () => {
  it('retains identity after seek and excludes other videos', () => {
    const t = new SpeakerTimeline('video', [s('speaker-a', 0, 1000), s('speaker-b', 1000, 2000)]);
    expect(t.assign('video', 1000, 2000).speakerId).toBe('speaker-b');
    expect(t.assign('video', 0, 1000).speakerId).toBe('speaker-a');
    expect(t.assign('video', 1000, 2000).speakerId).toBe('speaker-b');
    expect(t.assign('other', 0, 1000).speakerId).toBeNull();
  });
  it('abstains on adjacent turns inside one phrase rather than duplicating it', () => {
    expect(alignSpeaker(0, 2000, [s('a', 0, 1000), s('b', 1000, 2000)]).reason).toBe('mixed-speakers');
  });
  it('abstains on overlapping speakers and low confidence', () => {
    expect(alignSpeaker(0, 1000, [s('a', 0, 1000), s('b', 400, 450)]).reason).toBe('overlap');
    expect(alignSpeaker(0, 1000, [s('a', 0, 1000, 0.2)]).reason).toBe('low-confidence');
  });
  it('does not inflate coverage with duplicate windows or assign silence', () => {
    expect(alignSpeaker(0, 1000, [s('a', 0, 500), s('a', 0, 500)]).reason).toBe('partial-coverage');
    expect(alignSpeaker(0, 1000, []).speakerId).toBeNull();
    expect(alignSpeaker(0, 1000, [s('a', 0, 1000)]).confidence).toBeNull();
  });
  it('keeps diagnostic engine mapping stable without inventing identity', () => {
    const m = new SpeakerManager();
    expect(m.getProviderForSpeaker('speaker-a')).toBe('antalia');
    expect(m.getProviderForSpeaker('speaker-b')).toBe('ema-lightning');
    expect(m.getProviderForSpeaker()).toBe('antalia');
  });
  it('does not treat cue, window, formatting or segment offsets as speakers', () => {
    const audit = auditJson3({ events: [{ tStartMs: 0, wWinId: 7, segs: [{ utf8: 'Hello. Next sentence.', tOffsetMs: 0 }] }] });
    expect(audit.usableSpeakerIdentity).toBe(false);
    expect(audit.explicitSpeakerFields).toEqual([]);
  });
});
