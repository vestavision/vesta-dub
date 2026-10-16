import { SubtitleCue } from '../core/types';

export class CaptionParser {
  /**
   * Decode HTML entities in text strings
   */
  static decodeHtml(html: string): string {
    return html
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n+/g, ' ')
      .trim();
  }

  /**
   * Clean subtitle text by removing sound annotations like [Music], (Laughter), etc.
   */
  static cleanText(text: string): string {
    return this.decodeHtml(text)
      .replace(/\[[^\]]*\]/g, '')  // Remove [Music], [Applause], etc.
      .replace(/\([^\)]*\)/g, '')  // Remove (Laughter), etc.
      .replace(/\s{2,}/g, ' ')     // Collapse whitespace
      .trim();
  }

  /**
   * Parse YouTube json3 format
   * { "events": [ { "tStartMs": 1000, "dDurationMs": 2500, "segs": [ { "utf8": "Hello" } ] } ] }
   */
  static parseJson3(jsonText: string): SubtitleCue[] {
    try {
      const data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
      const events = data.events || [];
      const cues: SubtitleCue[] = [];
      let index = 0;

      for (const event of events) {
        if (!event.segs || event.tStartMs === undefined) continue;

        const text = event.segs.map((s: { utf8?: string }) => s.utf8 || '').join('');
        const cleaned = this.cleanText(text);
        if (!cleaned) continue;

        const start = event.tStartMs / 1000;
        const duration = (event.dDurationMs || 2000) / 1000;
        const end = start + duration;

        cues.push({
          id: `cue-${index}`,
          index,
          startTime: start,
          endTime: end,
          duration,
          originalText: cleaned,
          turkishText: cleaned, // Will be set to Turkish if translated
          speakerId: 'speaker-a',
        });
        index++;
      }

      return cues;
    } catch (err) {
      console.error('[VestaDub] Failed to parse json3 captions:', err);
      return [];
    }
  }

  /**
   * Parse YouTube XML timedtext format
   * <timedtext><body><p t="1000" d="2500">Hello</p></body></timedtext>
   * or <transcript><text start="1.0" dur="2.5">Hello</text></transcript>
   */
  static parseXml(xmlText: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    let index = 0;

    // Pattern 1: <p t="1000" d="2000">...</p>
    const pRegex = /<p\s+[^>]*t="(\d+)"(?:\s+[^>]*d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    let match;

    while ((match = pRegex.exec(xmlText)) !== null) {
      const startMs = parseInt(match[1], 10);
      const durMs = match[2] ? parseInt(match[2], 10) : 2000;
      const rawText = match[3].replace(/<[^>]+>/g, '');
      const cleaned = this.cleanText(rawText);

      if (cleaned) {
        cues.push({
          id: `cue-${index}`,
          index,
          startTime: startMs / 1000,
          endTime: (startMs + durMs) / 1000,
          duration: durMs / 1000,
          originalText: cleaned,
          turkishText: cleaned,
          speakerId: 'speaker-a',
        });
        index++;
      }
    }

    if (cues.length > 0) return cues;

    // Pattern 2: <text start="1.5" dur="2.0">...</text>
    const textRegex = /<text\s+[^>]*start="([\d.]+)"(?:\s+[^>]*dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
    while ((match = textRegex.exec(xmlText)) !== null) {
      const start = parseFloat(match[1]);
      const dur = match[2] ? parseFloat(match[2]) : 2.0;
      const rawText = match[3].replace(/<[^>]+>/g, '');
      const cleaned = this.cleanText(rawText);

      if (cleaned) {
        cues.push({
          id: `cue-${index}`,
          index,
          startTime: start,
          endTime: start + dur,
          duration: dur,
          originalText: cleaned,
          turkishText: cleaned,
          speakerId: 'speaker-a',
        });
        index++;
      }
    }

    return cues;
  }

  /**
   * Parse WebVTT format
   */
  static parseVtt(vttText: string): SubtitleCue[] {
    const lines = vttText.split(/\r?\n/);
    const cues: SubtitleCue[] = [];
    let index = 0;

    const timeRegex = /(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})/;

    const parseSeconds = (h: string | undefined, m: string, s: string, ms: string) => {
      const hours = h ? parseInt(h, 10) : 0;
      const minutes = parseInt(m, 10);
      const seconds = parseInt(s, 10);
      const millis = parseInt(ms, 10);
      return hours * 3600 + minutes * 60 + seconds + millis / 1000;
    };

    let currentStart = -1;
    let currentEnd = -1;
    let currentText = '';

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(timeRegex);

      if (match) {
        if (currentStart >= 0 && currentText.trim()) {
          const cleaned = this.cleanText(currentText);
          if (cleaned) {
            cues.push({
              id: `cue-${index}`,
              index,
              startTime: currentStart,
              endTime: currentEnd,
              duration: currentEnd - currentStart,
              originalText: cleaned,
              turkishText: cleaned,
              speakerId: 'speaker-a',
            });
            index++;
          }
        }
        currentStart = parseSeconds(match[1], match[2], match[3], match[4]);
        currentEnd = parseSeconds(match[5], match[6], match[7], match[8]);
        currentText = '';
      } else if (currentStart >= 0 && trimmed && !trimmed.startsWith('NOTE') && !/^\d+$/.test(trimmed)) {
        currentText += (currentText ? ' ' : '') + trimmed;
      }
    }

    if (currentStart >= 0 && currentText.trim()) {
      const cleaned = this.cleanText(currentText);
      if (cleaned) {
        cues.push({
          id: `cue-${index}`,
          index,
          startTime: currentStart,
          endTime: currentEnd,
          duration: currentEnd - currentStart,
          originalText: cleaned,
          turkishText: cleaned,
          speakerId: 'speaker-a',
        });
      }
    }

    return cues;
  }

  /**
   * Universal parser for any subtitle format
   */
  static parse(text: string): SubtitleCue[] {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.includes('"events"')) {
      return this.parseJson3(trimmed);
    }
    if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
      return this.parseVtt(trimmed);
    }
    return this.parseXml(trimmed);
  }
}
