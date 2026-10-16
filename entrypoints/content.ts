import { ActivationPolicy, ACTIVATION_KEY, activationPreference, watchVideoId } from '@/src/activation/ActivationPolicy';
import { nextSchedulerErrorMessage } from '@/src/ui/PlaybackNotice';
import { ExtensionMessage, ExtensionState, SubtitleCue, SubtitleTrack, DubbingMetrics, SpeakerSlot, SynthesisResult } from '@/src/core/types';
import { YouTubeSubtitleAdapter } from '@/src/subtitles/YouTubeSubtitleAdapter';
import { LiveCaptionCommitter } from '@/src/subtitles/LiveCaptionCommitter';
import { LiveCaptionHarvester } from '@/src/subtitles/LiveCaptionHarvester';
import { PreloadedCaptionSource } from '@/src/subtitles/PreloadedCaptionSource';
import { translateAcquiredCue } from '@/src/subtitles/CaptionTranslation';
import { SpeechSegmenter } from '@/src/subtitles/SpeechSegmenter';
import { prepareSpokenCues, PreloadedTranslationRateLimit, selectSpokenSourceTrack, startupIndexes, translateCueIndexes, translateCueWindows } from '@/src/subtitles/PreloadedTranscriptPipeline';
import { Translator } from '@/src/subtitles/Translator';
import { isLocalTranslationError, isTranslationCancelled } from '@/src/translation/LocalTranslationError';
import { isRateLimitMessage, isTranslationRateLimit, isTranslationSetupRequired, rateLimitUserMessage, setupRequiredUserMessage, TranslationRateLimitError, TranslationSetupRequiredError } from '@/src/translation/TranslationRateLimit';
import { migrateStoredProvider } from '@/src/speaker/VoiceMigration';
import { AudioDSP } from '@/src/dsp/AudioDSP';
import { AudioContextManager } from '@/src/audio/AudioContextManager';
import { prepareSpeech } from '@/src/tts/FillerPreparation';
import { TTSManager } from '@/src/tts/TTSManager';
import { SpeakerManager } from '@/src/speaker/SpeakerManager';
import { DubbingScheduler } from '@/src/audio/DubbingScheduler';
import { AdaptiveSyncEngine } from '@/src/audio/AdaptiveSyncEngine';
import { ModelStorage } from '@/src/tts/ModelStorage';
import { DogfoodSessionRecorder } from '@/src/diagnostics/DogfoodSessionRecorder';
import { clearPauseTrace, isPauseFeatureEnabled, noteExtensionEvent, readPauseIsolationFlags, readPauseTrace, resetPauseIsolationFlags, writePauseIsolationFlags } from '@/src/diagnostics/PauseIsolation';
import { LocalTelemetryRecorder } from '@/src/telemetry/LocalTelemetryRecorder';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  main(ctx) {
    console.log('[VestaDub] Content script active on YouTube (P2.6 Live Dogfood & Beta Gate).');

    const activation=new ActivationPolicy();
    let preferenceReady=false;
    let playerVideoId:string|null=null;
    let lastElement:HTMLVideoElement|null=null;
    let pipelineRunning=false;
    const subtitleAdapter = new YouTubeSubtitleAdapter();
    const preloadedSource = new PreloadedCaptionSource(subtitleAdapter);
    const audioManager = new AudioContextManager();
    const ttsManager = TTSManager.getInstance();
    const speakerManager = new SpeakerManager();
    const syncEngine = new AdaptiveSyncEngine({ maxStretch: 1.12 });
    const scheduler = new DubbingScheduler(audioManager, ttsManager, speakerManager, syncEngine);
    let tornDown=false;
    const teardown=()=>{if(tornDown)return;tornDown=true;activation.stop();stopRuntime();scheduler.destroy();void ttsManager.disposeAll();};
    ctx.addEventListener(window,'pagehide',event=>{
      if(!event.isTrusted)return;
      if(event.persisted){activation.resetDocument();preferenceReady=false;stopRuntime();lastElement=null;}
      else teardown();
    });
    ctx.onInvalidated(teardown);
    const recorder = DogfoodSessionRecorder.getInstance();
    const telemetry = LocalTelemetryRecorder.getInstance();

    const state: ExtensionState = {
      videoDetected: false,
      playback: null,
      tracks: [],
      selectedTrack: null,
      cues: [],
      settings: {
        enabled: false,
        activationMode: 'manual',
        originalVideoVolume: 0.2,
        dubbingVolume: 1.0,
        selectedTrackId: null,
        speakers: Object.fromEntries(speakerManager.getAllSlots().map((s: SpeakerSlot) => [s.id, s])),
        defaultSpeakerId: 'speaker-a',
        autoTranslateCaptions: true,
        lookaheadWindowSec: 6.0,
        adaptiveSyncEnabled: true,
        maxSpeedStretch: 1.25,
        speechResegmentationEnabled: false,
      },
      metrics: {
        activeCueIndex: -1,
        currentCueText: '',
        currentSpeakerId: 'Konuşmacı A (Birincil)',
        activeProviderId: 'antalia',
        synthesisLatencyMs: null,
        syncDriftMs: null,
        isOverflowing: false,
        realtimeFactor: null,
        bufferedCuesCount: 0,
        totalCuesCount: 0,
        p95StartDriftMs: null,
        p95OverflowMs: null,
        underrunCount: 0,
        activeStrategy: 'normal',
        scheduledSpeed: 1.0,
      },
      status: 'idle',
      errorMessage: null,
      modelStatus: {
        'ema-lightning': { cached: true, downloading: false, progress: 1, sizeBytes: 37_397_589 },
        antalia: { cached: false, downloading: false, progress: 0, sizeBytes: 15_493_500 },
      },
    };

    const liveCommitter = new LiveCaptionCommitter(phrase => {
      scheduler.log(phrase.cue,'phrase_committed',{epoch:phrase.epoch,tokenStart:phrase.tokenStart,tokenEnd:phrase.tokenEnd,reason:phrase.reason,commitmentDelayMs:phrase.committedMs-(phrase.cue.acquisition?.wallMs || phrase.committedMs)});
      void consumeLiveCue(phrase.cue);
    }, (stage,detail) => console.log('[VestaDub Commitment]',JSON.stringify({stage,wallMs:Date.now(),...detail})));
    const translatedPhraseIds = new Set<string>();
    let translationQueue = Promise.resolve();
    let pendingTranslations=0;
    const captionHarvester = new LiveCaptionHarvester({
      onSnapshot: snapshot => { if(state.captionMode==='live' && state.settings.enabled) liveCommitter.observe(snapshot); },
      onDiagnostic: (cue, stage, detail) => { scheduler.log(cue, stage, detail); },
      onError: (reason) => { if(state.settings.enabled)failSession(`translation: ${reason}`); },
    });

    const consumeLiveCue = (cue: SubtitleCue): Promise<void> => requestLiveTranslation(cue, true);

    function retryPendingLiveTranslations(): void {
      if (state.captionMode !== 'live' || !state.settings.enabled) return;
      for (const cue of [...state.cues]) {
        if (cue.turkishText?.trim()) continue;
        translatedPhraseIds.delete(cue.id);
        void requestLiveTranslation(cue, false);
      }
    }

    function requestLiveTranslation(cue: SubtitleCue, append: boolean): Promise<void> {
      if (!isPauseFeatureEnabled('translationPipeline')) {
        noteExtensionEvent('translation_state', { phase: 'disabled' });
        return translationQueue;
      }
      if(translatedPhraseIds.has(cue.id)) return translationQueue;
      translatedPhraseIds.add(cue.id);
      if(translatedPhraseIds.size>256) translatedPhraseIds.delete(translatedPhraseIds.values().next().value!);
      if(pendingTranslations>=32) {scheduler.log(cue,'cancelled',{reason:'translation_queue_overflow'});return translationQueue;}
      pendingTranslations++;
      const epoch=liveCommitter.getEpoch();
      translationQueue=translationQueue.then(async () => {
        if(epoch!==liveCommitter.getEpoch()) {scheduler.log(cue,'cancelled',{reason:'translation_epoch_changed'});return;}
        if(!state.settings.enabled) {scheduler.log(cue,'cancelled',{reason:'disabled_before_translation'});return;}
        scheduler.log(cue,'translation_started');
        if(state.status!=='playing') {state.status='translating';notifyStateChange();}
        if (state.captionMode !== 'live') return;
        const generation = initGeneration;
        const selectedTrackGeneration = trackGeneration;
        const videoId = subtitleAdapter.getVideoId();
        const current = () => generation === initGeneration && selectedTrackGeneration === trackGeneration && videoId === subtitleAdapter.getVideoId() && state.captionMode === 'live' && epoch===liveCommitter.getEpoch() && state.settings.enabled;
        if (append) {
          state.cues = [...state.cues, cue].sort((a,b)=>a.startTime-b.startTime).slice(-100);
          notifyStateChange();
        }
        if (!state.settings.enabled) return;
        try {
          if (cue.acquisition?.language !== 'tr') {
            const readiness = await translationReadiness();
            if (!current()) return;
            if (readiness !== 'ready') throw new TranslationSetupRequiredError(readiness === 'missing_key' ? 'missing_key' : 'unavailable');
          }
          const translated = await translateAcquiredCue(cue,current);
          if (!translated) { scheduler.log(cue,'cancelled',{reason:'stale_translation'}); return; }
          scheduler.log(cue,'translation_ready',{text:translated.turkishText,appearanceToTranslationMs:Date.now()-(cue.acquisition?.wallMs||Date.now())});
          state.cues = state.cues.map(c=>c.id===cue.id ? translated:c);
          clearRateLimitBanner();
          scheduler.appendLiveCue(translated); notifyStateChange();
        } catch(error) {
          if(generation!==initGeneration||selectedTrackGeneration!==trackGeneration||!state.settings.enabled)return;
          if (isTranslationRateLimit(error)) translatedPhraseIds.delete(cue.id);
          if (noteTranslationFailure(error)) return;
          scheduler.log(cue,'playback_failed',{failureStage:'translation',reason:String(error)});
          failSession(`translation: ${String(error)}`);
        }
      }).finally(()=>{pendingTranslations--;});
      return translationQueue;
    }

    async function restoreVoices(videoId:string,generation:number):Promise<void> {
      try {
        const key=`vesta_speakers_${videoId}`,stored=await chrome.storage.local.get(key);
        if(generation!==initGeneration||videoId!==watchVideoId(location.href))return;
        let changed=false;
        for(const [id,slot] of Object.entries(stored[key]||{})){
          if(!slot||typeof slot!=='object')continue;
          const voice=slot as SpeakerSlot;
          const providerId=migrateStoredProvider(id,voice.providerId);
          if(providerId!==voice.providerId)changed=true;
          speakerManager.updateSlot(id,{...voice,providerId});
        }
        state.settings.speakers=Object.fromEntries(speakerManager.getAllSlots().map(s=>[s.id,s]));
        if(changed&&chrome.storage?.local)await chrome.storage.local.set({[key]:state.settings.speakers});
      }catch{}
    }

    // Update model cached status from IndexedDB
    const checkModelCache = async () => {
      const antaliaCached = await ModelStorage.has('antalia/vocoder.fp16.onnx');
      state.modelStatus.antalia.cached = antaliaCached;
    };
    checkModelCache();

    scheduler.setMetricsCallback((metrics: DubbingMetrics) => {
      state.metrics = metrics;
      notifyStateChange();
    });

    const notifyStateChange = () => {
      state.activation=activation.snapshot();
      state.settings.activationMode=state.activation.mode;
      try {
        chrome.runtime.sendMessage({
          type: 'STATE_UPDATE',
          state,
        } as ExtensionMessage).catch(() => {});
      } catch {
        // Popup may not be open
      }
    };

    /**
     * Attach video element and load subtitles for current video
     */
    let initGeneration = 0;
    let trackGeneration = 0;
    let removePlaybackListener = () => {};
    let removePreloadedUpgrade = () => {};

    function stopRuntime():void {
      ++initGeneration;++trackGeneration;++priorityTranslationEpoch;
      void chrome.runtime.sendMessage({ type: 'CANCEL_LOCAL_TRANSLATION' }).catch(() => {});
      state.settings.enabled=false;
      scheduler.setEnabled(false);scheduler.setCues([]);scheduler.detachVideo();
      captionHarvester.stop();preloadedSource.stop();removePreloadedUpgrade();removePlaybackListener();
      liveCommitter.reset(watchVideoId(location.href)||'','session_ended');translatedPhraseIds.clear();
      state.cues=[];state.selectedTrack=null;state.tracks=[];state.captionSource=undefined;
      pipelineRunning=false;audioManager.unduckVideo();
      void ttsManager.disposeAll().catch(()=>{});
    }
    function failSession(reason:string,blocked=false):void {
      if(!activation.snapshot().activeVideoId)return;
      activation.fail(blocked);stopRuntime();lastElement=null;checkNavigation();state.status='error';state.errorMessage=reason;notifyStateChange();
    }

    let priorityTranslationEpoch = 0;
    function clearRateLimitBanner(): void {
      if (!isRateLimitMessage(state.errorMessage)) return;
      state.errorMessage = null;
      if (state.status === 'error' && state.settings.enabled) state.status = 'buffering';
    }
    function noteTranslationRateLimit(error: unknown): void {
      const retryAfterMs = error instanceof TranslationRateLimitError ? error.retryAfterMs : null;
      failSession(rateLimitUserMessage({retryAfterMs}),true);
    }
    function noteTranslationFailure(error: unknown): boolean {
      if (isTranslationCancelled(error)) return true;
      if (isTranslationRateLimit(error)) { noteTranslationRateLimit(error); return true; }
      if (isLocalTranslationError(error)) { failSession(error.message, true); return true; }
      if (isTranslationSetupRequired(error)) { failSession(error.message, true); return true; }
      return false;
    }
    function translationReadiness(): Promise<'ready' | 'missing_key' | 'unavailable'> {
      return new Promise(resolve => {
        try {
          const runtime = chrome.runtime;
          if (typeof runtime?.sendMessage !== 'function') { resolve('unavailable'); return; }
          runtime.sendMessage({ type: 'TRANSLATION_STATUS' }, (response: { mode?: string; configured?: boolean } | undefined) => {
            if (runtime.lastError || !response) { resolve('unavailable'); return; }
            if (response.mode === 'cloud') resolve(response.configured ? 'ready' : 'missing_key');
            else resolve('ready');
          });
        } catch { resolve('unavailable'); }
      });
    }

    function publishTranslations(entries: Array<{ index: number; cue: SubtitleCue }>): void {
      for (const { index, cue } of entries) {
        if (state.cues[index]?.id !== cue.id) continue;
        state.cues[index] = { ...state.cues[index], turkishText: cue.turkishText, assembly: cue.assembly };
        scheduler.patchCueTranslation(cue.id, cue.turkishText, cue.assembly?.semanticCompromises);
      }
      if (entries.length) { clearRateLimitBanner(); notifyStateChange(); scheduler.kick(); }
    }
    function refreshPlayheadTranslations(): void {
      if (!isPauseFeatureEnabled('translationPipeline')) return;
      if (state.captionMode !== 'preloaded' || !state.settings.enabled || !state.settings.autoTranslateCaptions || state.selectedTrack?.languageCode === 'tr') return;
      const epoch = ++priorityTranslationEpoch;
      const generation = initGeneration;
      const trackRequest = trackGeneration;
      const videoNow = (document.querySelector('video') as HTMLVideoElement | null)?.currentTime || 0;
      const indexes = startupIndexes(state.cues, videoNow, 40, 20).filter(index => !state.cues[index].turkishText?.trim());
      void translateCueWindows(state.cues, indexes, text => Translator.toTurkish(text),
        () => epoch === priorityTranslationEpoch && generation === initGeneration && trackRequest === trackGeneration && state.settings.enabled,
        publishTranslations).catch(error => {
          if(epoch!==priorityTranslationEpoch||generation!==initGeneration||!state.settings.enabled)return;
          if (noteTranslationFailure(error)) return;
          failSession(`translation: ${String(error)}`);
          scheduler.recordStartup({ priorityTranslationError: error instanceof Error ? error.message : String(error) });
        });
    }

    /**
     * The player often signs its timedtext XHR after the first loadCues wait.
     * An unsigned fetch then returns zero bytes and the session drops to live
     * fragments. A later native payload is the full source track; assemble it.
     */
    function armPreloadedUpgrade(track: SubtitleTrack, generation: number, trackRequest: number): void {
      removePreloadedUpgrade();
      const onPayload = (event: Event) => {
        const detail = (event as CustomEvent<{ videoId?: string; text?: string; languageCode?: string }>).detail;
        if (!detail?.text || detail.languageCode !== track.languageCode) return;
        const currentId = subtitleAdapter.getVideoId();
        if (detail.videoId && currentId && detail.videoId !== currentId) return;
        if (generation !== initGeneration || trackRequest !== trackGeneration) {
          removePreloadedUpgrade();
          return;
        }
        if (state.captionMode === 'preloaded' && state.cues.length > 0) {
          removePreloadedUpgrade();
          return;
        }
        const metadataVideoId = track.baseUrl ? new URL(track.baseUrl).searchParams.get('v') : null;
        if (metadataVideoId && metadataVideoId !== currentId) {
          removePreloadedUpgrade();
          void subtitleAdapter.getAvailableTracks(true).then(tracks => {
            if (generation !== initGeneration || trackRequest !== trackGeneration) return;
            state.tracks = tracks;
            const currentTrack = selectSpokenSourceTrack(tracks);
            if (currentTrack) void selectTrack(currentTrack);
          });
          return;
        }
        removePreloadedUpgrade();
        console.log('[VestaDub] Late native caption payload arrived; assembling the preloaded track.');
        void selectTrack(track);
      };
      window.addEventListener('vesta-caption-payload', onPayload);
      removePreloadedUpgrade = () => window.removeEventListener('vesta-caption-payload', onPayload);
      window.dispatchEvent(new CustomEvent('vesta-request-track', { detail: { videoId: subtitleAdapter.getVideoId(), languageCode: track.languageCode } }));
    }

    const initVideo = async () => {
      const generation = ++initGeneration;
      removePreloadedUpgrade();
      preloadedSource.stop();
      captionHarvester.reset();
      liveCommitter.reset(subtitleAdapter.getVideoId() || '','video_initialization');
      translatedPhraseIds.clear();
      scheduler.setCues([]);
      scheduler.detachVideo();
      removePlaybackListener();
      state.cues = [];
      state.selectedTrack = null;
      state.tracks = [];
      state.captionMode = 'live';
          scheduler.setCaptionMode('live');
      const currentId=watchVideoId(location.href);
      const video = currentId ? document.querySelector('video') as HTMLVideoElement | null : null;
      if (!video) {
        state.videoDetected = false;
        state.playback = null;
        state.status = 'idle';
        notifyStateChange();
        return;
      }

      state.videoDetected = true;
      state.status = state.settings.enabled ? 'loading_captions' : 'idle';
      state.errorMessage = null;
      notifyStateChange();

      scheduler.setVideoContext(subtitleAdapter.getVideoId() || '', 'asr', 'auto', 'google_proxy');
      if(state.settings.enabled && playerVideoId===currentId && video.readyState>=1){scheduler.attachVideo(video);scheduler.setEnabled(true);captionHarvester.attach(video);}

      const updatePlayback = () => {
        if (!video) return;
        state.playback = {
          currentTime: video.currentTime,
          duration: video.duration || 0,
          paused: video.paused,
          playbackRate: video.playbackRate,
          volume: video.volume,
          muted: video.muted,
          videoId: subtitleAdapter.getVideoId() || '',
          title: document.title,
        };
      };

      const resetLiveEpoch = () => {
        if (state.captionMode === 'live') { liveCommitter.reset(subtitleAdapter.getVideoId() || '', 'seek'); state.cues=[]; }
        void chrome.runtime.sendMessage({ type: 'CANCEL_LOCAL_TRANSLATION' }).catch(() => {});
      };
      if (isPauseFeatureEnabled('mediaLifecycleListener')) {
        video.addEventListener('seeking', resetLiveEpoch);
        video.addEventListener('seeked', refreshPlayheadTranslations);
        video.addEventListener('timeupdate', updatePlayback);
        removePlaybackListener = () => { video.removeEventListener('timeupdate', updatePlayback);video.removeEventListener('seeking',resetLiveEpoch);video.removeEventListener('seeked',refreshPlayheadTranslations); };
      } else {
        removePlaybackListener = () => {};
      }
      updatePlayback();

      if(currentId)await restoreVoices(currentId,generation);
      if(generation!==initGeneration)return;
      notifyStateChange();
      if(!state.settings.enabled||playerVideoId!==currentId||video.readyState<1)return;
      // Fetch tracks only for this authorized, identity-matched session.
      try {
        const tracks = await subtitleAdapter.getAvailableTracks();
        if (generation !== initGeneration) return;
        state.tracks = tracks;

        if (tracks.length === 0) {
          activation.phase('blocked');
          // If no tracks listed, start harvester directly
          captionHarvester.start({videoId: subtitleAdapter.getVideoId() || '',video: document.querySelector('video') || undefined}, {onCues:()=>{},onStatus:source=>{state.captionSource=source;scheduler.setCaptionSource(source);notifyStateChange();}});
          state.status = state.settings.enabled ? 'waiting_for_live_caption' : 'idle';
          state.captionMode = 'live';
          scheduler.setCaptionMode('live');
          state.errorMessage = null;
          state.cues = [];
          state.selectedTrack = null;
          notifyStateChange();
          return;
        }

        // Dub from the spoken-language track. A Turkish translation track is
        // fragment MT, not the source sentence stream.
        const defaultTrack = selectSpokenSourceTrack(tracks);

        if (defaultTrack) {
          await selectTrack(defaultTrack);
        }
      } catch (err) {
        if (generation !== initGeneration) return;
        captionHarvester.start({videoId: subtitleAdapter.getVideoId() || '',video: document.querySelector('video') || undefined}, {onCues:()=>{},onStatus:source=>{state.captionSource=source;scheduler.setCaptionSource(source);notifyStateChange();}});
        state.status = state.settings.enabled ? 'waiting_for_live_caption' : 'idle';
          state.captionMode = 'live';
          scheduler.setCaptionMode('live');
        state.errorMessage = `captions: ${err instanceof Error ? err.message : String(err)}; live captions require YouTube CC`;
        notifyStateChange();
      }
    };

    const selectTrack = async (track: SubtitleTrack) => {
      if(!state.settings.enabled || playerVideoId!==watchVideoId(location.href))return;
      if (state.captionMode === 'preloaded' && state.cues.length && state.selectedTrack?.id === track.id) return;
      const generation = initGeneration;
      const trackRequest = ++trackGeneration;
      captionHarvester.stop();
      scheduler.setCues([]);
      state.cues = [];
      state.status = 'loading_captions';
      state.selectedTrack = track;
      state.settings.selectedTrackId = track.id;
      notifyStateChange();

      try {
        const isAlreadyTurkish = track.languageCode === 'tr';
        const method = isAlreadyTurkish ? 'native_tr' : 'youtube_tlang';
        scheduler.setVideoContext(
          subtitleAdapter.getVideoId() || '',
          track.kind || 'standard',
          track.languageCode,
          method
        );

        let rawCues: SubtitleCue[] = [];
        await preloadedSource.start({videoId:subtitleAdapter.getVideoId()||'',track}, {onCues:cues=>{rawCues=cues;},onStatus:source=>{state.captionSource=source;}});
        if (generation !== initGeneration || trackRequest !== trackGeneration) return;

        if (rawCues.length > 0) {
          removePreloadedUpgrade();
          const captionReadyMs = performance.now();
          const videoNow = (document.querySelector('video') as HTMLVideoElement | null)?.currentTime || 0;
          const assembled = state.settings.speechResegmentationEnabled
            ? prepareSpokenCues(rawCues, track.languageCode, `${subtitleAdapter.getVideoId() || 'video'}:sent`)
            : rawCues.map(cue => ({ ...cue }));
          const assembleMs = performance.now() - captionReadyMs;
          const needsTranslation = track.languageCode !== 'tr' && state.settings.autoTranslateCaptions && isPauseFeatureEnabled('translationPipeline');
          if (needsTranslation) {
            const readiness = await translationReadiness();
            if (generation !== initGeneration || trackRequest !== trackGeneration || !state.settings.enabled) return;
            if (readiness !== 'ready') {
              failSession(setupRequiredUserMessage(readiness === 'missing_key' ? 'missing_key' : 'unavailable'), true);
              return;
            }
          }
          const warmStarted = performance.now();
          const warmPromise = state.settings.enabled
            ? ttsManager.warm(speakerManager.getSlot().providerId).then(() => performance.now() - warmStarted).catch(error => {if(generation===initGeneration&&trackRequest===trackGeneration&&state.settings.enabled)failSession(`model: ${String(error)}`);return null;})
            : Promise.resolve(null);

          let spokenCues = assembled;
          let startupTranslateMs: number | null = null;
          let startupLimit: PreloadedTranslationRateLimit | null = null;
          if (needsTranslation) {
            const translateStarted = performance.now();
            const initial = startupIndexes(assembled, videoNow);
            noteExtensionEvent('translation_state', { phase: 'started', count: initial.length });
            try {
              spokenCues = await translateCueIndexes(assembled, initial, text => Translator.toTurkish(text), () => generation === initGeneration && trackRequest === trackGeneration && state.settings.enabled);
            } catch (error) {
              if (isTranslationSetupRequired(error)) { failSession(error.message, true); return; }
              if (!(error instanceof PreloadedTranslationRateLimit)) throw error;
              spokenCues = error.cues;
              startupLimit = error;
            }
            startupTranslateMs = performance.now() - translateStarted;
            if (!startupLimit && initial.length > 0 && !spokenCues.some(cue => cue.turkishText?.trim())) {
              state.errorMessage = 'translation: startup window produced no Turkish text';
            }
            if (generation !== initGeneration || trackRequest !== trackGeneration) return;
          }
          const warmMs = await warmPromise;
          if (generation !== initGeneration || trackRequest !== trackGeneration) return;

          captionHarvester.stop();
          state.captionMode = 'preloaded';
          scheduler.setCaptionMode('preloaded');
          state.cues = spokenCues;
          state.status = state.settings.enabled ? 'buffering' : 'idle';
          const startupClosed = startupLimit || state.errorMessage === 'translation: startup window produced no Turkish text';
          if (!startupClosed && !isRateLimitMessage(state.errorMessage)) state.errorMessage = null;
          scheduler.setCues(spokenCues);
          scheduler.recordStartup({
            fragmentCount: rawCues.length,
            sentenceCount: spokenCues.length,
            assembleMs: Math.round(assembleMs),
            startupTranslateMs: startupTranslateMs === null ? null : Math.round(startupTranslateMs),
            modelWarmMs: warmMs === null ? null : Math.round(warmMs),
            videoSec: videoNow,
            translatedAtStart: spokenCues.filter(cue => cue.turkishText?.trim()).length,
          });
          scheduler.kick();
          notifyStateChange();

          if (startupLimit) noteTranslationRateLimit(startupLimit);
          else if (track.languageCode !== 'tr' && state.settings.autoTranslateCaptions && isPauseFeatureEnabled('translationPipeline')) {
            const pending = spokenCues.map((cue, index) => index).filter(index => !spokenCues[index].turkishText?.trim());
            const playheadIndex = spokenCues.findIndex(cue => cue.endTime >= videoNow);
            const prioritized = [...pending.filter(index => index >= playheadIndex), ...pending.filter(index => index < playheadIndex)];
            void translateCueWindows(spokenCues, prioritized, text => Translator.toTurkish(text),
              () => generation === initGeneration && trackRequest === trackGeneration && state.settings.enabled,
              publishTranslations).catch(error => {
              if(generation!==initGeneration||trackRequest!==trackGeneration||!state.settings.enabled)return;
              if (noteTranslationFailure(error)) return;
              failSession(`translation: ${String(error)}`);
              scheduler.recordStartup({ remainderTranslationError: error instanceof Error ? error.message : String(error) });
            });
          }
        } else {
          // Fallback to LiveCaptionHarvester until the player's signed XHR arrives.
          captionHarvester.start({videoId: subtitleAdapter.getVideoId() || '',video: document.querySelector('video') || undefined}, {onCues:()=>{},onStatus:source=>{state.captionSource=source;scheduler.setCaptionSource(source);notifyStateChange();}});
          state.status = state.settings.enabled ? 'waiting_for_live_caption' : 'idle';
          state.captionMode = 'live';
          scheduler.setCaptionMode('live');
          activation.phase('blocked');
          state.errorMessage = 'captions: preloaded track unavailable; enable captions in YouTube for live mode';
          armPreloadedUpgrade(track, generation, trackRequest);
          notifyStateChange();
        }
      } catch (err) {
        if (generation !== initGeneration || trackRequest !== trackGeneration) return;
        if (noteTranslationFailure(err)) return;
        armPreloadedUpgrade(track, generation, trackRequest);
        activation.phase('blocked');
        console.warn('[VestaDub] selectTrack failed, falling back to LiveCaptionHarvester:', err);
        captionHarvester.start({videoId: subtitleAdapter.getVideoId() || '',video: document.querySelector('video') || undefined}, {onCues:()=>{},onStatus:source=>{state.captionSource=source;scheduler.setCaptionSource(source);notifyStateChange();}});
        state.status = state.settings.enabled ? 'waiting_for_live_caption' : 'idle';
          state.captionMode = 'live';
          scheduler.setCaptionMode('live');
        state.errorMessage = `captions: ${err instanceof Error ? err.message : String(err)}; live captions require YouTube CC`;
        notifyStateChange();
      }
    };

    scheduler.setStatusCallback((status, reason) => {
      if(status==='error'&&state.settings.enabled){failSession(reason||'playback failed');return;}
      if(status==='playing')activation.phase('active');
      state.status = status;
      state.errorMessage = nextSchedulerErrorMessage(state.errorMessage, status, reason);
      notifyStateChange();
    });
    audioManager.setDuckingLevel(state.settings.originalVideoVolume);
    // A trusted page gesture resumes content-owned audio independently of popup lifetime.
    document.addEventListener('pointerdown', () => { if (state.settings.enabled && isPauseFeatureEnabled('ttsScheduler')) void audioManager.getContext().catch(e => { state.status = 'error'; state.errorMessage = `audio_context: ${e.message}`; notifyStateChange(); }); }, true);

    function checkNavigation():void {
      if(!preferenceReady||tornDown)return;
      const id=watchVideoId(location.href);
      const changed=activation.visit(id);
      if(changed){
        stopRuntime();subtitleAdapter.reset();captionHarvester.reset();recorder.onNavigation(location.href);
        lastElement=null;
      }
      state.settings.enabled=activation.snapshot().activeVideoId!==null;
      const video=id ? document.querySelector('video') as HTMLVideoElement|null : null;
      if(id&&video&&video.readyState>=1&&playerVideoId===id)activation.confirmVideo(id);
      const run=Boolean(state.settings.enabled&&video&&video.readyState>=1&&playerVideoId===id);
      if(changed||video!==lastElement||run!==pipelineRunning){
        if(!changed&&lastElement && video!==lastElement)stopRuntime();
        state.settings.enabled=activation.snapshot().activeVideoId!==null;
        lastElement=video;pipelineRunning=run;void initVideo();
      }
    }
    function reconcileIdentity():void {
      // MAIN-world handshake is read-only and responds synchronously when installed.
      window.dispatchEvent(new Event('vesta-request-player-identity'));
      checkNavigation();
    }
    ctx.addEventListener(window,'vesta-player-identity',(event:Event)=>{
      const detail=(event as CustomEvent).detail;
      if(detail?.url!==location.href)return;
      const reported=typeof detail.playerVideoId==='string'&&detail.playerVideoId?detail.playerVideoId:null;
      // A transient missing API response on the same confirmed element is not a navigation.
      if(reported)playerVideoId=reported;
      else if(watchVideoId(location.href)!==activation.snapshot().videoId||document.querySelector('video')!==lastElement)playerVideoId=null;
      checkNavigation();
    });
    for(const name of ['yt-navigate-start','yt-navigate-finish','vesta-location-changed','popstate','hashchange','pageshow'])ctx.addEventListener(window,name,reconcileIdentity);
    ctx.addEventListener(document,'loadedmetadata',reconcileIdentity,true);
    const navigationTimer=window.setInterval(reconcileIdentity,1000);
    ctx.onInvalidated(()=>window.clearInterval(navigationTimer));

    window.addEventListener('vesta-caption-payload', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!state.settings.enabled || state.selectedTrack || !state.videoDetected || detail?.videoId !== subtitleAdapter.getVideoId()) return;
      if (typeof detail?.text !== 'string' || detail.text.length === 0 || detail.text.length > 1_500_000) return;
      const generation = initGeneration;
      void subtitleAdapter.getAvailableTracks(true).then(tracks => {
        if (generation !== initGeneration || state.selectedTrack) return;
        state.tracks = tracks;
        const track = selectSpokenSourceTrack(tracks);
        if (track) void selectTrack(track);
      });
    });

    const applyIsolationRuntime = () => {
      const flags = readPauseIsolationFlags();
      audioManager.setDuckingEnabled(flags.audioDucking);
      if (!flags.ttsScheduler) scheduler.setEnabled(false);
      if (!flags.domCaptionObserver) captionHarvester.stop();
    };
    applyIsolationRuntime();

    // Preferences are the only persisted activation input; legacy enabled/session keys are ignored.
    let preferenceChanged=false;
    ctx.addEventListener(window,'DOMContentLoaded',reconcileIdentity);
    const onPreference=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if(area!=='local'||!changes[ACTIVATION_KEY])return;
      // An edit during initial storage restoration still cannot activate this already-open video.
      if(!preferenceReady)activation.visit(watchVideoId(location.href),false);
      preferenceChanged=true;activation.setMode(activationPreference(changes[ACTIVATION_KEY].newValue).mode);
      notifyStateChange(); // No visit/start: an edit applies to the next lifecycle.
    };
    chrome.storage.onChanged.addListener(onPreference);
    ctx.onInvalidated(()=>chrome.storage.onChanged.removeListener(onPreference));
    void chrome.storage.local.get(ACTIVATION_KEY).then(stored=>{
      if(!preferenceChanged)activation.setMode(activationPreference(stored[ACTIVATION_KEY]).mode);
    }).catch(()=>{}).finally(()=>{preferenceReady=true;reconcileIdentity();notifyStateChange();});
    ctx.addEventListener(window,'pageshow',event=>{
      if(!event.isTrusted||!event.persisted||tornDown)return;
      // BFCache return is a fresh logical session, not a revival of prior consent.
      void chrome.storage.local.get(ACTIVATION_KEY).then(stored=>activation.setMode(activationPreference(stored[ACTIVATION_KEY]).mode))
        .catch(()=>activation.setMode('manual')).finally(()=>{preferenceReady=true;reconcileIdentity();notifyStateChange();});
    });

    // Message listener for popup
    chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (message.type === 'GET_RECOVERY_TRACE') { sendResponse({ activation:activation.snapshot(), activationRuntime:{enabled:state.settings.enabled,pipelineRunning,playerVideoId,status:state.status}, trace: scheduler.trace, captions: subtitleAdapter.getDiagnosticLogs(), source: state.captionSource, continuity: scheduler.getContinuityStats(), providers: ttsManager.getAllProviders().map(p=>({id:p.id,isLoaded:p.isLoaded})) }); return true; }
      if (message.type === 'GET_STATE') {
        reconcileIdentity();state.activation=activation.snapshot();
        checkModelCache().then(() => sendResponse(state));
        return true;
      }

      if(message.type==='SET_ACTIVATION_MODE'){
        const preference=activationPreference({version:1,mode:message.mode});
        chrome.storage.local.set({[ACTIVATION_KEY]:preference}).then(()=>{
          activation.setMode(preference.mode);notifyStateChange();sendResponse({success:true,state});
        }).catch(error=>sendResponse({success:false,error:String(error)}));return true;
      }
      if (message.type === 'TOGGLE_DUBBING') {
        if(typeof message.enabled!=='boolean'){sendResponse({success:false,error:'Geçersiz başlat/durdur isteği.'});return true;}
        const id=watchVideoId(location.href),snapshot=activation.snapshot();
        if(message.enabled && (message.videoId!==id || message.documentId!==snapshot.documentId || (message.activationEpoch!==snapshot.epoch && snapshot.activeVideoId!==id))){
          sendResponse({success:false,error:'Video değişti. Güncel videoda yeniden başlatın.',state});return true;
        }
        if(message.enabled){
          if(!id||!preferenceReady){sendResponse({success:false,error:'Desteklenen bir YouTube videosu bekleniyor.',state});return true;}
          reconcileIdentity();
          if(activation.start(id)){state.errorMessage=null;reconcileIdentity();}
        }else{
          activation.visit(id,false); // Stop also consumes a lifecycle whose initial preference read is still pending.
          activation.phase('stopping');notifyStateChange();activation.stop();stopRuntime();state.status='idle';state.errorMessage=null;
          lastElement=null;reconcileIdentity();
        }
        notifyStateChange();sendResponse({success:true,state});return true;
      }

      if (message.type === 'SET_DUCKING_VOLUME') {
        state.settings.originalVideoVolume = message.volume;
        audioManager.setDuckingLevel(message.volume);
        sendResponse({ success: true, state });
        notifyStateChange();
        return true;
      }

      if (message.type === 'SET_ADAPTIVE_SYNC') {
        state.settings.adaptiveSyncEnabled = message.enabled;
        if (message.maxSpeed) state.settings.maxSpeedStretch = message.maxSpeed;
        sendResponse({ success: true, state });
        notifyStateChange();
        return true;
      }

      if (message.type === 'SET_SPEECH_RESEGMENTATION') {
        state.settings.speechResegmentationEnabled = Boolean(message.enabled);
        // Explicit reversible comparison; acquisition and native cache stay intact.
        state.captionMode = 'live';
        if (state.selectedTrack) void selectTrack(state.selectedTrack);
        sendResponse({ success: true });
        return true;
      }

      if (message.type === 'SELECT_TRACK') {
        const track = state.tracks.find((t: SubtitleTrack) => t.id === message.trackId);
        if (track) {
          selectTrack(track).then(() => sendResponse({ success: true, state }));
          return true;
        }
      }

      if (message.type === 'UPDATE_SPEAKER') {
        const requested = message.slot?.providerId;
        const providerId = requested === undefined
          ? speakerManager.getSlot(message.speakerId).providerId
          : migrateStoredProvider(message.speakerId, requested);
        if (requested !== undefined) {
          try { ttsManager.getProvider(providerId); }
          catch(error){sendResponse({success:false,error:String(error)});return true;}
        }
        speakerManager.updateSlot(message.speakerId, { ...message.slot, providerId });
        state.settings.speakers = Object.fromEntries(
          speakerManager.getAllSlots().map((s: SpeakerSlot) => [s.id, s])
        );

        scheduler.refreshVoice();
        void ttsManager.releaseUnusedProviders(speakerManager.getAllSlots().map(s=>s.providerId)).catch(error=>console.warn('[VestaDub] Provider disposal',error));

        // Persist speaker preference for this video
        const currentVid = subtitleAdapter.getVideoId();
        if (currentVid && chrome.storage?.local) {
          const key = `vesta_speakers_${currentVid}`;
          chrome.storage.local.set({ [key]: state.settings.speakers });
        }

        sendResponse({ success: true, state });
        notifyStateChange();
        return true;
      }

      if (message.type === 'SET_CUE_SPEAKER') {
        state.cues = speakerManager.assignCueSpeaker(state.cues, message.cueIndex, message.speakerId);
        scheduler.setCues(state.cues);
        sendResponse({ success: true, state });
        notifyStateChange();
        return true;
      }

      if (message.type === 'PURGE_MODELS') {
        ModelStorage.clear().then(() => {
          ttsManager.clearAudioCache();
          checkModelCache().then(() => {
            sendResponse({ success: true, state });
            notifyStateChange();
          });
        });
        return true;
      }

      if (message.type === 'RECOVERY_AUDIO_DIAGNOSTIC') {
        // Explicit diagnostic only. This is not a caption/scheduler acceptance result.
        (async () => {
          const result = await ttsManager.synthesize('antalia', message.text, { speed: 1 });
          const ctx = await audioManager.getContext();
          if (ctx.state !== 'running') throw new Error(`AudioContext ${ctx.state}`);
          const stopCapture = await audioManager.startDiagnosticCapture();
          const source = ctx.createBufferSource();
          const processed = AudioDSP.gainStageAndLimit(result.audio, { targetRms: .10, maxPeak: .96, provider: 'antalia' }).samples;
          source.buffer = await audioManager.createAudioBuffer(processed, result.sampleRate);
          source.connect(audioManager.getDubbingGain());
          let captured: Blob;
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { source.onended = null; source.stop(); reject(new Error('Diagnostic playback timed out')); }, (result.duration + 3) * 1000);
              source.onended = () => { clearTimeout(timer); source.disconnect(); resolve(); };
              source.start(ctx.currentTime);
            });
          } finally { captured = await stopCapture(); source.disconnect(); }
          sendResponse({ success: true, contextState: ctx.state, sampleRate: result.sampleRate, pcm: Array.from(result.audio), timings: result.timings, captureMime: captured!.type, captureBytes: Array.from(new Uint8Array(await captured!.arrayBuffer())) });
        })().catch(e => sendResponse({ success: false, error: e.message }));
        return true;
      }

      if (message.type === 'TEST_SYNTHESIS') {
        if(state.settings.enabled && !document.querySelector('video')?.paused){sendResponse({success:false,error:'Ses testi için önce videoyu duraklatın.'});return true;}
        const preparation=prepareSpeech(message.text,{sourceText:message.text});
        if(preparation.omitted){sendResponse({success:true,duration:0,omitted:true});return true;}
        ttsManager.synthesize(message.providerId, preparation.spokenText, { speed: 1.0 })
          .then(async (res: SynthesisResult) => {
            const ctx = await audioManager.getContext();
            if (ctx.state === 'suspended') {
              await ctx.resume().catch(() => {});
            }
            const processed=AudioDSP.gainStageAndLimit(res.audio,{targetRms:.10,maxPeak:.96,provider:message.providerId==='ema-lightning'?'ema':'antalia'}).samples;
            const buffer = await audioManager.createAudioBuffer(processed, res.sampleRate);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(audioManager.getDubbingGain());
            source.start();
            sendResponse({ success: true, duration: res.duration, timings: res.timings });
          })
          .catch((err: Error) => {
            sendResponse({ success: false, error: err.message });
          });
        return true;
      }

      // Dogfood Telemetry & Session Management
      if (message.type === 'DOGFOOD_START_SESSION') {
        const sid = recorder.startSession(message.mode || 'real_live_youtube');
        sendResponse({ success: true, sessionId: sid });
        return true;
      }

      if (message.type === 'DOGFOOD_STOP_SESSION') {
        const summary = recorder.stopSession();
        sendResponse({ success: true, summary });
        return true;
      }

      if (message.type === 'DOGFOOD_GET_STATS') {
        const stats = recorder.getLiveStats();
        sendResponse({ success: true, stats });
        return true;
      }

      if (message.type === 'DOGFOOD_EXPORT_REPORT') {
        const exportData = telemetry.exportAnonymizedReport();
        sendResponse({ success: true, exportData });
        return true;
      }

      if (message.type === 'DOGFOOD_CLEAR_DATA') {
        recorder.stopSession();
        telemetry.clearData().then(() => sendResponse({ success: true }));
        return true;
      }

      if (message.type === 'GET_PAUSE_ISOLATION') {
        sendResponse({ flags: readPauseIsolationFlags(), trace: readPauseTrace() });
        return true;
      }

      if (message.type === 'SET_PAUSE_ISOLATION') {
        const flags = message.reset ? resetPauseIsolationFlags() : writePauseIsolationFlags(message.flags || {});
        if (message.clearTrace) clearPauseTrace();
        applyIsolationRuntime();
        sendResponse({ success: true, flags });
        return true;
      }

      return false;
    });
  },
});
