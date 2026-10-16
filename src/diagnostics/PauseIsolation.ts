/**
 * Reversible pause-isolation switches and a local diagnostic trace.
 *
 * A missing storage key keeps every production feature on and the trace off.
 * The MAIN-world script reads this synchronously at document_start, before it
 * patches XMLHttpRequest or fetch. Changing a prototype hook requires a reload.
 * The trace never stores caption text, cookies, or signed timedtext URLs.
 */

export const PAUSE_ISOLATION_KEY = 'vesta.pauseIsolation.v1';
export const PAUSE_TRACE_KEY = 'vesta.pauseIsolation.trace.v1';
export const PAUSE_CORRELATION_KEY = 'vesta.pauseIsolation.correlation.v1';
export const PAUSE_TRACE_LIMIT = 200;

export const PAUSE_ISOLATION_FLAG_KEYS = [
  'xhrObservation',
  'fetchObservation',
  'playerApiBridge',
  'captionActivation',
  'domCaptionObserver',
  'mediaLifecycleListener',
  'translationPipeline',
  'ttsScheduler',
  'audioDucking',
  'diagnostics',
] as const;

export type PauseIsolationFlag = (typeof PAUSE_ISOLATION_FLAG_KEYS)[number];

export type PauseIsolationFlags = Record<PauseIsolationFlag, boolean>;

export const DEFAULT_PAUSE_ISOLATION_FLAGS: PauseIsolationFlags = {
  xhrObservation: true,
  fetchObservation: true,
  playerApiBridge: true,
  captionActivation: true,
  domCaptionObserver: true,
  mediaLifecycleListener: true,
  translationPipeline: true,
  ttsScheduler: true,
  audioDucking: true,
  diagnostics: false,
};

export interface MainWorldHooks {
  patchXhr: boolean;
  patchFetch: boolean;
  listenForTrackMetadata: boolean;
  activatePlayerCaptions: boolean;
  installProbe: boolean;
}

export interface PauseTraceEvent {
  seq: number;
  correlationId: string;
  monoMs: number;
  kind: string;
  videoId: string | null;
  visibility: string | null;
  currentTime: number | null;
  paused: boolean | null;
  detail: Record<string, unknown>;
}

const SAFE_QUERY_KEYS = ['v', 'lang', 'fmt', 'kind', 'tlang'] as const;
const SECRET_KEY = /cookie|authorization|sapisid|login_info|bearer|password|token|signature|sig|expire|ei|pot/i;
const MEDIA_KEYS = new Set([' ', 'k', 'K', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'AudioVolumeMute', 'AudioVolumeUp', 'AudioVolumeDown']);
const PROBE_MARKER = Symbol.for('vesta.pauseIsolation.probe');

export function mainWorldHooks(flags: PauseIsolationFlags = readPauseIsolationFlags()): MainWorldHooks {
  return {
    patchXhr: flags.xhrObservation,
    patchFetch: flags.fetchObservation,
    listenForTrackMetadata: flags.playerApiBridge,
    activatePlayerCaptions: flags.captionActivation,
    installProbe: flags.diagnostics,
  };
}

export function readPauseIsolationFlags(storage?: Storage | null): PauseIsolationFlags {
  const store = storage === undefined ? resolveStorage() : storage;
  const flags = { ...DEFAULT_PAUSE_ISOLATION_FLAGS };
  if (!store) return flags;
  try {
    const raw = store.getItem(PAUSE_ISOLATION_KEY);
    if (!raw) return flags;
    const parsed = JSON.parse(raw) as Partial<Record<PauseIsolationFlag, unknown>>;
    for (const key of PAUSE_ISOLATION_FLAG_KEYS) {
      if (typeof parsed?.[key] === 'boolean') flags[key] = parsed[key];
    }
    return flags;
  } catch {
    return { ...DEFAULT_PAUSE_ISOLATION_FLAGS };
  }
}

export function isPauseFeatureEnabled(name: PauseIsolationFlag, storage?: Storage | null): boolean {
  return readPauseIsolationFlags(storage)[name];
}

export function writePauseIsolationFlags(partial: Partial<PauseIsolationFlags>, storage?: Storage | null): PauseIsolationFlags {
  const store = storage === undefined ? resolveStorage() : storage;
  const next = readPauseIsolationFlags(store);
  for (const key of PAUSE_ISOLATION_FLAG_KEYS) {
    if (typeof partial[key] === 'boolean') next[key] = partial[key];
  }
  try {
    if (!store) return next;
    if (PAUSE_ISOLATION_FLAG_KEYS.every(key => next[key] === DEFAULT_PAUSE_ISOLATION_FLAGS[key])) store.removeItem(PAUSE_ISOLATION_KEY);
    else store.setItem(PAUSE_ISOLATION_KEY, JSON.stringify(next));
  } catch { /* private mode or quota */ }
  return next;
}

export function resetPauseIsolationFlags(storage?: Storage | null): PauseIsolationFlags {
  const store = storage === undefined ? resolveStorage() : storage;
  try { store?.removeItem(PAUSE_ISOLATION_KEY); } catch { /* ignore */ }
  return { ...DEFAULT_PAUSE_ISOLATION_FLAGS };
}

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input, 'https://www.youtube.com');
    const safe = new URLSearchParams();
    for (const key of SAFE_QUERY_KEYS) {
      const value = url.searchParams.get(key);
      if (!value || value.length > 32 || SECRET_KEY.test(value)) continue;
      if (key === 'v' && !/^[a-zA-Z0-9_-]{6,16}$/.test(value)) continue;
      safe.set(key, value);
    }
    const query = safe.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return 'invalid-url';
  }
}

export function sanitizeStack(stack: string | undefined): string {
  if (!stack) return '';
  return stack
    .split('\n')
    .slice(0, 8)
    .map(line => line
      .replace(/https?:\/\/[^\s)]+/g, url => sanitizeUrl(url))
      .replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://extension')
      .replace(/[?&](?:sig|signature|expire|ei|ip|pot|key|token|auth|cookie)=[^&\s)]+/gi, ''))
    .filter(line => !/cookie\s*:|authorization\s*:|sapisid|login_info/i.test(line))
    .join('\n')
    .slice(0, 800);
}

export function readPauseTrace(storage?: Storage | null): PauseTraceEvent[] {
  const store = storage === undefined ? resolveStorage() : storage;
  if (!store) return [];
  try {
    const raw = store.getItem(PAUSE_TRACE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PauseTraceEvent[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-PAUSE_TRACE_LIMIT).map(sanitizeEvent);
  } catch {
    return [];
  }
}

export function clearPauseTrace(storage?: Storage | null): void {
  const store = storage === undefined ? resolveStorage() : storage;
  try { store?.removeItem(PAUSE_TRACE_KEY); } catch { /* ignore */ }
  try { resolveSession()?.removeItem(PAUSE_CORRELATION_KEY); } catch { /* ignore */ }
}

export function noteExtensionEvent(kind: string, detail: Record<string, unknown> = {}, storage?: Storage | null): void {
  try {
    if (!isPauseFeatureEnabled('diagnostics', storage)) return;
    appendPauseTrace({
      correlationId: currentCorrelation(),
      monoMs: monoNow(),
      kind,
      videoId: videoIdFromHref(readHref()),
      visibility: readVisibility(),
      currentTime: null,
      paused: null,
      detail,
    }, storage);
  } catch { /* diagnostics must not affect playback */ }
}

export function appendPauseTrace(event: Omit<PauseTraceEvent, 'seq'>, storage?: Storage | null): void {
  const store = storage === undefined ? resolveStorage() : storage;
  if (!store) return;
  try {
    const events = readPauseTrace(store);
    const seq = (events[events.length - 1]?.seq ?? 0) + 1;
    const next = [...events, sanitizeEvent({ ...event, seq })].slice(-PAUSE_TRACE_LIMIT);
    try {
      store.setItem(PAUSE_TRACE_KEY, JSON.stringify(next));
    } catch {
      store.setItem(PAUSE_TRACE_KEY, JSON.stringify(next.slice(-50)));
    }
  } catch { /* keep playback independent of the trace */ }
}

interface MediaSnapshotTarget {
  paused?: boolean;
  currentTime?: number;
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
}

export interface PauseProbeHost {
  HTMLMediaElement?: { prototype: { pause: (...args: unknown[]) => unknown; play: (...args: unknown[]) => unknown } };
  document?: {
    visibilityState?: string;
    addEventListener?: (type: string, listener: (event: Event) => void, capture?: boolean) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void, capture?: boolean) => void;
    querySelector?: (selector: string) => MediaSnapshotTarget | null;
  };
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  performance?: { now: () => number };
  location?: { href?: string };
  localStorage?: Storage;
  sessionStorage?: Storage;
}

export function installMediaProbe(host: PauseProbeHost = globalThis as PauseProbeHost): () => void {
  const storage = host.localStorage ?? resolveStorage();
  const session = host.sessionStorage ?? resolveSession();
  const flags = readPauseIsolationFlags(storage);
  if (!flags.diagnostics) return () => {};
  const proto = host.HTMLMediaElement?.prototype;
  const listeners: Array<{ target: 'document' | 'window'; type: string; listener: (event: Event) => void; capture?: boolean }> = [];
  let restorePause: (() => void) | null = null;
  let restorePlay: (() => void) | null = null;

  const record = (kind: string, target?: unknown, detail: Record<string, unknown> = {}, correlate = false) => {
    const snap = snapshot(host, target);
    const correlationId = correlate ? beginCorrelation(kind, session, host) : currentCorrelation(session);
    appendPauseTrace({
      correlationId,
      monoMs: monoNow(host),
      kind,
      videoId: videoIdFromHref(host.location?.href || readHref()),
      visibility: host.document?.visibilityState ?? readVisibility(),
      currentTime: snap.currentTime,
      paused: snap.paused,
      detail: { ...detail, ...snap.extra },
    }, storage);
  };

  if (proto && typeof proto.pause === 'function' && typeof proto.play === 'function' && !(proto as { [PROBE_MARKER]?: boolean })[PROBE_MARKER]) {
    const originalPause = proto.pause;
    const originalPlay = proto.play;
    try {
      proto.pause = function pauseProbe(this: unknown, ...args: unknown[]) {
        try { record('media_pause_call', this, { stack: sanitizeStack(new Error().stack), isTrusted: null }); } catch { /* still call through */ }
        return originalPause.apply(this, args);
      };
      proto.play = function playProbe(this: unknown, ...args: unknown[]) {
        try { record('media_play_call', this, { stack: sanitizeStack(new Error().stack), isTrusted: null }); } catch { /* still call through */ }
        return originalPlay.apply(this, args);
      };
      (proto as { [PROBE_MARKER]?: boolean })[PROBE_MARKER] = true;
      restorePause = () => { proto.pause = originalPause; };
      restorePlay = () => { proto.play = originalPlay; };
    } catch { /* a non-writable prototype is itself evidence; do not throw into the page */ }
  }

  const add = (target: 'document' | 'window', type: string, listener: (event: Event) => void, capture = false) => {
    const node = target === 'document' ? host.document : host;
    node?.addEventListener?.(type, listener, capture);
    listeners.push({ target, type, listener, capture });
  };

  add('document', 'visibilitychange', () => {
    const hidden = host.document?.visibilityState === 'hidden';
    record('visibility', undefined, { state: hidden ? 'hidden' : 'visible' }, true);
  });
  add('window', 'focus', () => record('window_focus', undefined, {}, true));
  add('window', 'blur', () => record('window_blur', undefined, {}, true));
  add('window', 'pagehide', () => record('pagehide', undefined, {}, true));
  add('document', 'freeze', () => record('freeze', undefined, {}, true));
  add('document', 'resume', () => record('resume', undefined, {}, true));
  for (const type of ['play', 'pause', 'seeking', 'seeked', 'volumechange', 'ratechange']) {
    add('document', type, event => {
      const names: Record<string, string> = { play: 'media_play_event', pause: 'media_pause_event' };
      record(names[type] || `media_${type}`, event.target, { isTrusted: event.isTrusted });
    }, true);
  }
  add('window', 'keydown', event => {
    const keyEvent = event as KeyboardEvent;
    const target = keyEvent.target as { tagName?: string; isContentEditable?: boolean } | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    if (!MEDIA_KEYS.has(keyEvent.key)) return;
    record('keydown', undefined, { key: keyEvent.key === ' ' ? 'Space' : keyEvent.key });
  });

  record('probe_installed', undefined, {
    flagsOff: PAUSE_ISOLATION_FLAG_KEYS.filter(key => !flags[key]),
  }, true);

  return () => {
    restorePause?.();
    restorePlay?.();
    if (proto) delete (proto as { [PROBE_MARKER]?: boolean })[PROBE_MARKER];
    for (const entry of listeners) {
      const node = entry.target === 'document' ? host.document : host;
      node?.removeEventListener?.(entry.type, entry.listener, entry.capture);
    }
  };
}

function snapshot(host: PauseProbeHost, target: unknown): { currentTime: number | null; paused: boolean | null; extra: Record<string, unknown> } {
  const fromTarget = target && typeof target === 'object' && 'currentTime' in target ? target as MediaSnapshotTarget : null;
  const media = fromTarget ?? host.document?.querySelector?.('video') ?? null;
  if (!media) return { currentTime: null, paused: null, extra: {} };
  const currentTime = typeof media.currentTime === 'number' && Number.isFinite(media.currentTime) ? Math.round(media.currentTime * 1000) / 1000 : null;
  const paused = typeof media.paused === 'boolean' ? media.paused : null;
  const extra: Record<string, unknown> = {};
  if (typeof media.volume === 'number' && Number.isFinite(media.volume)) extra.volume = Math.round(media.volume * 1000) / 1000;
  if (typeof media.muted === 'boolean') extra.muted = media.muted;
  if (typeof media.playbackRate === 'number' && Number.isFinite(media.playbackRate)) extra.playbackRate = media.playbackRate;
  return { currentTime, paused, extra };
}

function sanitizeEvent(event: PauseTraceEvent): PauseTraceEvent {
  return {
    seq: typeof event.seq === 'number' ? event.seq : 0,
    correlationId: typeof event.correlationId === 'string' ? event.correlationId.slice(0, 80) : 'boot',
    monoMs: typeof event.monoMs === 'number' ? event.monoMs : 0,
    kind: typeof event.kind === 'string' ? event.kind.slice(0, 40) : 'unknown',
    videoId: typeof event.videoId === 'string' && /^[a-zA-Z0-9_-]{6,16}$/.test(event.videoId) ? event.videoId : null,
    visibility: event.visibility === 'visible' || event.visibility === 'hidden' ? event.visibility : null,
    currentTime: typeof event.currentTime === 'number' && Number.isFinite(event.currentTime) ? event.currentTime : null,
    paused: typeof event.paused === 'boolean' ? event.paused : null,
    detail: sanitizeDetail(event.detail || {}),
  };
}

function sanitizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === 'string') {
      if (/cookie|authorization|sapisid|login_info|bearer /i.test(value)) continue;
      out[key] = key === 'stack' ? sanitizeStack(value) : value.includes('://') ? sanitizeUrl(value) : value.slice(0, 160);
    } else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean').slice(0, 12);
  }
  return out;
}

function beginCorrelation(reason: string, session: Storage | null, host?: PauseProbeHost): string {
  const id = `vis-${Math.round(monoNow(host))}-${reason}`.slice(0, 80);
  try { session?.setItem(PAUSE_CORRELATION_KEY, id); } catch { /* ignore */ }
  return id;
}

function currentCorrelation(session: Storage | null = resolveSession()): string {
  try {
    return session?.getItem(PAUSE_CORRELATION_KEY) || 'boot';
  } catch {
    return 'boot';
  }
}

function monoNow(host?: PauseProbeHost): number {
  const now = host?.performance?.now?.() ?? (typeof performance !== 'undefined' ? performance.now() : 0);
  return Math.round(now * 10) / 10;
}

function readHref(): string {
  try {
    return (globalThis as { location?: { href?: string } }).location?.href || '';
  } catch {
    return '';
  }
}

function readVisibility(): string | null {
  try {
    const state = (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState;
    return state === 'visible' || state === 'hidden' ? state : null;
  } catch {
    return null;
  }
}

function videoIdFromHref(href: string): string | null {
  try {
    const id = new URL(href).searchParams.get('v');
    return id && /^[a-zA-Z0-9_-]{6,16}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function resolveStorage(explicit?: Storage | null): Storage | null {
  if (explicit === null) return null;
  if (explicit) return explicit;
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (!candidate || typeof candidate.getItem !== 'function') return null;
    return candidate;
  } catch {
    return null;
  }
}

function resolveSession(): Storage | null {
  try {
    const candidate = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!candidate || typeof candidate.getItem !== 'function') return null;
    return candidate;
  } catch {
    return null;
  }
}
