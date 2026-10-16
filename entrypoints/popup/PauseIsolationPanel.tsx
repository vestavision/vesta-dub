import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_PAUSE_ISOLATION_FLAGS, PAUSE_ISOLATION_FLAG_KEYS, PauseIsolationFlags } from '@/src/diagnostics/PauseIsolation';

const LABELS: Record<keyof PauseIsolationFlags, string> = {
  xhrObservation: 'XHR gözlemi',
  fetchObservation: 'Fetch gözlemi',
  playerApiBridge: 'Oynatıcı API köprüsü',
  captionActivation: 'Altyazı etkinleştirme',
  domCaptionObserver: 'DOM altyazı gözlemcisi',
  mediaLifecycleListener: 'Medya olay dinleyicisi',
  translationPipeline: 'Çeviri hattı',
  ttsScheduler: 'TTS zamanlayıcı',
  audioDucking: 'Ses kısma',
  diagnostics: 'Teşhis izi',
};

async function reloadYouTubeTab(): Promise<boolean> {
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const youtube = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  const tab = active[0]?.url?.includes('youtube.com') ? active[0] : youtube[0];
  if (tab?.id == null) return false;
  await chrome.tabs.reload(tab.id);
  return true;
}

export function PauseIsolationPanel({ sendMessage }: { sendMessage: (message: unknown) => Promise<any> }) {
  const [flags, setFlags] = useState<PauseIsolationFlags>({ ...DEFAULT_PAUSE_ISOLATION_FLAGS });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sendMessage({ type: 'GET_PAUSE_ISOLATION' }).then(response => {
      if (response?.flags) setFlags(response.flags);
    });
  }, []);

  const setFlag = (key: keyof PauseIsolationFlags, value: boolean) => {
    setFlags(current => ({ ...current, [key]: value }));
  };

  const apply = async (next: PauseIsolationFlags, reset = false) => {
    setBusy(true);
    try {
      const response = await sendMessage(reset
        ? { type: 'SET_PAUSE_ISOLATION', reset: true, clearTrace: true }
        : { type: 'SET_PAUSE_ISOLATION', flags: next });
      if (!response?.flags) {
        setNote('YouTube izleme sekmesi bulunamadı. Sayfayı açıp yeniden deneyin.');
        return;
      }
      setFlags(response.flags);
      const reloaded = await reloadYouTubeTab();
      setNote(reloaded
        ? 'Sekme yenilendi. Dublaj anahtarı kapandı; senaryo istiyorsa yeniden açın. Her denemede tek bir anahtarı değiştirin.'
        : 'Anahtarlar yazıldı. YouTube sekmesini elle yenileyin.');
    } finally {
      setBusy(false);
    }
  };

  const copyTrace = async () => {
    const response = await sendMessage({ type: 'GET_PAUSE_ISOLATION' });
    const events = Array.isArray(response?.trace) ? response.trace : [];
    const payload = JSON.stringify({ schema: 'vesta.pauseIsolation.trace.v1', events }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setNote(`${events.length} olay kopyalandı. İmzalı adres, çerez ve altyazı metni yoktur.`);
    } catch {
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'vesta-pause-trace.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNote(`${events.length} olay indirildi.`);
    }
  };

  return (
    <details class="bg-slate-900/60 border border-slate-800 rounded-xl p-3 text-xs">
      <summary class="cursor-pointer font-semibold text-slate-200">Arka plan duraklatma izolasyonu</summary>
      <p class="mt-2 text-[10px] leading-4 text-slate-400">
        Varsayılan: tüm özellikler açık, iz kapalı. İz pause() çağrısını engellemez. Anahtarı değiştirince sekme yenilenir.
        Yenilemeden sonra dublajı senaryonun istediği duruma getirin.
      </p>
      <div class="mt-2 space-y-1">
        {PAUSE_ISOLATION_FLAG_KEYS.map(key => (
          <label key={key} class="flex items-center justify-between gap-2 text-[11px] text-slate-300">
            <span>{LABELS[key]} <span class="text-slate-500">({key})</span></span>
            <input
              type="checkbox"
              checked={flags[key]}
              onChange={event => setFlag(key, (event.target as HTMLInputElement).checked)}
              class={`w-3.5 h-3.5 rounded cursor-pointer ${key === 'diagnostics' ? 'accent-amber-500' : 'accent-indigo-500'}`}
            />
          </label>
        ))}
      </div>
      {note && <p class="mt-2 text-[10px] text-amber-200">{note}</p>}
      <div class="mt-2 grid grid-cols-3 gap-1.5">
        <button type="button" disabled={busy} onClick={() => apply(flags)} class="bg-indigo-600 disabled:opacity-50 text-white rounded-md py-1.5">Uygula</button>
        <button type="button" disabled={busy} onClick={copyTrace} class="bg-slate-800 text-slate-200 rounded-md py-1.5">İzi kopyala</button>
        <button type="button" disabled={busy} onClick={() => apply(DEFAULT_PAUSE_ISOLATION_FLAGS, true)} class="bg-slate-800 text-slate-200 rounded-md py-1.5">Sıfırla</button>
      </div>
    </details>
  );
}
