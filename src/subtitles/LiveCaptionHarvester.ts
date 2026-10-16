import { LiveSnapshot } from './LiveCaptionCommitter';
import { SubtitleCue } from '../core/types';
import { CaptionSource, CaptionSourceCapabilities, CaptionSourceContext, CaptionSourceHandlers } from './CaptionSource';
import { isPauseFeatureEnabled } from '../diagnostics/PauseIsolation';

export interface HarvesterOptions {
  onSnapshot?: (snapshot: LiveSnapshot) => void;
  onCuesChanged?: (cues: SubtitleCue[]) => void;
  onNewCue?: (cue: SubtitleCue) => void;
  onDiagnostic?: (cue: SubtitleCue, stage: string, detail?: Record<string, unknown>) => void;
  onError?: (reason: string) => void;
}

// The player's temporary settings notification has the same segment class as speech.
export function readSpeechCaption(root: ParentNode): { text: string; language: string | null; lines: string[] } | null {
  const windows = Array.from(root.querySelectorAll('.caption-window:not(#caption-window-_0)'));
  for (const window of windows) {
    if (window.hasAttribute('hidden') || window.getAttribute('aria-hidden') === 'true') continue;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(window);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (window.parentElement && getComputedStyle(window.parentElement).display === 'none') continue;
    }
    const lines = Array.from(window.querySelectorAll('.caption-visual-line')).map(line =>
      Array.from(line.querySelectorAll('.ytp-caption-segment')).map(s=>s.textContent || '').join(' ').replace(/\s+/g,' ').trim()
    ).filter(Boolean);
    if (!lines.length) continue;
    return { text:lines.join(' '), language:window.getAttribute('lang'), lines };
  }
  return null;
}

/** Live DOM acquisition only: no translation, model or future-cue assumptions. */
export class LiveCaptionHarvester implements CaptionSource {
  private observer: MutationObserver | null = null;
  private observedRoot: Element | null = null;
  private video: HTMLVideoElement | null = null;
  private cues: SubtitleCue[] = [];
  private active = false;
  private generation = 0;
  private videoId = '';
  private lastCapturedText = '';
  private cueIndex = 0;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastStatus = '';
  private handlers?: CaptionSourceHandlers;
  private capabilities: CaptionSourceCapabilities = {
    kind:'live_dom',futureCuesAvailable:false,expectedAcquisitionLatencyMs:250,
    language:null,confidence:null,availability:'idle',timestamps:'estimated',failureReason:null,
  };
  constructor(private options: HarvesterOptions = {}) {}
  getCapabilities(): CaptionSourceCapabilities { return {...this.capabilities}; }
  private publishStatus(): void { const signature=JSON.stringify(this.capabilities); if(signature!==this.lastStatus){this.lastStatus=signature;this.handlers?.onStatus?.(this.getCapabilities());} }
  attach(video: HTMLVideoElement): void { this.video = video; }
  start(context: CaptionSourceContext, handlers: CaptionSourceHandlers): void {
    if (!isPauseFeatureEnabled('domCaptionObserver')) return;
    this.stop(); this.handlers = handlers; this.videoId = context.videoId;
    this.lastCapturedText = ''; this.cues = []; this.cueIndex = 0;
    if (context.video) this.attach(context.video);
    this.startObserving();
  }
  startObserving(): void {
    if (!isPauseFeatureEnabled('domCaptionObserver')) return;
    if (this.active) return;
    if (typeof document === 'undefined') return;
    this.videoId ||= new URL(location.href).searchParams.get('v') || '';
    this.active = true;
    this.capabilities = {...this.capabilities,availability:'loading',failureReason:null};
    this.publishStatus();
    const refresh = () => {
      if (!this.active) return;
      const root = document.querySelector('#movie_player');
      if (root !== this.observedRoot) {
        this.observer?.disconnect(); this.observer = null; this.observedRoot = root;
        if (root && typeof MutationObserver !== 'undefined') {
          this.observer = new MutationObserver(()=>{ void this.processDomCaptions(); });
          this.observer.observe(root,{childList:true,subtree:true,characterData:true});
        }
      }
      void this.processDomCaptions();
    };
    refresh();
    // Poll also detects replacement of the player/container, not only child mutations.
    this.pollIntervalId = setInterval(refresh,250);
  }
  async processDomCaptions(): Promise<void> {
    if (!this.active || !this.video || this.video.paused || typeof document === 'undefined') return;
    if (new URL(location.href).searchParams.get('v') !== this.videoId) return;
    const frame = readSpeechCaption(document.querySelector('#movie_player') || document);
    this.options.onSnapshot?.({text:frame?.text || '',wallMs:Date.now(),videoSec:this.video.currentTime,language:frame?.language || null});
    if (!frame) {
      this.capabilities = {...this.capabilities,availability:'unavailable',failureReason:'NO_RENDERED_SPEECH_CAPTION'};
      this.publishStatus(); return;
    }
    if (frame.text === this.lastCapturedText) return;
    this.lastCapturedText = frame.text;
    this.capabilities = {...this.capabilities,language:frame.language,availability:'available',failureReason:null};
    this.publishStatus();
    const time = this.video.currentTime;
    const index = this.cueIndex++;
    const duration = Math.max(1.5,Math.min(6,frame.text.split(/\s+/).length/2.5));
    const cue: SubtitleCue = {
      id:`${this.videoId}:live-${this.generation}-${index}`, index, startTime:time,endTime:time+duration,duration,
      originalText:frame.text,turkishText:'',speakerId:'speaker-a',isAutoGenerated:true,
      acquisition:{source:'live_dom',wallMs:Date.now(),monotonicMs:performance.now(),videoSec:time,language:frame.language,timestamps:'estimated'},
    };
    this.options.onDiagnostic?.(cue,'caption_received',{mode:'live',text:frame.text,language:frame.language,start:time,end:cue.endTime,lines:frame.lines,deduplication:'accepted'});
    this.cues.push(cue); this.cues=this.cues.slice(-100);
    this.handlers?.onCues([cue],false);
    this.options.onNewCue?.(cue); this.options.onCuesChanged?.([...this.cues]);
  }
  getCues(): SubtitleCue[] { return [...this.cues]; }
  stop(): void {
    this.generation++; this.active=false;
    if(this.pollIntervalId) clearInterval(this.pollIntervalId);
    this.pollIntervalId=null; this.observer?.disconnect();this.observer=null;this.observedRoot=null;
  }
  reset(): void { this.stop();this.cues=[];this.lastCapturedText='';this.cueIndex=0;this.videoId=''; }
}
