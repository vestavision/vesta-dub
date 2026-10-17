import { CaptionParser } from '../src/subtitles/CaptionParser';
import { captionActivationDecision, shouldRestoreCaptionPlayback } from '../src/subtitles/CaptionActivation';
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

    // 3. Handle explicit track requests from extension.
    // Selecting a track by language code reloads the media element. Selecting the
    // track object already published by the player fetches timedtext without that
    // reload. No request is made while the tab is hidden.
    let activatedFor: string | null = null;
    let activationAttempts = 0;
    let lastActivationAt = 0;
    let deferredTrack: { videoId: string; languageCode?: string } | null = null;
    let retryTimer: number | null = null;

    const armPlaybackRestore = (videoId: string, savedTime: number, savedVolume: number | null) => {
      let restores = 0;
      let anchor = savedTime;
      const started = performance.now();
      const finish = () => {
        document.removeEventListener('timeupdate', onMedia, true);
        document.removeEventListener('loadeddata', onMedia, true);
        document.removeEventListener('play', onMedia, true);
        document.removeEventListener('pause', onPause, true);
      };
      const mainVideo = (event: Event) => {
        const media = event.target as HTMLMediaElement | null;
        if (!media || media.nodeName !== 'VIDEO' || !media.classList.contains('html5-main-video')) return null;
        return media;
      };
      const onPause = (event: Event) => {
        const media = mainVideo(event);
        if (!media || media.currentTime <= 1) return;
        anchor = media.currentTime;
      };
      const onMedia = (event: Event) => {
        if (performance.now() - started > 120000) { finish(); return; }
        if (new URL(location.href).searchParams.get('v') !== videoId) { finish(); return; }
        const media = mainVideo(event);
        if (!media) return;
        if (media.currentTime > 1) { anchor = media.currentTime; return; }
        if (!shouldRestoreCaptionPlayback(anchor, media.currentTime, restores >= 2)) return;
        restores += 1;
        try { media.currentTime = anchor; } catch { /* player may reject a seek during reload */ }
        if (savedVolume != null && savedVolume < 0.95 && media.volume > 0.95) {
          try { media.volume = savedVolume; } catch { /* ignore */ }
        }
        trace('playback_restored', { videoId, savedTime: anchor, restores });
        if (restores >= 2) finish();
      };
      document.addEventListener('pause', onPause, true);
      document.addEventListener('timeupdate', onMedia, true);
      document.addEventListener('loadeddata', onMedia, true);
      document.addEventListener('play', onMedia, true);
    };

    const onRequestTrack = (event: Event) => {
      const detail = (event as CustomEvent)?.detail || {};
      const currentVideoId = new URL(location.href).searchParams.get('v') || '';
      if (!currentVideoId) return;

      trace('track_requested', { videoId: currentVideoId, language: detail.languageCode });
      const cached = g.__vesta_caption_cache[`${currentVideoId}:source:${detail.languageCode}`] || g.__vesta_caption_cache[currentVideoId];
      const cacheHit = Boolean(cached && cached.text && (!detail.languageCode || cached.languageCode === detail.languageCode));
      const activationKey = `${currentVideoId}:${detail.languageCode || ''}`;
      if (activatedFor !== activationKey) {
        activatedFor = activationKey;
        activationAttempts = 0;
        lastActivationAt = 0;
      }
      const decision = captionActivationDecision({
        cached: cacheHit,
        enabled: mainWorldHooks().activatePlayerCaptions,
        hidden: document.visibilityState === 'hidden',
        attempts: activationAttempts,
        elapsedSinceAttemptMs: activationAttempts > 0 ? performance.now() - lastActivationAt : null,
      });
      if (decision === 'use-cache') {
        deferredTrack = null;
        if (retryTimer != null) { window.clearTimeout(retryTimer); retryTimer = null; }
        window.dispatchEvent(new CustomEvent('vesta-caption-payload', { detail: cached }));
        return;
      }
      if (decision === 'skip-disabled' || decision === 'skip-duplicate') {
        if (decision === 'skip-duplicate') trace('activation_skipped', { videoId: currentVideoId, reason: 'already_requested' });
        return;
      }
      if (decision === 'defer-hidden') {
        deferredTrack = { videoId: currentVideoId, languageCode: detail.languageCode };
        trace('activation_deferred', { videoId: currentVideoId, reason: 'hidden' });
        return;
      }

      activationAttempts += 1;
      lastActivationAt = performance.now();
      deferredTrack = null;
      const media = (document.querySelector('video.html5-main-video') || document.querySelector('video')) as HTMLVideoElement | null;
      const savedTime = media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
      const savedVolume = media && Number.isFinite(media.volume) ? media.volume : null;
      if (activationAttempts === 1) armPlaybackRestore(currentVideoId, savedTime, savedVolume);
      const languageCode = detail.languageCode;
      const videoId = currentVideoId;
      // A bare {languageCode} track reloads the media element. The track object
      // already in the player selects the same captions without that reload.
      const applyTrack = () => {
        if (document.visibilityState === 'hidden') {
          deferredTrack = { videoId, languageCode };
          trace('activation_deferred', { videoId, reason: 'hidden' });
          return true;
        }
        if (new URL(location.href).searchParams.get('v') !== videoId) return true;
        const cachedNow = g.__vesta_caption_cache[`${videoId}:source:${languageCode}`] || g.__vesta_caption_cache[videoId];
        if (cachedNow?.text && (!languageCode || cachedNow.languageCode === languageCode)) {
          window.dispatchEvent(new CustomEvent('vesta-caption-payload', { detail: cachedNow }));
          return true;
        }
        const player = (document.getElementById('movie_player') || document.querySelector('.html5-video-player')) as any;
        if (!player || typeof player.setOption !== 'function') return false;
        let list: any[] = [];
        try {
          list = player.getOption?.('captions', 'tracklist', { includeAsr: true }) || player.getOption?.('captions', 'tracklist') || [];
        } catch { list = []; }
        const chosen = Array.isArray(list) ? list.find((track) => track?.languageCode === languageCode) : null;
        if (!chosen) return false;
        player.setOption('captions', 'track', chosen);
        trace('activation_track', { videoId, language: languageCode, kind: chosen.kind || null });
        return true;
      };
      try {
        const player = (document.getElementById('movie_player') || document.querySelector('.html5-video-player')) as any;
        if (typeof player?.loadModule === 'function') player.loadModule('captions');
        if (retryTimer == null) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            if (!applyTrack()) {
              retryTimer = window.setTimeout(() => { retryTimer = null; applyTrack(); }, 2000);
            }
          }, 1000);
        }
      } catch (err) {
        activationAttempts = Math.max(0, activationAttempts - 1);
        console.warn('[VestaBridge] Player trigger failed:', err);
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !deferredTrack) return;
      const pending = deferredTrack;
      deferredTrack = null;
      if (new URL(location.href).searchParams.get('v') !== pending.videoId) return;
      onRequestTrack(new CustomEvent('vesta-request-track', { detail: pending }));
    });

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
    const releaseActivationForOtherVideo = () => {
      const currentVideoId = new URL(location.href).searchParams.get('v') || '';
      if (activatedFor && !activatedFor.startsWith(`${currentVideoId}:`)) {
        activatedFor = null;
        activationAttempts = 0;
        lastActivationAt = 0;
        if (retryTimer != null) { window.clearTimeout(retryTimer); retryTimer = null; }
      }
      if (deferredTrack && deferredTrack.videoId !== currentVideoId) deferredTrack = null;
    };
    const onNavStart = () => {
      releaseActivationForOtherVideo();
      const currentVideoId = new URL(location.href).searchParams.get('v') || '';
      trace('navigation_started');
      for (const k of Object.keys(g.__vesta_caption_cache || {})) {
        if (k !== currentVideoId && !k.startsWith(`${currentVideoId}:`)) {
          delete g.__vesta_caption_cache[k];
        }
      }
    };
    window.addEventListener('yt-navigate-start', onNavStart);
    window.addEventListener('yt-navigate-finish', releaseActivationForOtherVideo);

    window.addEventListener('pagehide', event => {
      if(event.persisted)return; // Retain passive listeners for a BFCache restoration.
      window.removeEventListener('vesta-request-track', onRequestTrack);
      window.removeEventListener('vesta-request-tracks', onRequestTracks);
      window.removeEventListener('yt-navigate-start', onNavStart);
      window.removeEventListener('yt-navigate-finish', releaseActivationForOtherVideo);
    });
  },
});
