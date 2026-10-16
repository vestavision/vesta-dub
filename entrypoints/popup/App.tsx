import { ACTIVATION_KEY, ACTIVATION_MODES, activationPreference, type ActivationMode } from '@/src/activation/ActivationPolicy';
import { useState, useEffect, useRef } from "preact/hooks";
import { ExtensionState, TTSProviderId, SubtitleCue } from "@/src/core/types";
import { TTSManager } from "@/src/tts/TTSManager";
import { getPlaybackNotice } from "@/src/ui/PlaybackNotice";
import { migrateStoredProvider } from "@/src/speaker/VoiceMigration";
import { LOCAL_TRANSLATION_DOWNLOAD_BYTES } from "@/src/translation/LocalTranslationModel";
import { LOCAL_TRANSLATION_STATUS_KEY, type LocalTranslationStatus } from "@/src/translation/LocalTranslationEngine";
import { normalizeTranslationKey, TRANSLATION_KEY_STORAGE } from "@/src/translation/TranslationKey";
import { normalizeTranslationMode, TRANSLATION_MODE_STORAGE, type TranslationMode } from "@/src/translation/TranslationMode";
import { PauseIsolationPanel } from "./PauseIsolationPanel";

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
}

function localStatusText(status: LocalTranslationStatus | null): string {
  if (!status || status.state === "idle") return "Model henüz indirilmedi. Dublaj başlayınca veya Modeli indir ile alınır.";
  if (status.state === "downloading") return `İndiriliyor: ${formatMegabytes(status.loadedBytes)} / ${formatMegabytes(status.totalBytes)}.`;
  if (status.state === "loading") return "Model bu cihazda hazırlanıyor.";
  if (status.state === "ready" && status.error === "storage") return "Model bu oturumda hazır. Tarayıcı deposuna yazılamadı, bir sonraki açılışta yeniden indirilebilir.";
  if (status.state === "ready") return "Model bu cihazda hazır. Çeviri yerelde yapılır.";
  if (status.error === "hash") return "İndirilen dosya doğrulanamadı. Yeniden deneyin. Buluta geçilmez.";
  if (status.error === "runtime") return "Bu tarayıcı modeli çalıştıramadı. İngilizce altyazı seslendirilmez.";
  return "Model indirilemedi. Bağlantını kontrol edip yeniden dene. Buluta geçilmez.";
}

export function App() {
  const targetTab=useRef<number|null>(null);
  const stateRequest=useRef(0);
  const targetDocument=useRef<string|null>(null);
  const tabLoading=useRef(false);
  const [activationMode,setActivationMode]=useState<ActivationMode>('manual');
  const [activationError,setActivationError]=useState<string|null>(null);
  const [activationPending,setActivationPending]=useState<'starting'|'stopping'|null>(null);
  const [state, setState] = useState<ExtensionState | null>(null);
  const [activeTab, setActiveTab] = useState<
    "control" | "speakers" | "transcript" | "diagnostics"
  >("control");
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [showVoiceFiles, setShowVoiceFiles] = useState(false);
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [transcriptPage, setTranscriptPage] = useState(0);
  const [testingVoice, setTestingVoice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [translationKeyDraft, setTranslationKeyDraft] = useState("");
  const [translationKeyConfigured, setTranslationKeyConfigured] = useState(false);
  const [translationKeyMessage, setTranslationKeyMessage] = useState<string | null>(null);
  const [translationMode, setTranslationMode] = useState<TranslationMode>("local");
  const [localStatus, setLocalStatus] = useState<LocalTranslationStatus | null>(null);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);
  const popupAudioCtxRef = useRef<AudioContext | null>(null);

  useEffect(()=>{
    const cleanup=()=>{void TTSManager.getInstance().disposeAll();void popupAudioCtxRef.current?.close();};
    window.addEventListener('pagehide',cleanup);
    return ()=>{window.removeEventListener('pagehide',cleanup);cleanup();};
  },[]);

  const refreshTranslationKey = async () => {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
      const response = await chrome.runtime.sendMessage({ type: "TRANSLATION_STATUS" });
      if (response && typeof response.configured === "boolean") setTranslationKeyConfigured(response.configured);
      if (response?.mode) setTranslationMode(normalizeTranslationMode(response.mode));
      if (response?.local) setLocalStatus(response.local as LocalTranslationStatus);
    } catch {
      // A missing worker leaves the last status. Mount starts as not configured.
    }
  };
  useEffect(() => { void refreshTranslationKey(); }, []);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      if (changes[LOCAL_TRANSLATION_STATUS_KEY]) setLocalStatus(changes[LOCAL_TRANSLATION_STATUS_KEY].newValue as LocalTranslationStatus);
      if (changes[TRANSLATION_MODE_STORAGE]) setTranslationMode(normalizeTranslationMode(changes[TRANSLATION_MODE_STORAGE].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Dogfood Diagnostic State (Disabled by default)
  const [diagEnabled, setDiagEnabled] = useState(false);
  const [dogfoodStats, setDogfoodStats] = useState<any>(null);
  const [dogfoodMode, setDogfoodMode] = useState<
    | "real_live_youtube"
    | "controlled_browser_fixture"
    | "accelerated_simulation"
  >("real_live_youtube");
  const [diagActionMessage, setDiagActionMessage] = useState<string | null>(
    null,
  );

  // Helper to find YouTube tab (first active in window, or any tab on youtube.com)
  const getYouTubeTab = async (): Promise<chrome.tabs.Tab | undefined> => {
    try {
      if(targetTab.current!==null)return await chrome.tabs.get(targetTab.current);
      const tabs=await chrome.tabs.query({active:true,currentWindow:true});
      const tab=tabs[0];
      if(tab?.id && /^https:\/\/(?:www\.|m\.)?youtube\.com\//.test(tab.url||'')){targetTab.current=tab.id;return tab;}
      return undefined;
    } catch {
      return undefined;
    }
  };

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get("vesta_onboarding_complete", (res) => {
        if (!res?.vesta_onboarding_complete) setShowOnboarding(true);
        setOnboardingLoaded(true);
      });
    } else {
      setShowOnboarding(true);
      setOnboardingLoaded(true);
    }
    // Check if diagnostic mode was enabled in local storage
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get("vesta_diag_ui_enabled", (res) => {
        if (res?.vesta_diag_ui_enabled) {
          setDiagEnabled(true);
        }
      });
    }

    // Fetch initial state from active tab
    const fetchState = async () => {
      const request=++stateRequest.current;
      try {
        const tab = await getYouTubeTab();
        if (tab?.id) {
          if(tab.status==='loading'){tabLoading.current=true;setState(null);return;}
          tabLoading.current=false;
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATE" });
          if (resp && request===stateRequest.current){targetDocument.current=resp.activation?.documentId||null;setState(resp);}
        }
      } catch {
        if(request===stateRequest.current)setState(null);
        // Tab may not have content script running yet
      }
    };

    fetchState();

    // Listen for state updates
    const listener = (msg: { type: string; state: ExtensionState },sender:chrome.runtime.MessageSender) => {
      if (msg.type === "STATE_UPDATE" && msg.state && sender.tab?.id===targetTab.current) {
        if(tabLoading.current)return;
        if(!targetDocument.current||msg.state.activation?.documentId!==targetDocument.current){void fetchState();return;}
        ++stateRequest.current;setState(msg.state);
      }
    };

    const updated=(id:number,change:chrome.tabs.TabChangeInfo)=>{
      if(id!==targetTab.current)return;
      if(change.status==='loading'){tabLoading.current=true;targetDocument.current=null;++stateRequest.current;setState(null);}
      if(change.status==='complete')void fetchState();
    };
    const removed=(id:number)=>{if(id===targetTab.current){++stateRequest.current;targetDocument.current=null;setState(null);}};
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(listener);chrome.tabs.onUpdated.addListener(updated);chrome.tabs.onRemoved.addListener(removed);
      return () => {chrome.runtime.onMessage.removeListener(listener);chrome.tabs.onUpdated.removeListener(updated);chrome.tabs.onRemoved.removeListener(removed);};
    }
  }, []);

  useEffect(()=>{
    void chrome.storage.local.get(ACTIVATION_KEY).then(s=>setActivationMode(activationPreference(s[ACTIVATION_KEY]).mode));
    const listener=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if(area==='local'&&changes[ACTIVATION_KEY])setActivationMode(activationPreference(changes[ACTIVATION_KEY].newValue).mode);
    };
    chrome.storage.onChanged.addListener(listener);return ()=>chrome.storage.onChanged.removeListener(listener);
  },[]);
  const changeActivationMode=async(mode:string)=>{
    const pref=activationPreference({version:1,mode});setActivationError(null);
    try{await chrome.storage.local.set({[ACTIVATION_KEY]:pref});setActivationMode(pref.mode);}
    catch{setActivationError('Oynatma tercihi kaydedilemedi. Önceki kayıtlı tercih geçerli.');}
  };

  // Poll dogfood stats when diagnostic tab is active
  useEffect(() => {
    if (activeTab !== "diagnostics") return;

    const fetchStats = async () => {
      try {
        const tab = await getYouTubeTab();
        if (tab?.id) {
          const resp = await chrome.tabs.sendMessage(tab.id, {
            type: "DOGFOOD_GET_STATS",
          });
          if (resp?.stats) {
            setDogfoodStats(resp.stats);
          }
        }
      } catch {}
    };

    fetchStats();
    const timer = setInterval(fetchStats, 1200);
    return () => clearInterval(timer);
  }, [activeTab]);

  const toggleDiagMode = () => {
    const next = !diagEnabled;
    setDiagEnabled(next);
    if (!next && activeTab === "diagnostics") {
      setActiveTab("control");
    }
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ vesta_diag_ui_enabled: next });
    }
  };

  const sendMessage = async (message: unknown) => {
    try {
      const tab = await getYouTubeTab();
      if (tab?.id) {
        const resp = await chrome.tabs.sendMessage(tab.id, message);
        if (resp?.state) setState(resp.state);
        return resp;
      }
    } catch (err) {
      console.warn("Message send failed:", err);
    }
    return null;
  };

  const toggleDubbing = async () => {
    if(!state||activationPending)return;
    const nextEnabled=!(state.activation?.activeVideoId || state.settings.enabled || state.activation?.continuationAllowed);
    setActivationPending(nextEnabled?'starting':'stopping');
    try{await sendMessage({type:'TOGGLE_DUBBING',enabled:nextEnabled,videoId:state.activation?.videoId||state.playback?.videoId,documentId:state.activation?.documentId,activationEpoch:state.activation?.epoch});}
    finally{setActivationPending(null);}
  };

  const setDuckingVolume = async (val: number) => {
    await sendMessage({ type: "SET_DUCKING_VOLUME", volume: val });
  };

  const setAdaptiveSync = async (enabled: boolean) => {
    await sendMessage({ type: "SET_ADAPTIVE_SYNC", enabled });
  };

  const selectTrack = async (trackId: string) => {
    await sendMessage({ type: "SELECT_TRACK", trackId });
  };

  const updateSpeaker = async (
    speakerId: string,
    updates: Record<string, unknown>,
  ) => {
    await sendMessage({ type: "UPDATE_SPEAKER", speakerId, slot: updates });
  };

  const setCueSpeaker = async (cueIndex: number, speakerId: string) => {
    await sendMessage({ type: "SET_CUE_SPEAKER", cueIndex, speakerId });
  };

  const saveTranslationKey = async () => {
    const key = normalizeTranslationKey(translationKeyDraft);
    if (!key) {
      setTranslationKeyMessage("Anahtar biçimi geçersiz. Google Cloud anahtarını yapıştır.");
      return;
    }
    try {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      await chrome.storage.session.set({ [TRANSLATION_KEY_STORAGE]: key });
      setTranslationKeyDraft("");
      setTranslationKeyConfigured(true);
      setTranslationKeyMessage("Anahtar bu oturum için kaydedildi. Sayfaya yazılmadı.");
      await refreshTranslationKey();
    } catch {
      setTranslationKeyConfigured(false);
      setTranslationKeyMessage("Anahtar kaydedilemedi. Eklenti depolaması kullanılamıyor.");
    }
  };

  const changeTranslationMode = async (value: string) => {
    const mode = normalizeTranslationMode(value);
    setTranslationMode(mode);
    try {
      await chrome.storage.local.set({ [TRANSLATION_MODE_STORAGE]: mode });
      await chrome.runtime.sendMessage({ type: "SET_TRANSLATION_MODE", mode });
    } catch {
      setTranslationKeyMessage("Çeviri tercihi kaydedilemedi.");
    }
  };

  const prepareLocalTranslation = async () => {
    setTranslationKeyMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({ type: "PREPARE_LOCAL_TRANSLATION" }) as { status?: LocalTranslationStatus } | undefined;
      if (response?.status) setLocalStatus(response.status);
    } catch {
      setTranslationKeyMessage("Yerel model indirilemedi.");
    }
  };

  const clearTranslationKey = async () => {
    try {
      await chrome.storage.session.remove(TRANSLATION_KEY_STORAGE);
      setTranslationKeyDraft("");
      setTranslationKeyConfigured(false);
      setTranslationKeyMessage("Anahtar bu oturumdan silindi.");
    } catch {
      setTranslationKeyMessage("Anahtar silinemedi.");
    }
  };

  const purgeModels = async () => {
    if (
      confirm(
        "İndirilen tüm yerel TTS modellerini silmek istediğinize emin misiniz?",
      )
    ) {
      await sendMessage({ type: "PURGE_MODELS" });
    }
  };

  const testSynthesis = async (providerId: TTSProviderId) => {
    setTestingVoice(providerId);
    setTestResult("Hazırlanıyor (model ve ses bağlamı)...");

    try {
      // Use the existing tab-owned provider; closing the popup cannot duplicate or unload it.
      if(state?.videoDetected){
        const res=await sendMessage({type:"TEST_SYNTHESIS",providerId,text:"Merhaba! Vesta Dub ile Türkçe ses testi başarıyla tamamlandı."});
        if(!res?.success)throw new Error(res?.error || "YouTube sekmesinde ses testi başlatılamadı.");
        setTestResult(`YouTube sekmesinde oynatılıyor: ${res.duration.toFixed(2)}s.`);
        setTimeout(()=>{setTestingVoice(null);setTestResult(null);},res.duration*1000);
        return;
      }
      // 1. Initialize AudioContext directly in the popup on user gesture to avoid autoplay restrictions
      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!popupAudioCtxRef.current) {
        popupAudioCtxRef.current = new AudioContextClass();
      }
      const ctx = popupAudioCtxRef.current;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      setTestResult("Ses sentezleniyor (ONNX Runtime)...");
      const text =
        "Merhaba! Vesta Dub ile Türkçe ses testi başarıyla tamamlandı.";
      await TTSManager.getInstance().releaseUnusedProviders([providerId]);
      const res = await TTSManager.getInstance().synthesize(providerId, text, {
        speed: 1.0,
      });

      setTestResult(`Oynatılıyor: ${res.duration.toFixed(2)}s...`);
      const buffer = ctx.createBuffer(1, res.audio.length, res.sampleRate);
      buffer.getChannelData(0).set(res.audio);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      source.onended = () => {
        setTestResult(`Başarılı: ${res.duration.toFixed(2)}s ses çalındı.`);
        setTestingVoice(null);
        setTimeout(() => setTestResult(null), 4000);
      };

      source.start();

      // Preview belongs to the popup: never duplicate its synthesis/playback in the tab.
    } catch (err: any) {
      console.error("[VestaDub Popup] TTS test synthesis error:", err);
      setTestResult(`Hata: ${err?.message || "Bilinmeyen sentez hatası"}`);
      setTestingVoice(null);
      setTimeout(() => setTestResult(null), 5000);
    }
  };

  // Dogfood Action Handlers
  const startDogfoodSession = async () => {
    const resp = await sendMessage({
      type: "DOGFOOD_START_SESSION",
      mode: dogfoodMode,
    });
    if (resp?.success) {
      setDiagActionMessage(`Oturum başlatıldı: ${resp.sessionId}`);
      const statsResp = await sendMessage({ type: "DOGFOOD_GET_STATS" });
      if (statsResp?.stats) setDogfoodStats(statsResp.stats);
    }
    setTimeout(() => setDiagActionMessage(null), 3000);
  };

  const stopDogfoodSession = async () => {
    const resp = await sendMessage({ type: "DOGFOOD_STOP_SESSION" });
    if (resp?.success) {
      setDiagActionMessage("Oturum durduruldu ve kaydedildi.");
      const statsResp = await sendMessage({ type: "DOGFOOD_GET_STATS" });
      if (statsResp?.stats) setDogfoodStats(statsResp.stats);
    }
    setTimeout(() => setDiagActionMessage(null), 3000);
  };

  const exportRecoveryTrace = async () => {
    const result = await sendMessage({ type: "GET_RECOVERY_TRACE" });
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "vesta-recovery-trace.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const exportDogfoodReport = async () => {
    const resp = await sendMessage({ type: "DOGFOOD_EXPORT_REPORT" });
    if (resp?.exportData) {
      const dataStr =
        "data:text/json;charset=utf-8," +
        encodeURIComponent(JSON.stringify(resp.exportData, null, 2));
      const downloadAnchor = document.createElement("a");
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute(
        "download",
        `vesta-dogfood-${resp.exportData.summary.sessionId}.json`,
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setDiagActionMessage("Anonim telemetri raporu indirildi.");
    } else {
      setDiagActionMessage(
        "Dışa aktarılacak aktif veya kaydedilmiş oturum bulunamadı.",
      );
    }
    setTimeout(() => setDiagActionMessage(null), 3500);
  };

  const clearDogfoodData = async () => {
    if (
      confirm(
        "Yerel dogfood telemetri verilerini ve oturum kaydını temizlemek istiyor musunuz?",
      )
    ) {
      await sendMessage({ type: "DOGFOOD_CLEAR_DATA" });
      setDogfoodStats(null);
      setDiagActionMessage("Yerel telemetri verileri temizlendi.");
      setTimeout(() => setDiagActionMessage(null), 3000);
    }
  };

  // Fallback state when extension popup is opened without an active YouTube tab
  const defaultState: ExtensionState = {
    videoDetected: false,
    playback: null,
    tracks: [],
    selectedTrack: null,
    cues: [],
    settings: {
      enabled: false,
      originalVideoVolume: 0.2,
      dubbingVolume: 1.0,
      selectedTrackId: null,
      speakers: {
        "speaker-a": {
          id: "speaker-a",
          name: "Konuşmacı A (Birincil)",
          providerId: "antalia",
          speed: 1.0,
        },
        "speaker-b": {
          id: "speaker-b",
          name: "Konuşmacı B (İkincil)",
          providerId: "ema-lightning",
          speed: 1.0,
        },
      },
      defaultSpeakerId: "speaker-a",
      autoTranslateCaptions: true,
      lookaheadWindowSec: 6.0,
      adaptiveSyncEnabled: true,
      maxSpeedStretch: 1.25,
      speechResegmentationEnabled: false,
    },
    metrics: {
      activeCueIndex: -1,
      currentCueText: "",
      currentSpeakerId: "Konuşmacı A (Birincil)",
      activeProviderId: "antalia",
      synthesisLatencyMs: null,
      syncDriftMs: null,
      isOverflowing: false,
      realtimeFactor: null,
      bufferedCuesCount: 0,
      totalCuesCount: 0,
    },
    status: "idle",
    errorMessage: null,
    modelStatus: {
      "ema-lightning": { cached: true, downloading: false, progress: 1, sizeBytes: 37_397_589 },
      antalia: {
        cached: false,
        downloading: false,
        progress: 0,
        sizeBytes: 15_493_500,
      },
    },
  };

  const currentState = state || defaultState;
  const { settings, metrics, tracks, selectedTrack, errorMessage } =
    currentState;

  const playbackNotice = getPlaybackNotice(errorMessage);
  useEffect(() => setNoticeDismissed(false), [errorMessage]);

  const completeOnboarding = () => {
    setShowOnboarding(false);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ vesta_onboarding_complete: true });
    }
  };
  const transcriptPageCount = Math.max(
    1,
    Math.ceil(currentState.cues.length / 2),
  );
  const visibleTranscriptPage = Math.min(
    transcriptPage,
    transcriptPageCount - 1,
  );
  const pipelineStatusLabel = {
    idle: "Hazır",
    loading_captions: "Altyazılar yükleniyor",
    translating: "Çevriliyor",
    loading_model: "Ses hazırlanıyor",
    buffering: "Ses hazırlanıyor",
    playing: "Seslendiriliyor",
    waiting_for_live_caption: "Altyazı bekleniyor",
    error: "Bir sorun oluştu",
  }[currentState.status];
  const sessionRequested=Boolean(currentState.activation?.activeVideoId || settings.enabled);
  const canStopSession=sessionRequested || Boolean(currentState.activation?.continuationAllowed);
  const phase=activationPending || currentState.activation?.phase;
  const statusLabel=phase ? ({inactive:'Dublaj kapalı',starting:'Başlatılıyor',active:'Dublaj açık',stopping:'Durduruluyor',failed:'Başlatılamadı',blocked:'Engellendi'}[phase]) : pipelineStatusLabel;
  const onboarding = {
    eyebrow: "DAHA YAKINDAN DİNLE",
    title: "Dünya konuşsun.\nSen Türkçe dinle.",
    description:
      "YouTube’da altyazılı bir video aç, Vesta’yı seç ve Türkçe dublajı başlat. Sesini ve hızını dilediğin gibi ayarla.",
    note: "Sesler ve varsayılan çeviri cihazında çalışır. API anahtarı gerekmez. Google Cloud yalnızca kendi anahtarını seçersen kullanılır.",
  };

  return (
    <div class="extension-shell">
      <header class="app-header">
        <div class="brand">
          <img
            class="brand-mark"
            src="/icons/vesta-vision.svg"
            alt="Vesta Vision"
            width="34"
            height="34"
          />
          <span>
            vesta<span class="brand-sub">DUB</span>
          </span>
        </div>
        <div class="header-actions">
          <button
            class="icon-button"
            onClick={() => setShowOnboarding(true)}
            aria-label="Kullanım rehberini aç"
            title="Kullanım rehberi"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9.1 8a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
              <circle
                cx="12"
                cy="17"
                r=".9"
                fill="currentColor"
                stroke="none"
              />
            </svg>
          </button>
          <button
            class="icon-button"
            onClick={toggleDiagMode}
            aria-label="Geliştirici panelini aç veya kapat"
            aria-pressed={diagEnabled}
            title="Geliştirici paneli"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m9.5 3-.5 2a7 7 0 0 0-1.5.9l-2-.6L3 9.5 4.5 11a7 7 0 0 0 0 2L3 14.5l2.5 4.2 2-.6A7 7 0 0 0 9 19l.5 2h5l.5-2a7 7 0 0 0 1.5-.9l2 .6 2.5-4.2-1.5-1.5a7 7 0 0 0 0-2L21 9.5l-2.5-4.2-2 .6A7 7 0 0 0 15 5l-.5-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>
      {!onboardingLoaded ? (
        <div class="loading-state" role="status">
          Vesta hazırlanıyor…
        </div>
      ) : showOnboarding ? (
        <section class="onboarding">
          <div class="onboarding-top">
            <span class="eyebrow">TÜRKÇE DİNLEMENİN YENİ YOLU</span>
            <button class="text-button" onClick={completeOnboarding}>
              Atla
            </button>
          </div>
          <div class="sound-art" aria-hidden="true">
            <div class="orbit orbit-one" />
            <div class="orbit orbit-two" />
            <div class="sound-disc">
              <div class="waveform">
                {[18, 30, 48, 66, 42, 74, 54, 32, 18].map((height, i) => (
                  <i
                    key={i}
                    style={{
                      height: `${height}px`,
                      animationDelay: `${i * 80}ms`,
                    }}
                  />
                ))}
              </div>
            </div>
            <span class="art-label">EN → TR</span>
          </div>
          <div class="onboarding-copy">
            <span class="eyebrow">{onboarding.eyebrow}</span>
            <h1>{onboarding.title}</h1>
            <p>{onboarding.description}</p>
          </div>
          <div class="onboarding-bottom">
            <div class="onboarding-buttons">
              <button class="primary-button" onClick={completeOnboarding}>
                Dinlemeye başla <span aria-hidden="true">↗</span>
              </button>
            </div>
            <p class="fine-print">{onboarding.note}</p>
          </div>
        </section>
      ) : (
        <>
          <nav class="tab-nav" aria-label="Vesta bölümleri">
            {(
              [
                ["control", "Dinle"],
                ["speakers", "Sesler"],
                ["transcript", "Metin"],
                ...(diagEnabled ? [["diagnostics", "Teşhis"]] : []),
              ] as [typeof activeTab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                aria-current={activeTab === id ? "page" : undefined}
                class={activeTab === id ? "active" : ""}
                onClick={() => setActiveTab(id)}
              >
                {label}
                {id === "transcript" && (
                  <span class="tab-count">{currentState.cues.length}</span>
                )}
              </button>
            ))}
          </nav>
          <main
            class={`tab-content ${activeTab === "diagnostics" ? "diagnostics-content" : ""}`}
            key={activeTab}
          >
            {activeTab === "control" && (
              <>
                <section class="listen-hero">
                  <div class="section-heading">
                    <span class="eyebrow">DİNLEME ODASI</span>
                    <span class={`status ${phase==='active' ? "is-live" : ""}`}>
                      <i />
                      {statusLabel}
                    </span>
                  </div>
                  <h1>Hikâyeye kulak ver.</h1>
                  <p
                    class="listen-description"
                    title={metrics.currentCueText || undefined}
                  >
                    {metrics.currentCueText ||
                      (currentState.videoDetected
                        ? "Videon hazır. Türkçe seslendirmeyi başlat."
                        : "Altyazılı bir YouTube videosu açarak başla.")}
                  </p>
                  <div
                    class={`mini-wave ${phase==='active' && !currentState.playback?.paused ? "playing" : ""}`}
                    aria-hidden="true"
                  >
                    {[
                      8, 14, 22, 12, 30, 38, 24, 16, 32, 46, 28, 18, 36, 24, 12,
                      20, 8,
                    ].map((height, i) => (
                      <i
                        key={i}
                        style={{
                          height: `${Math.round(height * 0.45)}px`,
                          animationDelay: `${i * 60}ms`,
                        }}
                      />
                    ))}
                  </div>
                  <button
                    class="primary-button start-button"
                    disabled={Boolean(activationPending) || (!canStopSession && (!currentState.videoDetected || !state))}
                    onClick={toggleDubbing}
                  >
                    <span aria-hidden="true">
                      {canStopSession ? "■" : "▷"}
                    </span>
                    {canStopSession
                      ? (sessionRequested ? "Dublajı durdur" : "Bu sekmede devam etmeyi durdur")
                      : "Türkçe dublajı başlat"}
                  </button>
                  {!currentState.videoDetected && (
                    <a
                      class="youtube-link"
                      href="https://www.youtube.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      YouTube’u aç <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </section>
                <section class="settings-section">
                  <h2>Oynatma</h2>
                  <label class="field-label" for="activation-mode">Dublajı başlatma</label>
                  <select id="activation-mode" value={activationMode} onChange={e=>void changeActivationMode(e.currentTarget.value)}>
                    {ACTIVATION_MODES.map(mode=><option key={mode.value} value={mode.value}>{mode.label}</option>)}
                  </select>
                  <p class="inline-note">{ACTIVATION_MODES.find(m=>m.value===activationMode)?.description}</p>
                  {activationError && <p class="inline-note" role="alert">{activationError}</p>}
                  <p class="inline-note">Tercih değişikliği açık videoyu başlatmaz. Sonraki video veya sayfa yenilemede uygulanır.</p>
                  {activationMode==='tab' && <p class="inline-note">Bu mod seçiliyken Başlat’a bas. Sayfa yenilenirse yeniden başlat.</p>}
                </section>
                <section class="settings-section">
                  <div class="section-heading">
                    <h2>Altyazı & dil</h2>
                    <span class="language-pair">
                      {selectedTrack?.languageCode?.toUpperCase() || "—"}{" "}
                      <span>→</span> TR
                    </span>
                  </div>
                  <label class="field-label" for="caption-track">
                    Kaynak altyazı
                  </label>
                  {tracks.length ? (
                    <select
                      id="caption-track"
                      value={selectedTrack?.id || ""}
                      onChange={(e) => selectTrack(e.currentTarget.value)}
                    >
                      {tracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {t.languageCode}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div class="inline-note">
                      {currentState.videoDetected
                        ? "Altyazı bekleniyor. Videonun altyazılarını açmayı dene."
                        : "Video açıldığında altyazılar burada görünür."}
                    </div>
                  )}
                </section>
                <section class="settings-section">
                  <h2>Çeviri</h2>
                  <label class="field-label" for="translation-mode">Çeviri motoru</label>
                  <select id="translation-mode" value={translationMode} onChange={e => void changeTranslationMode(e.currentTarget.value)}>
                    <option value="local">Yerel çeviri — Varsayılan</option>
                    <option value="cloud">Google Cloud — Kendi anahtarım</option>
                  </select>
                  {translationMode === "local" ? (
                    <>
                      <p class="inline-note">Ücretsiz. Çeviri cihazında yapılır. API anahtarı gerekmez.</p>
                      <p class="inline-note">
                        İlk kullanımda {formatMegabytes(LOCAL_TRANSLATION_DOWNLOAD_BYTES)} indirilir. İndirme bir kez yapılır. Sonraki çeviri bu cihazda çalışır ve altyazı metnini dışarı göndermez.
                      </p>
                      <p class="inline-note" role="status">{localStatusText(localStatus)}</p>
                      {localStatus?.state === "downloading" && (
                        <progress class="model-progress" max={1} value={localStatus.progress} />
                      )}
                      {localStatus?.state !== "ready" && localStatus?.state !== "downloading" && localStatus?.state !== "loading" && (
                        <div class="key-actions">
                          <button type="button" onClick={() => void prepareLocalTranslation()}>Modeli indir</button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p class="inline-note">İsteğe bağlı. Google Cloud API anahtarınızı kullanır ve ücretlendirme uygulanabilir.</p>
                      <p class="inline-note">Altyazı metni Google Cloud Translation servisine gönderilir. Anahtar yalnızca bu tarayıcı oturumunda tutulur ve sayfaya yazılmaz.</p>
                      <p class="inline-note" role="status">
                        {translationKeyConfigured
                          ? "Bu oturum için anahtar kayıtlı."
                          : "Anahtar gerekli. Anahtar yokken İngilizce altyazı seslendirilmez."}
                      </p>
                      <label class="field-label" for="translate-api-key">Cloud Translation API anahtarı</label>
                      <input
                        id="translate-api-key"
                        class="secret-input"
                        type="password"
                        autocomplete="off"
                        spellcheck={false}
                        value={translationKeyDraft}
                        onInput={(e) => setTranslationKeyDraft(e.currentTarget.value)}
                      />
                      <div class="key-actions">
                        <button type="button" onClick={() => void saveTranslationKey()}>Bu oturuma kaydet</button>
                        <button type="button" onClick={() => void clearTranslationKey()} disabled={!translationKeyConfigured}>Anahtarı sil</button>
                      </div>
                    </>
                  )}
                  {translationKeyMessage && <p class="inline-note" role="status">{translationKeyMessage}</p>}
                </section>
                <section class="settings-section">
                  <div class="setting-row">
                    <div>
                      <h2>Doğal senkron</h2>
                      <p>Konuşma hızını videoya uyarlar.</p>
                    </div>
                    <input
                      aria-label="Doğal senkron"
                      class="switch"
                      type="checkbox"
                      checked={settings.adaptiveSyncEnabled}
                      onChange={(e) => setAdaptiveSync(e.currentTarget.checked)}
                      disabled={!state}
                    />
                  </div>
                  <div class="volume-setting">
                    <label for="original-volume">Orijinal ses</label>
                    <output for="original-volume">
                      {Math.round(settings.originalVideoVolume * 100)}%
                    </output>
                    <input
                      id="original-volume"
                      style={{
                        "--range-progress": `${settings.originalVideoVolume * 100}%`,
                      }}
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={settings.originalVideoVolume}
                      onInput={(e) => {
                        e.currentTarget.style.setProperty(
                          "--range-progress",
                          `${parseFloat(e.currentTarget.value) * 100}%`,
                        );
                        setDuckingVolume(parseFloat(e.currentTarget.value));
                      }}
                      disabled={!state}
                    />
                    <div class="range-labels">
                      <span>Yalnızca dublaj</span>
                      <span>Arka planda duyulsun</span>
                    </div>
                  </div>
                </section>
              </>
            )}
            {activeTab === "speakers" && !showVoiceFiles && (
              <>
                <div class="page-heading">
                  <span class="eyebrow">DİNLEME KARAKTERİ</span>
                  <h1>Bir ses seç.</h1>
                  <p>Her konuşmacı için farklı bir ton.</p>
                </div>
                {(["speaker-a", "speaker-b"] as const).map((id, i) => {
                  const speaker = settings.speakers[id];
                  const provider = migrateStoredProvider(
                    id,
                    speaker?.providerId || (i === 0 ? "antalia" : "ema-lightning"),
                  );
                  return (
                    <section class="voice-card" key={id}>
                      <div class="voice-header">
                        <span class={`voice-avatar voice-${i}`}>
                          {i === 0 ? "A" : "B"}
                        </span>
                        <div>
                          <h2>{i === 0 ? "Birincil ses" : "İkinci ses"}</h2>
                          <p>Konuşmacı {i === 0 ? "A" : "B"}</p>
                        </div>
                        <button
                          class="preview-button"
                          disabled={!state || testingVoice !== null || Boolean(state.settings.enabled && !state.playback?.paused)}
                          onClick={() => testSynthesis(provider)}
                          aria-label={`Konuşmacı ${i === 0 ? "A" : "B"} sesini dinle`}
                        >
                          {testingVoice === provider
                            ? "Hazırlanıyor…"
                            : "▷ Dinle"}
                        </button>
                      </div>
                      <label class="field-label" for={`voice-${id}`}>
                        Türkçe ses
                      </label>
                      <select
                        id={`voice-${id}`}
                        aria-label={`${i === 0 ? "Birincil" : "İkinci"} Türkçe ses`}
                        value={provider}
                        disabled={!state}
                        onChange={(e) =>
                          updateSpeaker(id, {
                            providerId: e.currentTarget.value,
                          })
                        }
                      >
                        <option value="antalia">
                          Antalia · Varsayılan · Doğal ve akıcı
                        </option>
                        <option value="ema-lightning">
                          EMA Lightning · Deneysel
                        </option>
                      </select>
                      <div class="volume-setting">
                        <label for={`speed-${id}`}>Konuşma hızı</label>
                        <output for={`speed-${id}`}>
                          {(speaker?.speed || 1).toFixed(2)}×
                        </output>
                        <input
                          id={`speed-${id}`}
                          style={{
                            "--range-progress": `${(((speaker?.speed || 1) - 0.75) / 0.75) * 100}%`,
                          }}
                          type="range"
                          min="0.75"
                          max="1.5"
                          step="0.05"
                          value={speaker?.speed || 1}
                          disabled={!state}
                          onInput={(e) => {
                            e.currentTarget.style.setProperty(
                              "--range-progress",
                              `${((parseFloat(e.currentTarget.value) - 0.75) / 0.75) * 100}%`,
                            );
                            updateSpeaker(id, {
                              speed: parseFloat(e.currentTarget.value),
                            });
                          }}
                        />
                        <div class="range-labels">
                          <span>Sakin</span>
                          <span>Hızlı</span>
                        </div>
                      </div>
                    </section>
                  );
                })}
                {testResult && (
                  <div class="voice-feedback" role="status">
                    {testResult}
                  </div>
                )}
                <button
                  class="file-management-link"
                  onClick={() => setShowVoiceFiles(true)}
                >
                  <span>
                    Ses dosyaları <small>Cihazında saklanır</small>
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              </>
            )}
            {activeTab === "speakers" && showVoiceFiles && (
              <section class="voice-files-screen">
                <button
                  class="back-link"
                  onClick={() => setShowVoiceFiles(false)}
                >
                  ← Seslere dön
                </button>
                <div class="page-heading">
                  <span class="eyebrow">YEREL DEPOLAMA</span>
                  <h1>Ses dosyaları.</h1>
                  <p>
                    İndirilen sesler cihazında saklanır ve tekrar kullanılır.
                  </p>
                </div>
                <div class="model-files">
                  {(["antalia", "ema-lightning"] as const).map((id) => {
                    const model = currentState.modelStatus[id];
                    return (
                      <article class="model-file" key={id}>
                        <span class="model-file-icon" aria-hidden="true">
                          {id === "antalia" ? "A" : "E"}
                        </span>
                        <div>
                          <h2>{id === "antalia" ? "Antalia" : "EMA Lightning (Deneysel)"}</h2>
                          <p>
                            {id === "antalia" ? "15 MB" : "37 MB · Paket içinde"} · Türkçe ses
                          </p>
                        </div>
                        <span
                          class={`model-file-status ${model.cached ? "ready" : ""}`}
                        >
                          {model.downloading
                            ? `İndiriliyor · ${Math.round(model.progress)}%`
                            : model.cached
                              ? "Hazır"
                              : "İndirilmedi"}
                        </span>
                      </article>
                    );
                  })}
                </div>
                <div class="storage-explanation">
                  <h2>İlk dinlemede hazırlanır.</h2>
                  <p>
                    Seçtiğin ses ilk kullanımda indirilir. Dosyaları temizlersen
                    sonraki dinlemede yeniden indirilir.
                  </p>
                </div>
                <button
                  class="delete-files-button"
                  onClick={purgeModels}
                  disabled={
                    !state ||
                    !Object.values(currentState.modelStatus).some(
                      (model) => model.cached,
                    )
                  }
                >
                  İndirilen sesleri temizle
                </button>
              </section>
            )}
            {activeTab === "transcript" && (
              <div class="transcript-screen">
                <div class="page-heading">
                  <span class="eyebrow">KELİME KELİME</span>
                  <h1>
                    {currentState.captionMode === "live"
                      ? "Canlı metin."
                      : "Hikâyenin metni."}
                  </h1>
                  <p>
                    {currentState.cues.length
                      ? `${currentState.cues.length} cümle · Sesleri A / B ile ata.`
                      : "Seslendirilen cümleler burada birikir."}
                  </p>
                </div>
                {!currentState.cues.length ? (
                  <div class="empty-transcript">
                    <span aria-hidden="true">“</span>
                    <h2>Henüz bir cümle yok.</h2>
                    <p>
                      Dublajı başlattığında metni buradan takip edebilirsin.
                    </p>
                    <button
                      class="secondary-button"
                      onClick={() => setActiveTab("control")}
                    >
                      Dinleme odasına dön
                    </button>
                  </div>
                ) : (
                  <div class="transcript-list">
                    {currentState.cues
                      .slice(
                        visibleTranscriptPage * 2,
                        visibleTranscriptPage * 2 + 2,
                      )
                      .map((cue: SubtitleCue, offset: number) => {
                        const idx = visibleTranscriptPage * 2 + offset;
                        return (
                          <article
                            key={cue.id}
                            class={`transcript-cue ${metrics.activeCueIndex === idx ? "current" : ""}`}
                          >
                            <div class="cue-meta">
                              <time>
                                {formatTime(cue.startTime)} —{" "}
                                {formatTime(cue.endTime)}
                              </time>
                              <div
                                class="speaker-assignment"
                                role="group"
                                aria-label={`${idx + 1}. cümle konuşmacısı`}
                              >
                                {["speaker-a", "speaker-b"].map((id, i) => (
                                  <button
                                    aria-pressed={cue.speakerId === id}
                                    onClick={() => setCueSpeaker(idx, id)}
                                  >
                                    {i === 0 ? "A" : "B"}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <p>{cue.turkishText}</p>
                            {cue.originalText !== cue.turkishText && (
                              <p class="original-text">{cue.originalText}</p>
                            )}
                          </article>
                        );
                      })}
                  </div>
                )}
                {currentState.cues.length > 0 && (
                  <div class="transcript-pagination">
                    <button
                      class="secondary-button"
                      disabled={visibleTranscriptPage === 0}
                      onClick={() =>
                        setTranscriptPage(visibleTranscriptPage - 1)
                      }
                    >
                      ← Önceki
                    </button>
                    <span>
                      {visibleTranscriptPage + 1} / {transcriptPageCount}
                    </span>
                    <button
                      class="secondary-button"
                      disabled={
                        visibleTranscriptPage === transcriptPageCount - 1
                      }
                      onClick={() =>
                        setTranscriptPage(visibleTranscriptPage + 1)
                      }
                    >
                      Sonraki →
                    </button>
                  </div>
                )}
              </div>
            )}
            {diagEnabled &&
              activeTab === "diagnostics" &&
              diagnosticPage === 0 && (
                <section class="settings-section">
                  <h2>Canlı ses ölçümleri</h2>
                  {errorMessage && (
                    <p class="diagnostic-error-detail">{errorMessage}</p>
                  )}
                  <div class="diagnostic-metrics">
                    <div>
                      <span>Senkron kayması</span>
                      <strong>
                        {metrics.syncDriftMs == null
                          ? "—"
                          : `${metrics.syncDriftMs} ms`}
                      </strong>
                    </div>
                    <div>
                      <span>Ses hazırlama</span>
                      <strong>
                        {metrics.synthesisLatencyMs == null
                          ? "—"
                          : `${metrics.synthesisLatencyMs} ms`}
                      </strong>
                    </div>
                    <div>
                      <span>Tampon</span>
                      <strong>{metrics.bufferedCuesCount} cümle</strong>
                    </div>
                    <div>
                      <span>Gerçek zaman oranı</span>
                      <strong>
                        {metrics.realtimeFactor == null
                          ? "—"
                          : `${metrics.realtimeFactor.toFixed(3)}×`}
                      </strong>
                    </div>
                  </div>
                </section>
              )}
            {/* Tab 4: Dogfood & Developer Diagnostics Panel */}
            {diagEnabled && activeTab === "diagnostics" && (
              <div
                class="diagnostic-pages space-y-3"
                data-page={diagnosticPage}
              >
                {/* Session Status Banner */}
                <div class="diagnostic-session bg-amber-950/40 border border-amber-800/60 rounded-xl p-3 space-y-2">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-bold text-amber-300">
                      Dogfood Canlı Oturum Kaydedici
                    </span>
                    <span
                      class={`text-[9px] px-2 py-0.5 rounded font-mono font-bold ${dogfoodStats?.isRecording ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" : "bg-slate-800 text-slate-400 border border-slate-700"}`}
                    >
                      {dogfoodStats?.isRecording ? "KAYIT AKTİF" : "DURDURULDU"}
                    </span>
                  </div>

                  <div class="text-[11px] font-mono text-slate-300 space-y-0.5">
                    <div>
                      Oturum ID:{" "}
                      <span class="text-amber-200">
                        {dogfoodStats?.sessionId || "Yok"}
                      </span>
                    </div>
                    <div>
                      Çalışma Modu:{" "}
                      <span class="text-slate-400">
                        {dogfoodStats?.environmentMode || dogfoodMode}
                      </span>
                    </div>
                  </div>

                  {/* Elapsed Monotonic Times */}
                  <div class="grid grid-cols-3 gap-1.5 pt-1 text-center text-[10px]">
                    <div class="bg-slate-900/80 p-1.5 rounded border border-slate-800">
                      <div class="text-slate-400">Gerçek Zaman</div>
                      <div class="font-bold text-amber-300 mt-0.5 font-mono">
                        {formatSecondsToTime(
                          dogfoodStats?.wallClockDurationSec || 0,
                        )}
                      </div>
                    </div>
                    <div class="bg-slate-900/80 p-1.5 rounded border border-slate-800">
                      <div class="text-slate-400">Oynatma</div>
                      <div class="font-bold text-emerald-400 mt-0.5 font-mono">
                        {formatSecondsToTime(
                          dogfoodStats?.videoPlaybackDurationSec || 0,
                        )}
                      </div>
                    </div>
                    <div class="bg-slate-900/80 p-1.5 rounded border border-slate-800">
                      <div class="text-slate-400">Duraklatıldı</div>
                      <div class="font-bold text-slate-300 mt-0.5 font-mono">
                        {formatSecondsToTime(
                          dogfoodStats?.pausedDurationSec || 0,
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Processed & Quality Cues Grid */}
                <div class="diagnostic-quality bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div class="text-xs font-semibold text-slate-300">
                    Cümle Çıktıları & Başarı Oranı
                  </div>
                  <div class="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                    <div class="bg-slate-800/40 p-2 rounded border border-slate-700/40">
                      <div class="text-slate-400">İşlenen Cümle</div>
                      <div class="text-xs font-bold text-slate-200 mt-0.5">
                        {dogfoodStats?.counts?.processed || 0}
                      </div>
                    </div>
                    <div class="bg-slate-800/40 p-2 rounded border border-slate-700/40">
                      <div class="text-slate-400">Başarılı Dublaj</div>
                      <div class="text-xs font-bold text-emerald-400 mt-0.5">
                        {dogfoodStats?.counts?.successfullyDubbed || 0}
                      </div>
                    </div>
                    <div class="bg-slate-800/40 p-2 rounded border border-slate-700/40">
                      <div class="text-slate-400">Başarısız / Düşen</div>
                      <div
                        class={`text-xs font-bold mt-0.5 ${(dogfoodStats?.counts?.failed || 0) > 0 ? "text-red-400" : "text-slate-400"}`}
                      >
                        {dogfoodStats?.counts?.failed || 0}
                      </div>
                    </div>
                  </div>

                  <div class="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                    <div class="bg-slate-800/40 p-1.5 rounded border border-slate-700/40">
                      <div class="text-slate-400">Çeviri Hatası</div>
                      <div class="font-bold text-slate-300 mt-0.5">
                        {dogfoodStats?.counts?.untranslated || 0}
                      </div>
                    </div>
                    <div class="bg-slate-800/40 p-1.5 rounded border border-slate-700/40">
                      <div class="text-slate-400">Underrun</div>
                      <div class="font-bold text-slate-300 mt-0.5">
                        {dogfoodStats?.counts?.underruns || 0}
                      </div>
                    </div>
                    <div class="bg-slate-800/40 p-1.5 rounded border border-slate-700/40">
                      <div class="text-slate-400">Senkron Kompromisi</div>
                      <div class="font-bold text-slate-300 mt-0.5">
                        {dogfoodStats?.counts?.syncCompromises || 0}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Drift & Memory Diagnostics */}
                <div class="diagnostic-drift bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div class="text-xs font-semibold text-slate-300">
                    Senkron Kayması & Bellek Teşhisi
                  </div>
                  <div class="grid grid-cols-2 gap-2 text-[11px]">
                    <div class="space-y-1">
                      <div class="flex justify-between text-slate-400">
                        <span>p50 Kayma:</span>
                        <span class="font-bold text-slate-200">
                          {dogfoodStats?.performance?.p50StartDriftMs || 0} ms
                        </span>
                      </div>
                      <div class="flex justify-between text-slate-400">
                        <span>p95 Kayma:</span>
                        <span class="font-bold text-indigo-300">
                          {dogfoodStats?.counts?.successfullyDubbed
                            ? `${dogfoodStats.performance.p95StartDriftMs} ms`
                            : "—"}
                        </span>
                      </div>
                      <div class="flex justify-between text-slate-400">
                        <span>p95 Taşma:</span>
                        <span class="font-bold text-amber-300">
                          {dogfoodStats?.counts?.successfullyDubbed
                            ? `${dogfoodStats.performance.p95OverflowMs} ms`
                            : "—"}
                        </span>
                      </div>
                    </div>
                    <div class="space-y-1">
                      <div class="flex justify-between text-slate-400">
                        <span>Aktif Sağlayıcı:</span>
                        <span class="font-bold text-slate-200">
                          {metrics.activeProviderId}
                        </span>
                      </div>
                      <div class="flex justify-between text-slate-400">
                        <span>Ses Tamponu:</span>
                        <span class="font-bold text-slate-200">
                          {metrics.bufferedCuesCount} parça
                        </span>
                      </div>
                      <div class="flex justify-between text-slate-400">
                        <span>Son Hata:</span>
                        <span
                          class="truncate max-w-[90px] text-red-400"
                          title={dogfoodStats?.lastRecoverableError || "Yok"}
                        >
                          {dogfoodStats?.lastRecoverableError || "Yok"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action Notification */}
                {diagActionMessage && (
                  <div class="text-xs p-2 bg-amber-950/60 border border-amber-700/50 rounded-lg text-amber-300 text-center animate-fade-in">
                    {diagActionMessage}
                  </div>
                )}

                {/* Dogfood Controls */}
                <div class="diagnostic-actions space-y-2 pt-1">
                  <div class="flex space-x-2">
                    <select
                      value={dogfoodMode}
                      onChange={(e) =>
                        setDogfoodMode(
                          (e.target as HTMLSelectElement).value as any,
                        )
                      }
                      class="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg p-2 focus:outline-none flex-1"
                    >
                      <option value="real_live_youtube">
                        Canlı YouTube Oynatımı
                      </option>
                      <option value="controlled_browser_fixture">
                        Kontrollü Tarayıcı Fikstürü
                      </option>
                      <option value="accelerated_simulation">
                        Hızlandırılmış Simülasyon
                      </option>
                    </select>

                    {!dogfoodStats?.isRecording ? (
                      <button
                        onClick={startDogfoodSession}
                        class="bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs px-3 py-2 rounded-lg transition"
                      >
                        Oturumu Başlat
                      </button>
                    ) : (
                      <button
                        onClick={stopDogfoodSession}
                        class="bg-red-600 hover:bg-red-500 text-white font-bold text-xs px-3 py-2 rounded-lg transition"
                      >
                        Durdur
                      </button>
                    )}
                  </div>

                  <button
                    onClick={exportRecoveryTrace}
                    class="w-full text-xs bg-slate-800 text-slate-200 py-2 rounded-lg"
                  >
                    Kurtarma izini indir (altyazı metni içerir; yerel)
                  </button>
                  <div class="grid grid-cols-2 gap-2">
                    <button
                      onClick={exportDogfoodReport}
                      class="w-full text-xs bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-200 py-2 rounded-lg transition font-medium"
                    >
                      Anonim Raporu İndir
                    </button>
                    <button
                      onClick={clearDogfoodData}
                      class="w-full text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 py-2 rounded-lg transition"
                    >
                      Verileri Temizle
                    </button>
                  </div>
                </div>
              </div>
            )}

            {diagEnabled &&
              activeTab === "diagnostics" &&
              diagnosticPage === 5 && (
                <PauseIsolationPanel sendMessage={sendMessage} />
              )}
            {diagEnabled && activeTab === "diagnostics" && (
              <div class="diagnostic-pagination">
                <span>
                  {
                    [
                      "Ses ölçümleri",
                      "Oturum",
                      "Cümle kalitesi",
                      "Senkron",
                      "Oturum işlemleri",
                      "İzolasyon",
                    ][diagnosticPage]
                  }
                </span>
                <div>
                  <button
                    class="secondary-button"
                    disabled={diagnosticPage === 0}
                    onClick={() => setDiagnosticPage(diagnosticPage - 1)}
                    aria-label="Önceki teşhis sayfası"
                  >
                    ←
                  </button>
                  <span>{diagnosticPage + 1} / 6</span>
                  <button
                    class="secondary-button"
                    disabled={diagnosticPage === 5}
                    onClick={() => setDiagnosticPage(diagnosticPage + 1)}
                    aria-label="Sonraki teşhis sayfası"
                  >
                    →
                  </button>
                </div>
              </div>
            )}
          </main>
          {playbackNotice && !noticeDismissed ? (
            <footer
              class={`app-footer notice-footer notice-${playbackNotice.severity}`}
              role={playbackNotice.severity === "error" ? "alert" : "status"}
            >
              <span class="notice-icon" aria-hidden="true">
                !
              </span>
              <div class="notice-copy">
                <strong>{playbackNotice.title}</strong>
                <p>{playbackNotice.description}</p>
              </div>
              <button
                class="notice-dismiss"
                aria-label="Bildirimi kapat"
                onClick={() => setNoticeDismissed(true)}
              >
                ×
              </button>
            </footer>
          ) : (
            <footer class="app-footer">
              <span>TÜRKÇE DİNLE. DÜNYAYI KEŞFET.</span>
              <span>vesta dub</span>
            </footer>
          )}
        </>
      )}
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function formatSecondsToTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}
