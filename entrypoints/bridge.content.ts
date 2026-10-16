import { CaptionParser } from '../src/subtitles/CaptionParser';
import { installMediaProbe, mainWorldHooks, readPauseIsolationFlags } from '../src/diagnostics/PauseIsolation';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Missing localStorage key: production hooks on, pause probe off.
    // Prototype hooks are decided here. A later flag change needs a reload.
    const hooks = mainWorldHooks(readPauseIsolationFlags());
    if (hooks.installProbe) installMediaProbe();
    if (!hooks.patchXhr || !hooks.patchFetch || !hooks.listenForTrackMetadata || !hooks.activatePlayerCaptions || hooks.installProbe) {
      console.debug('[VestaPauseIsolation]', JSON.stringify(hooks));
    }
    // Passive observation of native player timedtext requests
    // Captures legitimately retrieved subtitle tracks without token forgery or interference
    const g = window as any;
    const trace = (stage: string, detail: Record<string, unknown> = {}) => {
      const entry = { stage, at: Date.now(), elapsedMs: performance.now(), pageVideoId: new URL(location.href).searchParams.get('v'), ...detail };
      g.__vesta_native_trace = [...(g.__vesta_native_trace || []).slice(-199), entry];
      console.debug('[VestaNative]', JSON.stringify(entry));
    };
    let sequence = 0;
    const identity = (url: string) => {
      try {
        const parsed = new URL(url, location.href);
        return { videoId: parsed.searchParams.get('v'), language: parsed.searchParams.get('lang'), translation: parsed.searchParams.get('tlang'), format: parsed.searchParams.get('fmt') };
      } catch { return {}; }
    };
    trace('observer_installed', { readyState: document.readyState });
    g.__vesta_caption_cache = g.__vesta_caption_cache || {};

    const handleTimedTextResponse = (url: string, text: string, status: number, requestId: string) => {
      trace('body_received', { requestId, ...identity(url), status, bytes: new TextEncoder().encode(text || '').length });
      if (status !== 200 || !text || typeof text !== 'string') return;
      if (!text.includes('"events"') && !text.includes('WEBVTT') && !text.includes('<transcript>')) return;
      const cues = CaptionParser.parse(text);
      trace('parser_outcome', { requestId, cues: cues.length });
      if (!cues.length) return;


      try {
        const parsed = new URL(url, location.href);
        const videoId = parsed.searchParams.get('v') || '';
        const tlang = parsed.searchParams.get('tlang') || '';
        const lang = parsed.searchParams.get('lang') || tlang || '';
        if (!videoId) return;

        const entry = {
          requestId,
          videoId,
          languageCode: tlang ? `tlang:${tlang}` : lang,
          text,
          url: `${parsed.origin}${parsed.pathname}?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`,
          timestamp: Date.now(),
        };
        // A translated timedtext response must not replace the spoken-language source.
        if (tlang) {
          g.__vesta_caption_cache[`${videoId}:tlang:${tlang}`] = entry;
        } else {
          g.__vesta_caption_cache[videoId] = entry;
          if (lang) g.__vesta_caption_cache[`${videoId}:source:${lang}`] = entry;
        }

        trace('payload_dispatched', { requestId, videoId, languageCode: entry.languageCode, bytes: new TextEncoder().encode(text).length });
        // Dispatch payload event to extension context
        window.dispatchEvent(
          new CustomEvent('vesta-caption-payload', {
            detail: {
              requestId,
              videoId,
              languageCode: entry.languageCode,
              text,
              url: entry.url,
            },
          })
        );
      } catch (err) {
        console.warn('[VestaBridge] Failed to process timedtext response:', err);
      }
    };

    // Observe URL changes synchronously, without changing native history behavior.
    for(const method of ['pushState','replaceState'] as const){
      const original=history[method];
      history[method]=function(...args:Parameters<History[typeof method]>){
        const before=location.href,result=original.apply(this,args);
        if(location.href!==before)window.dispatchEvent(new Event('vesta-location-changed'));
        return result;
      };
    }
    // Read-only identity handshake; never starts the player or requests captions.
    window.addEventListener('vesta-request-player-identity',()=>{
      const player=document.getElementById('movie_player') as any;
      let playerVideoId:string|null=null;
      try {playerVideoId=player?.getVideoData?.()?.video_id || player?.getPlayerResponse?.()?.videoDetails?.videoId || null;}catch{}
      window.dispatchEvent(new CustomEvent('vesta-player-identity',{detail:{url:location.href,playerVideoId}}));
    });

    // 1. Passive XMLHttpRequest hook (YouTube player uses XHR for /api/timedtext)
    if (hooks.patchXhr) {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(this: any, method: string, url: string | URL, ...rest: any[]) {
        this.__vesta_url = typeof url === 'string' ? url : (url ? url.toString() : '');
        return origOpen.apply(this, [method, url, ...rest] as any);
      };

      XMLHttpRequest.prototype.send = function(this: any, ...args: any[]) {
        if (this.__vesta_url && this.__vesta_url.includes('/api/timedtext')) {
          const requestUrl = this.__vesta_url;
          const requestId = `xhr:${++sequence}`;
          trace('request_started', { requestId, mechanism: 'xhr', ...identity(requestUrl) });
          this.addEventListener('load', function(this: any) {
            try {
              trace('request_completed', { requestId, mechanism: 'xhr', responseType: this.responseType, status: this.status, ...identity(requestUrl) });
              const text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
              handleTimedTextResponse(requestUrl, text, this.status, requestId);
            } catch (error) { trace('body_inaccessible', { requestId, error: error instanceof Error ? error.name : 'unknown' }); }
          });
        }
        return origSend.apply(this, args as any);
      };
    }

    // 2. Secondary fetch hook for any fetch-based subtitle requests
    if (hooks.patchFetch) {
      const origFetch = window.fetch;
      window.fetch = async function(this: any, ...args: any[]) {
        const requestUrl = args[0] instanceof Request ? args[0].url : String(args[0]);
        const requestId = `fetch:${++sequence}`;
        if (requestUrl.includes('/api/timedtext')) trace('request_started', { requestId, mechanism: 'fetch', ...identity(requestUrl) });
        const response = await (origFetch as any).apply(this, args);
        try {
          const url = args[0] instanceof Request ? args[0].url : String(args[0]);
          if (url && url.includes('/api/timedtext') && response.ok) {
            const clone = response.clone();
            clone.text().then((text: string) => {
              handleTimedTextResponse(url, text, response.status, requestId);
            }).catch(() => {});
          }
        } catch {}
        return response;
      };
    }

    // 3. Handle explicit track requests from extension
    const onRequestTrack = (event: Event) => {
      const detail = (event as CustomEvent)?.detail || {};
      const currentVideoId = new URL(location.href).searchParams.get('v') || '';
      if (!currentVideoId) return;

      trace('track_requested', { videoId: currentVideoId, language: detail.languageCode });
      // If already cached, dispatch immediately
      const cached = g.__vesta_caption_cache[`${currentVideoId}:source:${detail.languageCode}`] || g.__vesta_caption_cache[currentVideoId];
      if (cached && cached.text && (!detail.languageCode || cached.languageCode === detail.languageCode)) {
        window.dispatchEvent(
          new CustomEvent('vesta-caption-payload', {
            detail: cached,
          })
        );
        return;
      }

      // If not yet fetched by player, trigger native player subtitle request.
      // Re-read the flag so a stored switch takes effect on the next request after reload.
      if (!mainWorldHooks().activatePlayerCaptions) return;
      try {
        const player = (document.getElementById('movie_player') || (document.querySelector('.html5-video-player') as any)) as any;
        if (player) {
          if (typeof player.loadModule === 'function') {
            player.loadModule('captions');
          }
          if (typeof player.setOption === 'function' && detail.languageCode) {
            player.setOption('captions', 'track', { languageCode: detail.languageCode });
          }

        }
      } catch (err) {
        console.warn('[VestaBridge] Player trigger failed:', err);
      }
    };

    window.addEventListener('vesta-request-track', onRequestTrack);

    // Player methods are MAIN-world expandos; isolated DOM wrappers cannot see them.
    // Forward only current-video metadata and token-free endpoints.
    const onRequestTracks = () => {
      const videoId = new URL(location.href).searchParams.get('v') || '';
      const player = document.getElementById('movie_player') as any;
      let tracks: any[] = [];
      try {
        const raw = player?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        tracks = raw.flatMap((track: any) => {
          const url = new URL(track.baseUrl, location.href);
          if (url.searchParams.get('v') !== videoId) return [];
          const safe = new URLSearchParams();
          for (const key of ['v', 'lang', 'fmt', 'kind', 'tlang']) {
            const value = url.searchParams.get(key);
            if (value) safe.set(key, value);
          }
          return [{ languageCode: track.languageCode, kind: track.kind, vssId: track.vssId,
            name: track.name, baseUrl: `${url.origin}${url.pathname}?${safe}` }];
        });
      } catch { /* player metadata may not be ready during navigation */ }
      window.dispatchEvent(new CustomEvent('vesta-track-metadata', { detail: { videoId, tracks } }));
    };
    if (hooks.listenForTrackMetadata) window.addEventListener('vesta-request-tracks', onRequestTracks);


    // 4. Lifecycle cleanup on SPA navigation
    const onNavStart = () => {
      const currentVideoId = new URL(location.href).searchParams.get('v') || '';
      trace('navigation_started');
      for (const k of Object.keys(g.__vesta_caption_cache || {})) {
        if (k !== currentVideoId && !k.startsWith(`${currentVideoId}:`)) {
          delete g.__vesta_caption_cache[k];
        }
      }
    };
    window.addEventListener('yt-navigate-start', onNavStart);

    window.addEventListener('pagehide', event => {
      if(event.persisted)return; // Retain passive listeners for a BFCache restoration.
      window.removeEventListener('vesta-request-track', onRequestTrack);
      window.removeEventListener('vesta-request-tracks', onRequestTracks);
      window.removeEventListener('yt-navigate-start', onNavStart);
    });
  },
});
