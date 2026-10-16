import type { ExtensionState } from "../core/types";

const routineReasons = new Set(["cue_expired", "audio_offset_expired"]);
const schedulerError = /^(audio_context|playback|tts):/;

/** Scheduler progress is not an error; preserve independently managed notices. */
export function nextSchedulerErrorMessage(
  current: string | null,
  status: ExtensionState["status"],
  reason?: string,
): string | null {
  if (status === "error" && reason && !routineReasons.has(reason))
    return reason;
  if (
    current &&
    (routineReasons.has(current) ||
      (status === "playing" && schedulerError.test(current)))
  )
    return null;
  return current;
}

export interface PlaybackNotice {
  severity: "warning" | "error";
  title: string;
  description: string;
}

export function getPlaybackNotice(
  message: string | null,
): PlaybackNotice | null {
  if (!message || routineReasons.has(message)) return null;
  if (message.startsWith("Translation rate limited (HTTP 429).")) {
    return {
      severity: "warning",
      title: "Çeviri kısa bir süre bekliyor",
      description: "Biraz sonra dublajı durdurup yeniden başlatabilirsin.",
    };
  }
  if (message.startsWith("Local translation unavailable.")) {
    return {
      severity: "warning",
      title: "Yerel çeviri kullanılamadı",
      description:
        "Model indirilemedi veya bu tarayıcıda çalışmıyor. İngilizce altyazı seslendirilmez.",
    };
  }
  if (message.startsWith("Translation setup required.")) {
    return {
      severity: "warning",
      title: "Çeviri anahtarı gerekli",
      description:
        "Cloud Translation anahtarını açılır pencereye ekle. İngilizce altyazı seslendirilmez.",
    };
  }
  if (message.startsWith("captions:")) {
    return {
      severity: "warning",
      title: "Altyazı bekleniyor",
      description: "YouTube’da altyazıları açarak devam et.",
    };
  }
  if (message.startsWith("translation:")) {
    return {
      severity: "error",
      title: "Çeviri hazırlanamadı",
      description: "Bağlantını kontrol edip dublajı yeniden başlat.",
    };
  }
  if (message.startsWith("audio_context:")) {
    return {
      severity: "error",
      title: "Ses oynatılamadı",
      description: "Video sayfasına tıkla, ardından dublajı yeniden başlat.",
    };
  }
  if (message.startsWith("tts:")) {
    return {
      severity: "error",
      title: "Ses hazırlanamadı",
      description: "Sesler sekmesinden başka bir ses seçip tekrar dene.",
    };
  }
  return {
    severity: "error",
    title: "Dublaj devam edemedi",
    description: "Dublajı durdurup yeniden başlatmayı dene.",
  };
}
