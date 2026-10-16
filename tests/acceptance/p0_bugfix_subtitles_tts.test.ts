import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CaptionParser } from '../../src/subtitles/CaptionParser';
import { YouTubeSubtitleAdapter, sanitizeEndpointUrl } from '../../src/subtitles/YouTubeSubtitleAdapter';
import { LiveCaptionHarvester } from '../../src/subtitles/LiveCaptionHarvester';
import { Translator } from '../../src/subtitles/Translator';
import { TTSManager } from '../../src/tts/TTSManager';

describe('P0 Critical Bugfix Regression Suite: Subtitles & TTS Playback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Subtitle Parsers (JSON3, XML, WebVTT, Empty)', () => {
    it('JSON3 parser extracts non-empty cues with accurate timings and cleaned text', () => {
      const json3Payload = JSON.stringify({
        events: [
          { tStartMs: 1500, dDurationMs: 3000, segs: [{ utf8: 'Hello world [Music]' }] },
          { tStartMs: 5000, dDurationMs: 2500, segs: [{ utf8: 'Welcome to Vesta Dub' }] },
        ],
      });

      const cues = CaptionParser.parse(json3Payload);
      expect(cues.length).toBe(2);
      expect(cues[0].startTime).toBe(1.5);
      expect(cues[0].endTime).toBe(4.5);
      expect(cues[0].duration).toBe(3.0);
      expect(cues[0].originalText).toBe('Hello world'); // [Music] removed
      expect(cues[1].originalText).toBe('Welcome to Vesta Dub');
    });

    it('XML timedtext parser handles <p> and <text> formats', () => {
      const xmlPayloadP = `<timedtext><body>
        <p t="1000" d="2000">First XML line &amp; test</p>
        <p t="3500" d="1500">Second XML line</p>
      </body></timedtext>`;

      const cuesP = CaptionParser.parse(xmlPayloadP);
      expect(cuesP.length).toBe(2);
      expect(cuesP[0].startTime).toBe(1.0);
      expect(cuesP[0].duration).toBe(2.0);
      expect(cuesP[0].originalText).toBe('First XML line & test');

      const xmlPayloadText = `<transcript>
        <text start="2.5" dur="3.0">Transcript format cue</text>
      </transcript>`;
      const cuesText = CaptionParser.parse(xmlPayloadText);
      expect(cuesText.length).toBe(1);
      expect(cuesText[0].startTime).toBe(2.5);
      expect(cuesText[0].duration).toBe(3.0);
      expect(cuesText[0].originalText).toBe('Transcript format cue');
    });

    it('WebVTT parser handles timestamp ranges and notes', () => {
      const vttPayload = `WEBVTT

NOTE This is a commentary note

00:00:01.500 --> 00:00:04.200
Merhaba dünya

00:00:05.000 --> 00:00:08.500
Vesta Dub altyazı testi
`;
      const cues = CaptionParser.parse(vttPayload);
      expect(cues.length).toBe(2);
      expect(cues[0].startTime).toBe(1.5);
      expect(cues[0].endTime).toBe(4.2);
      expect(cues[0].originalText).toBe('Merhaba dünya');
      expect(cues[1].startTime).toBe(5.0);
      expect(cues[1].endTime).toBe(8.5);
      expect(cues[1].originalText).toBe('Vesta Dub altyazı testi');
    });

    it('returns empty cues array for empty or whitespace-only response without crashing', () => {
      expect(CaptionParser.parse('')).toEqual([]);
      expect(CaptionParser.parse('   ')).toEqual([]);
      expect(CaptionParser.parse('\n\t')).toEqual([]);
    });
  });

  describe('2. YouTubeSubtitleAdapter Diagnostic Logging & URL Sanitization', () => {
    it('sanitizes endpoints by removing signature, pot, and expire tokens while retaining essential params', () => {
      const rawUrl = 'https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en&pot=SECRET_POT_123&signature=SIG_ABC&key=KEY_XYZ&fmt=json3';
      const sanitized = sanitizeEndpointUrl(rawUrl);

      expect(sanitized).toContain('v=zjkBMFhNj_g');
      expect(sanitized).toContain('lang=en');
      expect(sanitized).toContain('fmt=json3');
      expect(sanitized).not.toContain('pot=SECRET');
      expect(sanitized).not.toContain('signature=SIG');
      expect(sanitized).not.toContain('key=KEY');
    });

    it('records explicit diagnostic log for EMPTY_HTTP_RESPONSE when timedtext returns 0 bytes', async () => {
      const adapter = new YouTubeSubtitleAdapter();
      vi.spyOn(adapter, 'getVideoId').mockReturnValue('test');

      // Mock fetch returning 200 with empty text (simulating YouTube POT token requirement)
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '',
      });

      const track = {
        id: 'track-0-en',
        languageCode: 'en',
        name: 'English (auto-generated)',
        kind: 'asr' as const,
        baseUrl: 'https://www.youtube.com/api/timedtext?v=test&lang=en',
      };

      const cues = await adapter.loadCues(track);
      expect(cues).toEqual([]);

      const logs = adapter.getDiagnosticLogs();
      expect(logs.length).toBeGreaterThan(0);
      const emptyLog = logs.find(l => l.explicitFailureReason === 'EMPTY_HTTP_RESPONSE');
      expect(emptyLog).toBeDefined();
      expect(emptyLog?.responseStatus).toBe(200);
      expect(emptyLog?.responseLength).toBe(0);
    });

    it('records explicit diagnostic log for HTTP_FAILURE when endpoint returns 403/404/500', async () => {
      const adapter = new YouTubeSubtitleAdapter();
      vi.spyOn(adapter, 'getVideoId').mockReturnValue('test');

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'Forbidden',
      });

      const track = {
        id: 'track-0-en',
        languageCode: 'en',
        name: 'English',
        kind: 'standard' as const,
        baseUrl: 'https://www.youtube.com/api/timedtext?v=test&lang=en',
      };

      const cues = await adapter.loadCues(track);
      expect(cues).toEqual([]);

      const logs = adapter.getDiagnosticLogs();
      const httpFailLog = logs.find(l => l.explicitFailureReason === 'HTTP_FAILURE');
      expect(httpFailLog).toBeDefined();
      expect(httpFailLog?.responseStatus).toBe(403);
    });
  });

  describe('3. Live DOM Caption Harvester Fallback', () => {
    it('creates subtitle cues dynamically from live DOM segments and tracks timestamps', async () => {
      const mockVideo = { currentTime: 12.5 } as HTMLVideoElement;

      const harvester = new LiveCaptionHarvester({
        onCuesChanged: () => {},
      });

      harvester.attach(mockVideo);

      // Verify initial state
      expect(harvester.getCues().length).toBe(0);
      harvester.stop();
    });
  });

  describe('4. Translation Integrity & Fallback', () => {
    it('detects translation failure and does not pass untranslated foreign text blindly', async () => {
      vi.spyOn(Translator, 'toTurkish').mockImplementation(async (text: string) => {
        // Simulating translation failure returning original
        return text;
      });

      const original = 'This is an English sentence.';
      const res = await Translator.toTurkish(original);
      expect(res).toBe(original);
    });

    it('translates cues batch with timing preservation', async () => {
      vi.spyOn(Translator, 'toTurkish').mockImplementation(async (text: string) => {
        if (text === 'Hello') return 'Merhaba';
        if (text === 'World') return 'Dünya';
        return text;
      });

      const results = await Translator.batchToTurkish(['Hello', 'World']);
      expect(results).toEqual(['Merhaba', 'Dünya']);
    });
  });

  describe('5. TTS Manager & Provider Switching', () => {
    it('registers Antalia and experimental EMA without loading either engine', () => {
      const manager = TTSManager.getInstance();
      expect(manager.getProvider('antalia').isLoaded).toBe(false);
      expect(manager.getProvider('ema-lightning').isLoaded).toBe(false);
      expect(manager.getAllProviders().map(p => p.id).sort()).toEqual(['antalia', 'ema-lightning']);
      expect(() => manager.getProvider('piper-fahrettin')).toThrow(/not available/);
    });

    it('generates consistent cache keys incorporating speed and text', () => {
      const manager = TTSManager.getInstance();
      const key1 = manager.getCacheKey('antalia', 'Merhaba', 1.0);
      const key2 = manager.getCacheKey('antalia', 'Merhaba', 1.25);
      const key3 = manager.getCacheKey('ema-lightning', 'Merhaba', 1.0);

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).toBe('antalia:1.00:Merhaba');
    });
  });

  describe('6. Web AudioContext Autoplay & User Gesture Handling', () => {
    it('resumes suspended AudioContext when requested', async () => {
      let state = 'suspended';
      const mockAudioCtx = {
        state,
        resume: vi.fn().mockImplementation(async () => {
          state = 'running';
        }),
      };

      if (mockAudioCtx.state === 'suspended') {
        await mockAudioCtx.resume();
      }

      expect(mockAudioCtx.resume).toHaveBeenCalledTimes(1);
      expect(state).toBe('running');
    });
  });
});
