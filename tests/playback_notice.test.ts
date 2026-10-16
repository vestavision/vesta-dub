import { describe, expect, it } from "vitest";
import {
  getPlaybackNotice,
  nextSchedulerErrorMessage,
} from "../src/ui/PlaybackNotice";

describe("playback notices", () => {
  it.each(["cue_expired", "audio_offset_expired"])(
    "keeps %s out of the user-facing error channel",
    (reason) => {
      expect(nextSchedulerErrorMessage(null, "buffering", reason)).toBeNull();
      expect(nextSchedulerErrorMessage(reason, "playing")).toBeNull();
      expect(getPlaybackNotice(reason)).toBeNull();
    },
  );
  it("clears recovered scheduler errors without losing translation warnings", () => {
    expect(
      nextSchedulerErrorMessage("tts: model failed", "playing"),
    ).toBeNull();
    const limit = "Translation rate limited (HTTP 429). wait";
    expect(nextSchedulerErrorMessage(limit, "buffering", "cue_expired")).toBe(
      limit,
    );
    expect(nextSchedulerErrorMessage(limit, "playing")).toBe(limit);
  });
  it("preserves genuine errors and translates technical messages into actionable copy", () => {
    expect(
      nextSchedulerErrorMessage(null, "error", "audio_context: suspended"),
    ).toBe("audio_context: suspended");
    expect(getPlaybackNotice("audio_context: suspended")).toMatchObject({
      severity: "error",
      title: "Ses oynatılamadı",
    });
    expect(getPlaybackNotice("captions: track unavailable")).toMatchObject({
      severity: "warning",
      title: "Altyazı bekleniyor",
    });
    expect(
      getPlaybackNotice("Translation rate limited (HTTP 429). wait"),
    ).toMatchObject({ severity: "warning" });
    expect(
      getPlaybackNotice("Translation setup required. Add a Cloud Translation API key."),
    ).toMatchObject({ severity: "warning", title: "Çeviri anahtarı gerekli" });
    expect(
      getPlaybackNotice("Local translation unavailable. The model could not be downloaded."),
    ).toMatchObject({ severity: "warning", title: "Yerel çeviri kullanılamadı" });
    expect(
      getPlaybackNotice("unrecognized internal detail")?.description,
    ).not.toContain("internal");
  });
});
