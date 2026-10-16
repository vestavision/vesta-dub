export type ActivationMode = 'manual' | 'tab' | 'always';
export type ActivationPhase = 'inactive' | 'starting' | 'active' | 'stopping' | 'failed' | 'blocked';
export const ACTIVATION_KEY = 'vesta_activation_preference_v1';
export const ACTIVATION_MODES = [
  {value:'manual',label:'Manuel başlat',description:'Her yeni videoda dublajı kendin başlat.'},
  {value:'tab',label:'Bu sekmede devam et',description:'Aynı sekmede sonraki videolarda otomatik başlat.'},
  {value:'always',label:'Her videoda otomatik başlat',description:'YouTube videolarında dublajı otomatik başlat.'},
] as const;
export function activationPreference(value:unknown):{version:1;mode:ActivationMode} {
  const item=value as {version?:unknown;mode?:unknown}|null;
  return {version:1,mode:item?.version===1&&typeof item.mode==='string'&&['manual','tab','always'].includes(item.mode)?item.mode as ActivationMode:'manual'};
}
/** URL identity ignores timestamp/query/history noise. Shorts, embeds, feeds and other sites are unsupported. */
export function watchVideoId(url:string):string|null {
  try {const u=new URL(url);const id=u.searchParams.get('v');return u.protocol==='https:'&&['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)&&u.pathname==='/watch'&&id&&/^[\w-]{11}$/.test(id)?id:null;}catch{return null;}
}
export interface ActivationSnapshot {
  documentId:string;mode:ActivationMode;videoId:string|null;activeVideoId:string|null;
  continuationAllowed:boolean;suppressedVideoId:string|null;phase:ActivationPhase;epoch:number;
}
/** One instance per document: never persisted, shared across tabs, or reconstructed by a worker. */
export class ActivationPolicy {
  private state:ActivationSnapshot;
  constructor(mode:ActivationMode='manual',documentId=crypto.randomUUID()) {
    this.state={documentId,mode,videoId:null,activeVideoId:null,continuationAllowed:false,suppressedVideoId:null,phase:'inactive',epoch:0};
  }
  snapshot():ActivationSnapshot{return {...this.state};}
  resetDocument():void {
    this.state={documentId:crypto.randomUUID(),mode:this.state.mode,videoId:null,activeVideoId:null,
      continuationAllowed:false,suppressedVideoId:null,phase:'inactive',epoch:this.state.epoch+1};
  }
  setMode(mode:ActivationMode):void {
    if(this.state.mode===mode)return;
    this.state.mode=mode;this.state.continuationAllowed=false;
    // A preference edit is never an activation opportunity, even on the current watch page.
  }
  visit(videoId:string|null,allowAutomatic=true):boolean {
    if(videoId===this.state.videoId)return false;
    ++this.state.epoch;this.state.videoId=videoId;this.state.activeVideoId=null;
    if(videoId===null)this.state.suppressedVideoId=null;
    this.state.phase='inactive';
    if(allowAutomatic&&videoId&&videoId!==this.state.suppressedVideoId&&(this.state.mode==='always'||(this.state.mode==='tab'&&this.state.continuationAllowed))){this.state.activeVideoId=videoId;this.state.phase='starting';}
    return true;
  }
  confirmVideo(videoId:string):void {
    if(videoId===this.state.videoId && videoId!==this.state.suppressedVideoId)this.state.suppressedVideoId=null;
  }
  start(videoId:string|null):boolean {
    if(!videoId||videoId!==this.state.videoId)return false;
    if(this.state.activeVideoId===videoId)return false;
    ++this.state.epoch;this.state.activeVideoId=videoId;this.state.suppressedVideoId=null;this.state.phase='starting';
    this.state.continuationAllowed=this.state.mode==='tab';return true;
  }
  stop():void {
    ++this.state.epoch; // Revoke even a Start that has not arrived yet.
    this.state.activeVideoId=null;this.state.continuationAllowed=false;this.state.suppressedVideoId=this.state.videoId;this.state.phase='inactive';
  }
  fail(blocked=false):void {
    ++this.state.epoch;this.state.activeVideoId=null;this.state.suppressedVideoId=this.state.videoId;this.state.phase=blocked?'blocked':'failed';
  }
  phase(phase:ActivationPhase):void {if(this.state.activeVideoId)this.state.phase=phase;}
  isCurrent(epoch:number,videoId:string|null):boolean{return this.state.epoch===epoch&&this.state.activeVideoId===videoId&&videoId!==null;}
}
