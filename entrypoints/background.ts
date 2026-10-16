import { requestCloudTranslation, validateTranslateRequest } from '../src/translation/CloudTranslationClient';
import type { LocalTranslationReason } from '../src/translation/LocalTranslationError';
import { LOCAL_TRANSLATION_STATUS_KEY } from '../src/translation/LocalTranslationEngine';
import {
  OFFSCREEN_CANCEL,
  OFFSCREEN_DOCUMENT,
  OFFSCREEN_PREPARE,
  OFFSCREEN_STATUS,
  OFFSCREEN_STATUS_PUSH,
  OFFSCREEN_TRANSLATE,
  type OffscreenResponse,
} from '../src/translation/OffscreenController';
import { normalizeTranslationKey, TRANSLATION_KEY_STORAGE } from '../src/translation/TranslationKey';
import { normalizeTranslationMode, TRANSLATION_MODE_STORAGE, translationRoute, type TranslationMode } from '../src/translation/TranslationMode';

function restrictTranslationKeyStorage(): void {
  void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}

async function readTranslationKey(): Promise<string | null> {
  const stored = await chrome.storage.session.get(TRANSLATION_KEY_STORAGE);
  return normalizeTranslationKey(stored[TRANSLATION_KEY_STORAGE]);
}

async function readTranslationMode(): Promise<TranslationMode> {
  const stored = await chrome.storage.local.get(TRANSLATION_MODE_STORAGE);
  return normalizeTranslationMode(stored[TRANSLATION_MODE_STORAGE]);
}

interface OffscreenChrome {
  runtime: {
    getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>;
  };
  offscreen: {
    createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  };
}

/**
 * The installed Chrome type package does not list the offscreen document API.
 * Brave 155 exposes it. The cast stays at this call site.
 */
function offscreenChrome(): OffscreenChrome {
  return chrome as unknown as OffscreenChrome;
}

let offscreenOpen: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
  if (!offscreenOpen) {
    offscreenOpen = (async () => {
      const api = offscreenChrome();
      const existing = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (existing.length > 0) return;
      try {
        await api.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT,
          reasons: ['WORKERS'],
          justification: 'Local English-to-Turkish translation runs in a worker. The service worker cannot start that worker.',
        });
      } catch (error) {
        const retry = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (retry.length === 0) throw error;
      }
    })().finally(() => {
      offscreenOpen = null;
    });
  }
  return offscreenOpen;
}

async function askOffscreen(message: { type: string; text?: string }): Promise<OffscreenResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await ensureOffscreen();
    try {
      const response = await chrome.runtime.sendMessage(message) as OffscreenResponse | undefined;
      if (response) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw lastError instanceof Error ? lastError : new Error('offscreen translator did not answer');
}

function localFailure(reason: LocalTranslationReason = 'runtime') {
  return {
    success: false as const,
    error: 'Local translation unavailable',
    status: null,
    retryAfterMs: null,
    code: 'local_unavailable' as const,
    reason,
  };
}

export default defineBackground(() => {
  restrictTranslationKeyStorage();

  chrome.runtime.onInstalled.addListener(() => {
    restrictTranslationKeyStorage();
    console.log('[VestaDub] Extension installed.');
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === OFFSCREEN_STATUS_PUSH) {
      if (message.status && typeof message.status === 'object') {
        void chrome.storage.local.set({ [LOCAL_TRANSLATION_STATUS_KEY]: message.status }).catch(() => {});
      }
      return false;
    }
    if (typeof message?.type === 'string' && message.type.startsWith('OFFSCREEN_')) return false;

    if (message?.type === 'SET_TRANSLATION_MODE') {
      const mode = normalizeTranslationMode(message.mode);
      void chrome.storage.local.set({ [TRANSLATION_MODE_STORAGE]: mode })
        .then(() => sendResponse({ mode }))
        .catch(() => sendResponse({ mode: 'local' }));
      return true;
    }

    if (message?.type === 'PREPARE_LOCAL_TRANSLATION') {
      void askOffscreen({ type: OFFSCREEN_PREPARE })
        .then(response => sendResponse({ started: response.started === true, status: response.status ?? null }))
        .catch(() => sendResponse({ started: false, status: null }));
      return true;
    }

    if (message?.type === 'CANCEL_LOCAL_TRANSLATION') {
      void askOffscreen({ type: OFFSCREEN_CANCEL })
        .then(() => sendResponse({ cancelled: true }))
        .catch(() => sendResponse({ cancelled: false }));
      return true;
    }

    if (message?.type === 'TRANSLATION_STATUS') {
      void askOffscreen({ type: OFFSCREEN_STATUS })
        .then(response => Promise.all([readTranslationMode(), readTranslationKey()]).then(([mode, key]) => {
          sendResponse({ mode, configured: Boolean(key), local: response.status ?? null });
        }))
        .catch(() => sendResponse({ mode: 'local', configured: false, local: null }));
      return true;
    }

    if (message?.type !== 'TRANSLATE_TEXT') return false;

    const accepted = validateTranslateRequest(message, sender.id, chrome.runtime.id);
    if (!accepted.ok) {
      sendResponse({ success: false, error: accepted.error, status: null, retryAfterMs: null });
      return true;
    }
    if (!accepted.text) {
      sendResponse({ success: true, translatedText: '' });
      return true;
    }

    void readTranslationMode()
      .then(async mode => {
        const route = translationRoute(mode, await readTranslationKey());
        if (route === 'cloud_setup') {
          sendResponse({
            success: false,
            error: 'Translation setup required',
            status: null,
            retryAfterMs: null,
            code: 'setup_required',
          });
          return;
        }
        if (route === 'local') {
          try {
            const response = await askOffscreen({ type: OFFSCREEN_TRANSLATE, text: accepted.text });
            if (response.success && typeof response.translatedText === 'string') {
              sendResponse({ success: true, translatedText: response.translatedText, mode: 'local' });
              return;
            }
            if (response.code === 'cancelled') {
              sendResponse({ success: false, error: 'Local translation cancelled', code: 'cancelled' });
              return;
            }
            sendResponse(localFailure(response.reason));
          } catch {
            sendResponse(localFailure('runtime'));
          }
          return;
        }
        const key = await readTranslationKey();
        if (!key) {
          sendResponse({
            success: false,
            error: 'Translation setup required',
            status: null,
            retryAfterMs: null,
            code: 'setup_required',
          });
          return;
        }
        const outcome = await requestCloudTranslation(accepted.text, key);
        if (outcome.ok) {
          sendResponse({ success: true, translatedText: outcome.translatedText, mode: 'cloud' });
          return;
        }
        sendResponse({
          success: false,
          error: outcome.error,
          status: outcome.status,
          retryAfterMs: outcome.retryAfterMs,
          code: outcome.code ?? null,
        });
      })
      .catch(() => {
        sendResponse({
          success: false,
          error: 'Translation request failed',
          status: null,
          retryAfterMs: null,
          code: 'unavailable',
        });
      });
    return true;
  });
});
