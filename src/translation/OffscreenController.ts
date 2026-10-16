import { isLocalTranslationError, isTranslationCancelled, type LocalTranslationReason } from './LocalTranslationError';
import type { LocalTranslationStatus } from './LocalTranslationEngine';

export const OFFSCREEN_DOCUMENT = 'offscreen.html';
export const OFFSCREEN_PREPARE = 'OFFSCREEN_PREPARE';
export const OFFSCREEN_TRANSLATE = 'OFFSCREEN_TRANSLATE';
export const OFFSCREEN_CANCEL = 'OFFSCREEN_CANCEL';
export const OFFSCREEN_STATUS = 'OFFSCREEN_STATUS';
export const OFFSCREEN_STATUS_PUSH = 'OFFSCREEN_STATUS_PUSH';

export interface OffscreenTranslationHost {
  noteCached(): Promise<void>;
  prepare(): Promise<void>;
  translate(text: string): Promise<string>;
  cancel(): void;
  snapshot(): LocalTranslationStatus;
}

export interface OffscreenResponse {
  started?: boolean;
  status?: LocalTranslationStatus;
  cancelled?: boolean;
  success?: boolean;
  translatedText?: string;
  code?: 'cancelled' | 'local_unavailable';
  reason?: LocalTranslationReason;
  error?: string;
}

/**
 * Handles local-translation messages inside the offscreen document.
 * The service worker cannot construct a Worker, so the Bergamot worker lives here.
 */
export function handleOffscreenRequest(
  message: { type?: unknown; text?: unknown } | null | undefined,
  host: OffscreenTranslationHost,
  sendResponse: (response: OffscreenResponse) => void,
): boolean {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === OFFSCREEN_STATUS) {
    void host.noteCached()
      .then(() => sendResponse({ status: host.snapshot() }))
      .catch(() => sendResponse({ status: host.snapshot() }));
    return true;
  }

  if (message.type === OFFSCREEN_PREPARE) {
    void host.prepare()
      .then(() => sendResponse({ started: true, status: host.snapshot() }))
      .catch(() => sendResponse({ started: false, status: host.snapshot() }));
    return true;
  }

  if (message.type === OFFSCREEN_CANCEL) {
    host.cancel();
    sendResponse({ cancelled: true });
    return true;
  }

  if (message.type !== OFFSCREEN_TRANSLATE || typeof message.text !== 'string') return false;
  void host.translate(message.text)
    .then(translatedText => sendResponse({ success: true, translatedText }))
    .catch(error => {
      if (isTranslationCancelled(error)) {
        sendResponse({ success: false, code: 'cancelled', error: 'Local translation cancelled' });
        return;
      }
      const reason: LocalTranslationReason = isLocalTranslationError(error) ? error.reason : 'runtime';
      sendResponse({
        success: false,
        code: 'local_unavailable',
        reason,
        error: 'Local translation unavailable',
      });
    });
  return true;
}

export function listenForOffscreenTranslation(host: OffscreenTranslationHost): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    return handleOffscreenRequest(message, host, sendResponse);
  });
}
