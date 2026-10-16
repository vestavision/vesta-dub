import { describe, it, expect } from 'vitest';
import { CaptionParser } from '../src/subtitles/CaptionParser';

describe('CaptionParser', () => {
  it('should clean text and strip html entities and annotations', () => {
    const raw = 'Hello &amp; welcome! [Applause] (Laughter) &#39;World&#39;';
    const cleaned = CaptionParser.cleanText(raw);
    expect(cleaned).toBe("Hello & welcome! 'World'");
  });

  it('should parse YouTube json3 caption events correctly', () => {
    const json3 = JSON.stringify({
      events: [
        {
          tStartMs: 1500,
          dDurationMs: 2500,
          segs: [{ utf8: 'Merhaba ' }, { utf8: 'dünya!' }],
        },
        {
          tStartMs: 4200,
          dDurationMs: 3100,
          segs: [{ utf8: 'Vesta Dub ile dublaj testi.' }],
        },
      ],
    });

    const cues = CaptionParser.parseJson3(json3);
    expect(cues).toHaveLength(2);

    expect(cues[0].startTime).toBe(1.5);
    expect(cues[0].endTime).toBe(4.0);
    expect(cues[0].duration).toBe(2.5);
    expect(cues[0].originalText).toBe('Merhaba dünya!');
    expect(cues[0].speakerId).toBe('speaker-a');

    expect(cues[1].startTime).toBe(4.2);
    expect(cues[1].duration).toBe(3.1);
    expect(cues[1].originalText).toBe('Vesta Dub ile dublaj testi.');
  });

  it('should parse YouTube XML timedtext format', () => {
    const xml = `
      <timedtext format="3">
        <body>
          <p t="1000" d="2000">İlk altyazı cümlesi</p>
          <p t="3500" d="1800">İkinci altyazı cümlesi</p>
        </body>
      </timedtext>
    `;

    const cues = CaptionParser.parseXml(xml);
    expect(cues).toHaveLength(2);
    expect(cues[0].startTime).toBe(1.0);
    expect(cues[0].duration).toBe(2.0);
    expect(cues[0].originalText).toBe('İlk altyazı cümlesi');

    expect(cues[1].startTime).toBe(3.5);
    expect(cues[1].duration).toBe(1.8);
    expect(cues[1].originalText).toBe('İkinci altyazı cümlesi');
  });

  it('should parse WebVTT format', () => {
    const vtt = `WEBVTT

00:00:01.200 --> 00:00:03.500
Web VTT formatında altyazı

00:00:04.000 --> 00:00:07.100
İkinci satır altyazı
`;

    const cues = CaptionParser.parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].startTime).toBe(1.2);
    expect(cues[0].endTime).toBe(3.5);
    expect(cues[0].originalText).toBe('Web VTT formatında altyazı');

    expect(cues[1].startTime).toBe(4.0);
    expect(cues[1].endTime).toBe(7.1);
    expect(cues[1].originalText).toBe('İkinci satır altyazı');
  });

  it('should automatically detect format using universal parse()', () => {
    const jsonStr = '{"events":[{"tStartMs":500,"dDurationMs":1000,"segs":[{"utf8":"Test"}]}]}';
    const cues = CaptionParser.parse(jsonStr);
    expect(cues).toHaveLength(1);
    expect(cues[0].originalText).toBe('Test');
  });

  it('should return empty list gracefully for invalid or empty caption strings', () => {
    expect(CaptionParser.parse('')).toEqual([]);
    expect(CaptionParser.parse('   ')).toEqual([]);
    expect(CaptionParser.parseJson3('{"invalid": true}')).toEqual([]);
  });
});
