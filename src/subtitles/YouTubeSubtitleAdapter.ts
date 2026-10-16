import { SubtitleCue, SubtitleTrack } from '../core/types';
import { CaptionParser } from './CaptionParser';
import { isPauseFeatureEnabled } from '../diagnostics/PauseIsolation';

export interface RawCaptionTrack {
  baseUrl: string;
  name: { simpleText?: string; runs?: Array<{ text: string }> };
  vssId?: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
}

export type SubtitleFailureReason =
  | 'VIDEO_ID_MISMATCH'
  | 'MISSING_TRACK'
  | 'HTTP_FAILURE'
  | 'EMPTY_HTTP_RESPONSE'
  | 'INVALID_CAPTION_FORMAT'
  | 'PARSER_FAILURE'
  | 'TRANSLATION_FAILURE'
  | 'EXTENSION_MESSAGING_FAILURE';

export interface SubtitleDiagnosticLog {
  timestamp: string;
  videoId: string;
  trackLanguage: string;
  trackKind: string;
  requestedEndpoint: string;
  responseStatus: number;
  executionContext: 'page' | 'content_script' | 'background';
  responseContentType: string;
  responseLength: number;
  parserSelected: 'json3' | 'xml' | 'vtt' | 'none';
  cuesExtracted: number;
  translationStatus: 'native_tr' | 'youtube_auto_translated' | 'local_translated' | 'failed' | 'skipped';
  explicitFailureReason: SubtitleFailureReason | null;
  detail?: string;
}

/**
 * Sanitize URLs to remove tokens, signatures, pot, and private params
 */
export function sanitizeEndpointUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const safeParams = new URLSearchParams();
    for (const [key, val] of parsed.searchParams.entries()) {
      if (['v', 'lang', 'fmt', 'tlang', 'kind'].includes(key)) {
        safeParams.set(key, val);
      }
    }
    const query = safeParams.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return rawUrl.split('?')[0];
  }
}

export class YouTubeSubtitleAdapter {
  // MAIN and ISOLATED worlds do not share window expandos. Retain delivered
  // payloads in the adapter's own world, including arrivals between load attempts.
  private nativePayloads = new Map<string, { text: string; requestId?: string }>();
  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('vesta-caption-payload', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.videoId !== this.getVideoId() || typeof detail.text !== 'string' || !detail.text.trim()) return;
      if (String(detail.languageCode || '').startsWith('tlang:')) return;
      if (!CaptionParser.parse(detail.text).length) return;
      this.nativePayloads.set(`${detail.videoId}:${detail.languageCode || ''}`, { text: detail.text, requestId: detail.requestId });
      // Bound retained tracks; navigation clears these too.
      if (this.nativePayloads.size > 8) this.nativePayloads.delete(this.nativePayloads.keys().next().value!);
    });
  }

  private currentVideoId: string | null = null;
  private cachedTracks: SubtitleTrack[] = [];
  private diagnosticLogs: SubtitleDiagnosticLog[] = [];

  /**
   * Log development diagnostics adhering to privacy and categorization requirements
   */
  logDiagnostic(log: SubtitleDiagnosticLog): void {
    this.diagnosticLogs.push(log);
    if (process.env.NODE_ENV !== 'production' || typeof console !== 'undefined') {
      console.log(
        `[VestaDub Diag] Subtitle Event: [${log.explicitFailureReason || 'SUCCESS'}] | Track: ${log.trackLanguage} (${log.trackKind}) | Status: ${log.responseStatus} | Cues: ${log.cuesExtracted} | Translation: ${log.translationStatus} | Endpoint: ${log.requestedEndpoint}`
      );
      if (log.detail) {
        console.warn(`[VestaDub Diag Detail]: ${log.detail}`);
      }
    }
  }

  getDiagnosticLogs(): SubtitleDiagnosticLog[] {
    return [...this.diagnosticLogs];
  }

  /**
   * Extract video ID from current URL
   */
  getVideoId(url: string = typeof window !== 'undefined' ? window.location?.href || '' : ''): string | null {
    try {
      if (!url) return null;
      const parsed = new URL(url);
      if (parsed.hostname.includes('youtube.com')) {
        return parsed.searchParams.get('v') || parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/)?.[1] || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch caption tracks list from page context
   */
  async getAvailableTracks(refresh = false): Promise<SubtitleTrack[]> {
    const videoId = this.getVideoId();
    if (!videoId) return [];

    if (!refresh && this.currentVideoId === videoId && this.cachedTracks.length > 0) {
      return this.cachedTracks;
    }

    this.currentVideoId = videoId;
    this.cachedTracks = [];

    // Method 1: Interrogate the YouTube player element in the DOM
    const player = (typeof document !== 'undefined'
      ? document.getElementById('movie_player')
      : null) as unknown as {
      getPlayerResponse?: () => { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: RawCaptionTrack[] } } };
      getOption?: (module: string, option: string) => RawCaptionTrack[];
    } | null;

    let rawTracks: RawCaptionTrack[] = [];
    if (isPauseFeatureEnabled('playerApiBridge') && typeof window !== 'undefined') {
      const receive = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.videoId === videoId && Array.isArray(detail.tracks)) rawTracks = detail.tracks;
      };
      window.addEventListener('vesta-track-metadata', receive);
      try { window.dispatchEvent(new CustomEvent('vesta-request-tracks')); }
      finally { window.removeEventListener('vesta-track-metadata', receive); }
    }


    if (isPauseFeatureEnabled('playerApiBridge') && player && rawTracks.length === 0) {
      try {
        if (typeof player.getOption === 'function') {
          const tracklist = player.getOption('captions', 'tracklist');
          if (Array.isArray(tracklist) && tracklist.length > 0) {
            rawTracks = tracklist;
          }
        }
      } catch (e) {
        console.warn('[VestaDub] player.getOption failed:', e);
      }

      if (rawTracks.length === 0 && typeof player.getPlayerResponse === 'function') {
        try {
          const resp = player.getPlayerResponse();
          const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(tracks) && tracks.length > 0) {
            rawTracks = tracks;
          }
        } catch (e) {
          console.warn('[VestaDub] player.getPlayerResponse failed:', e);
        }
      }
    }

    // Method 2: Inspect window.ytInitialPlayerResponse if in page scope
    if (rawTracks.length === 0 && typeof document !== 'undefined') {
      try {
        const pageScripts = document.querySelectorAll('script');
        for (const script of pageScripts) {
          const content = script.textContent || '';
          if (content.includes('playerCaptionsTracklistRenderer')) {
            const match = content.match(/"captionTracks":\s*(\[[^\]]+\])/);
            if (match) {
              rawTracks = JSON.parse(match[1]);
              break;
            }
          }
        }
      } catch (e) {
        console.warn('[VestaDub] DOM script search for captionTracks failed:', e);
      }
    }


    rawTracks = rawTracks.filter(track => {
      try { return new URL(track.baseUrl).searchParams.get('v') === videoId; }
      catch { return false; }
    });
    // A valid native response also supplies enough identity to admit its source
    // when the player metadata is briefly unavailable during SPA navigation.
    if (!rawTracks.length) {
      rawTracks = [...this.nativePayloads.keys()].filter(key => key.startsWith(`${videoId}:`)).map(key => {
        const languageCode = key.slice(videoId.length + 1);
        return { languageCode, name: { simpleText: languageCode },
          baseUrl: `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(languageCode)}&fmt=json3` };
      });
    }
    if (rawTracks.length === 0) {
      this.logDiagnostic({
        timestamp: new Date().toISOString(),
        videoId: videoId || '',
        trackLanguage: 'none',
        trackKind: 'none',
        requestedEndpoint: 'playerCaptionsTracklistRenderer',
        responseStatus: 404,
        executionContext: 'content_script',
        responseContentType: 'none',
        responseLength: 0,
        parserSelected: 'none',
        cuesExtracted: 0,
        translationStatus: 'failed',
        explicitFailureReason: 'MISSING_TRACK',
        detail: 'No caption tracks discovered in player metadata or DOM',
      });
      return [];
    }

    this.cachedTracks = rawTracks.map((t, idx) => {
      const trackName = t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode;
      const isAsr = t.kind === 'asr' || (t.vssId && t.vssId.startsWith('a.'));
      return {
        id: `track-${idx}-${t.languageCode}`,
        languageCode: t.languageCode,
        name: isAsr ? `${trackName} (Otomatik)` : trackName,
        kind: isAsr ? 'asr' : 'standard',
        baseUrl: t.baseUrl,
        vssId: t.vssId,
      };
    });

    return this.cachedTracks;
  }

  /**
   * Load and parse subtitle cues for a selected track.
   * Multi-stage retrieval:
   * 1. Player-activated session signed request via MAIN world bridge
   * 2. Direct timedtext fetch (with JSON3 and Turkish auto-translate parameter)
   * 3. Local translation fallback with explicit verification
   */
  async loadCues(track: SubtitleTrack): Promise<SubtitleCue[]> {
    const videoId = this.getVideoId() || '';
    if (!track.baseUrl) {
      this.logDiagnostic({
        timestamp: new Date().toISOString(),
        videoId,
        trackLanguage: track.languageCode,
        trackKind: track.kind || 'standard',
        requestedEndpoint: 'none',
        responseStatus: 0,
        executionContext: 'content_script',
        responseContentType: 'none',
        responseLength: 0,
        parserSelected: 'none',
        cuesExtracted: 0,
        translationStatus: 'failed',
        explicitFailureReason: 'MISSING_TRACK',
        detail: 'Track baseUrl is missing',
      });
      throw new Error('Caption track baseUrl is missing');
    }

    const trackVideoId = new URL(track.baseUrl, typeof window !== 'undefined' ? window.location?.href || 'https://www.youtube.com' : 'https://www.youtube.com').searchParams.get('v');
    if (trackVideoId && trackVideoId !== videoId) {
      this.logDiagnostic({ timestamp: new Date().toISOString(), videoId, trackLanguage: track.languageCode, trackKind: track.kind || 'standard', requestedEndpoint: sanitizeEndpointUrl(track.baseUrl), responseStatus: 0, executionContext: 'content_script', responseContentType: 'none', responseLength: 0, parserSelected: 'none', cuesExtracted: 0, translationStatus: 'skipped', explicitFailureReason: 'VIDEO_ID_MISMATCH' });
      return [];
    }

    const isAlreadyTurkish = track.languageCode === 'tr';
    let cues: SubtitleCue[] = [];
    let usedEndpoint = track.baseUrl;
    let selectedParser: 'json3' | 'xml' | 'vtt' | 'none' = 'none';

    // --- Strategy 1: Intercept legitimate native response via MAIN world bridge ---
    if (typeof window !== 'undefined') {
      let removePayloadListener = () => {};
      try {
        const payloadFromHook: { value: string | null; requestId?: string } = { value: null };
        const payloadListener = (e: any) => {
          if (e.detail?.text && e.detail.videoId === videoId && (!e.detail.languageCode || e.detail.languageCode === track.languageCode) && CaptionParser.parse(e.detail.text).length) {
            payloadFromHook.value = e.detail.text;
            payloadFromHook.requestId = e.detail.requestId;
          }
        };
        window.addEventListener('vesta-caption-payload', payloadListener);
        removePayloadListener = () => window.removeEventListener('vesta-caption-payload', payloadListener);

        const retained = this.nativePayloads.get(`${videoId}:${track.languageCode}`);
        payloadFromHook.value = retained?.text || null;
        payloadFromHook.requestId = retained?.requestId;
        // Check if bridge already cached the payload for this video
        const cache = (window as any).__vesta_caption_cache;
        if (!payloadFromHook.value && cache && cache[videoId]?.text && cache[videoId].languageCode === track.languageCode) {
          payloadFromHook.value = cache[videoId].text;
        }

        // If not yet available, dispatch request to bridge
        if (!payloadFromHook.value && isPauseFeatureEnabled('captionActivation')) {
          window.dispatchEvent(
            new CustomEvent('vesta-request-track', {
              detail: { languageCode: track.languageCode, videoId },
            })
          );
        }

        // Wait up to 1000ms for bridge intercept
        for (let i = 0; i < 5; i++) {
          if (payloadFromHook.value) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        if (payloadFromHook.value) {
          selectedParser = payloadFromHook.value.includes('"events"') ? 'json3' : payloadFromHook.value.includes('WEBVTT') ? 'vtt' : 'xml';
          cues = CaptionParser.parse(payloadFromHook.value);
          if (cues.length > 0) {
            window.removeEventListener('vesta-caption-payload', payloadListener);
            cues = cues.map(c => ({ ...c, turkishText: isAlreadyTurkish ? c.originalText : '', acquisition: { source: 'preloaded_track', requestId: payloadFromHook.requestId, wallMs: Date.now(), monotonicMs: performance.now(), videoSec: c.startTime, language: track.languageCode, timestamps: 'supplied' } }));
            this.logDiagnostic({
              timestamp: new Date().toISOString(),
              videoId,
              trackLanguage: track.languageCode,
              trackKind: track.kind || 'standard',
              requestedEndpoint: 'main_world_bridge_intercept',
              responseStatus: 200,
              executionContext: 'content_script',
              responseContentType: 'application/json',
              responseLength: payloadFromHook.value.length,
              parserSelected: selectedParser,
              cuesExtracted: cues.length,
              translationStatus: isAlreadyTurkish ? 'native_tr' : 'skipped',
              explicitFailureReason: null,
            });
            return cues;
          }
        }
      } catch (e) {
        console.warn('[VestaDub] Strategy 1 bridge timedtext failed:', e);
      } finally {
        removePayloadListener();
      }
    }

    // --- Strategy 2: Direct URL fetch (with &tlang=tr &fmt=json3) ---
    let fetchUrl = track.baseUrl;
    if (!fetchUrl.includes('fmt=')) {
      fetchUrl += '&fmt=json3';
    }

    if (!isAlreadyTurkish) {
      // Source-language cues only. Fragment-level &tlang=tr translations are not
      // speech we dub: sentence assembly and ContextualTranslator own Turkish.
      const translatedUrl = fetchUrl;
      usedEndpoint = translatedUrl;
      try {
        const res = await fetch(translatedUrl, { credentials: 'include' });
        const contentType = res.headers.get('content-type') || 'unknown';
        if (!res.ok) {
          this.logDiagnostic({
            timestamp: new Date().toISOString(),
            videoId,
            trackLanguage: track.languageCode,
            trackKind: track.kind || 'standard',
            requestedEndpoint: sanitizeEndpointUrl(translatedUrl),
            responseStatus: res.status,
            executionContext: 'content_script',
            responseContentType: contentType,
            responseLength: 0,
            parserSelected: 'none',
            cuesExtracted: 0,
            translationStatus: 'failed',
            explicitFailureReason: 'HTTP_FAILURE',
            detail: `HTTP status ${res.status}`,
          });
        } else {
          const text = await res.text();
          if (text.trim().length === 0) {
            this.logDiagnostic({
              timestamp: new Date().toISOString(),
              videoId,
              trackLanguage: track.languageCode,
              trackKind: track.kind || 'standard',
              requestedEndpoint: sanitizeEndpointUrl(translatedUrl),
              responseStatus: res.status,
              executionContext: 'content_script',
              responseContentType: contentType,
              responseLength: 0,
              parserSelected: 'none',
              cuesExtracted: 0,
              translationStatus: 'failed',
              explicitFailureReason: 'EMPTY_HTTP_RESPONSE',
              detail: 'YouTube timedtext returned 0 bytes; cause not established',
            });
          } else {
            selectedParser = text.includes('"events"') ? 'json3' : text.includes('WEBVTT') ? 'vtt' : 'xml';
            cues = CaptionParser.parse(text);
            if (cues.length > 0) {
              this.logDiagnostic({
                timestamp: new Date().toISOString(),
                videoId,
                trackLanguage: track.languageCode,
                trackKind: track.kind || 'standard',
                requestedEndpoint: sanitizeEndpointUrl(translatedUrl),
                responseStatus: res.status,
                executionContext: 'content_script',
                responseContentType: contentType,
                responseLength: text.length,
                parserSelected: selectedParser,
                cuesExtracted: cues.length,
                translationStatus: 'skipped',
                explicitFailureReason: null,
              });
              return cues.map(cue => ({ ...cue, turkishText: '' }));
            } else {
              this.logDiagnostic({
                timestamp: new Date().toISOString(),
                videoId,
                trackLanguage: track.languageCode,
                trackKind: track.kind || 'standard',
                requestedEndpoint: sanitizeEndpointUrl(translatedUrl),
                responseStatus: res.status,
                executionContext: 'content_script',
                responseContentType: contentType,
                responseLength: text.length,
                parserSelected: selectedParser,
                cuesExtracted: 0,
                translationStatus: 'failed',
                explicitFailureReason: 'PARSER_FAILURE',
                detail: 'Response contained content but parser yielded 0 cues',
              });
            }
          }
        }
      } catch (e: any) {
        this.logDiagnostic({
          timestamp: new Date().toISOString(),
          videoId,
          trackLanguage: track.languageCode,
          trackKind: track.kind || 'standard',
          requestedEndpoint: sanitizeEndpointUrl(translatedUrl),
          responseStatus: 0,
          executionContext: 'content_script',
          responseContentType: 'none',
          responseLength: 0,
          parserSelected: 'none',
          cuesExtracted: 0,
          translationStatus: 'failed',
          explicitFailureReason: 'HTTP_FAILURE',
          detail: e.message,
        });
      }
    }

    // --- Strategy 3: Original track fetch + local translation ---
    if (cues.length === 0) {
      usedEndpoint = fetchUrl;
      try {
        const res = await fetch(fetchUrl, { credentials: 'include' });
        const contentType = res.headers.get('content-type') || 'unknown';
        if (!res.ok) {
          this.logDiagnostic({
            timestamp: new Date().toISOString(),
            videoId,
            trackLanguage: track.languageCode,
            trackKind: track.kind || 'standard',
            requestedEndpoint: sanitizeEndpointUrl(fetchUrl),
            responseStatus: res.status,
            executionContext: 'content_script',
            responseContentType: contentType,
            responseLength: 0,
            parserSelected: 'none',
            cuesExtracted: 0,
            translationStatus: 'failed',
            explicitFailureReason: 'HTTP_FAILURE',
            detail: `HTTP status ${res.status}`,
          });
        } else {
          const text = await res.text();
          if (text.trim().length === 0) {
            this.logDiagnostic({
              timestamp: new Date().toISOString(),
              videoId,
              trackLanguage: track.languageCode,
              trackKind: track.kind || 'standard',
              requestedEndpoint: sanitizeEndpointUrl(fetchUrl),
              responseStatus: res.status,
              executionContext: 'content_script',
              responseContentType: contentType,
              responseLength: 0,
              parserSelected: 'none',
              cuesExtracted: 0,
              translationStatus: 'failed',
              explicitFailureReason: 'EMPTY_HTTP_RESPONSE',
              detail: 'YouTube timedtext original track returned 0 bytes',
            });
          } else {
            selectedParser = text.includes('"events"') ? 'json3' : text.includes('WEBVTT') ? 'vtt' : 'xml';
            cues = CaptionParser.parse(text);

            if (cues.length > 0 && !isAlreadyTurkish) {
              try {
                // Leave turkishText empty so the preloaded pipeline can translate
                // assembled sentences. Never block caption intake on translation.
                cues = cues.map(cue => ({ ...cue, turkishText: '' }));
                const translationOk = true;
                this.logDiagnostic({
                  timestamp: new Date().toISOString(),
                  videoId,
                  trackLanguage: track.languageCode,
                  trackKind: track.kind || 'standard',
                  requestedEndpoint: sanitizeEndpointUrl(fetchUrl),
                  responseStatus: res.status,
                  executionContext: 'content_script',
                  responseContentType: contentType,
                  responseLength: text.length,
                  parserSelected: selectedParser,
                  cuesExtracted: cues.length,
                  translationStatus: translationOk ? 'local_translated' : 'failed',
                  explicitFailureReason: translationOk ? null : 'TRANSLATION_FAILURE',
                });
              } catch (tErr: any) {
                cues = [];
                this.logDiagnostic({
                  timestamp: new Date().toISOString(),
                  videoId,
                  trackLanguage: track.languageCode,
                  trackKind: track.kind || 'standard',
                  requestedEndpoint: sanitizeEndpointUrl(fetchUrl),
                  responseStatus: res.status,
                  executionContext: 'content_script',
                  responseContentType: contentType,
                  responseLength: text.length,
                  parserSelected: selectedParser,
                  cuesExtracted: cues.length,
                  translationStatus: 'failed',
                  explicitFailureReason: 'TRANSLATION_FAILURE',
                  detail: tErr.message,
                });
              }
            } else if (cues.length > 0) {
              this.logDiagnostic({
                timestamp: new Date().toISOString(),
                videoId,
                trackLanguage: track.languageCode,
                trackKind: track.kind || 'standard',
                requestedEndpoint: sanitizeEndpointUrl(fetchUrl),
                responseStatus: res.status,
                executionContext: 'content_script',
                responseContentType: contentType,
                responseLength: text.length,
                parserSelected: selectedParser,
                cuesExtracted: cues.length,
                translationStatus: 'native_tr',
                explicitFailureReason: null,
              });
            }
          }
        }
      } catch (e: any) {
        this.logDiagnostic({
          timestamp: new Date().toISOString(),
          videoId,
          trackLanguage: track.languageCode,
          trackKind: track.kind || 'standard',
          requestedEndpoint: sanitizeEndpointUrl(fetchUrl),
          responseStatus: 0,
          executionContext: 'content_script',
          responseContentType: 'none',
          responseLength: 0,
          parserSelected: 'none',
          cuesExtracted: 0,
          translationStatus: 'failed',
          explicitFailureReason: 'HTTP_FAILURE',
          detail: e.message,
        });
      }
    }

    return cues;
  }

  /**
   * Reset cache on navigation
   */
  reset(): void {
    this.nativePayloads.clear();
    this.currentVideoId = null;
    this.cachedTracks = [];
  }
}
