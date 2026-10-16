import { SubtitleCue } from '../core/types';

export interface LiveSnapshot { text: string; wallMs: number; videoSec: number; language: string | null; }
interface Token { text: string; key: string; firstMs: number; confirmations: number; }
export interface CommittedPhrase { cue: SubtitleCue; epoch: string; tokenStart: number; tokenEnd: number; committedMs: number; reason: string; }
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const key = (text: string) => text.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}']/gu, '');

/** One occurrence ledger per playback epoch. No translation or audio in this component. */
export class LiveCaptionCommitter {
  private tokens: Token[] = [];
  private base = 0;
  private committed = 0;
  private windowStart = 0;
  private last?: LiveSnapshot;
  private emptySince?: number;
  private epochNumber = 0;
  private sequence = 0;
  private videoId = '';
  private epoch = '';
  constructor(private emit: (phrase: CommittedPhrase) => void,
    private diagnostic: (stage: string, detail: Record<string, unknown>) => void = () => {}) {}

  reset(videoId: string, reason: string): void {
    if (this.tokens.length > this.committed) this.diagnostic('provisional_interrupted', { reason, tokens: this.tokens.slice(this.committed).map(t=>t.text).join(' '), epoch:this.epoch });
    this.videoId=videoId; this.epoch=`${videoId}:epoch-${++this.epochNumber}`;
    this.tokens=[];this.base=0;this.committed=0;this.windowStart=0;this.last=undefined;this.emptySince=undefined;this.sequence=0;
    this.diagnostic('caption_epoch', {epoch:this.epoch,reason});
  }
  getEpoch(): string { return this.epoch; }
  observe(snapshot: LiveSnapshot): void {
    if (!this.epoch) this.reset(this.videoId,'initial');
    if (this.last) {
      const wallDelta=(snapshot.wallMs-this.last.wallMs)/1000;
      const videoDelta=snapshot.videoSec-this.last.videoSec;
      if (wallDelta<0 || videoDelta < -0.5 || Math.abs(videoDelta-wallDelta)>2.5) this.reset(this.videoId,'timeline_discontinuity');
    }
    if (!snapshot.text.trim()) { this.emptySince ??= snapshot.wallMs; this.tick(snapshot.wallMs); return; }
    const newSegment=this.emptySince!==undefined && snapshot.wallMs-this.emptySince>=1200;
    if(newSegment) { this.commit(this.tokens.length,snapshot.wallMs,'segment_end_fallback'); this.tokens=[];this.base+=this.committed;this.committed=0;this.windowStart=0; }
    this.emptySince=undefined;
    const incoming=words(snapshot.text);
    const old=this.tokens.slice(this.windowStart);
    // Align the new window against its previous occurrence, not a global text cache.
    let offset=0, overlap=0;
    for(let i=0;i<old.length;i++) {
      let n=0;while(n<incoming.length && i+n<old.length && old[i+n].key===key(incoming[n])) n++;
      if(n>overlap && (i===0 || n>=2)) {offset=i;overlap=n;}
    }
    if(old.length && !overlap) {
      this.commit(this.tokens.length,snapshot.wallMs,'boundary_fallback');
      this.base+=this.tokens.length;this.tokens=[];this.committed=0;this.windowStart=0;
    } else this.windowStart+=offset;
    const start=this.windowStart;
    // Preserve already committed words; contradictions are observable compromises.
    for(let i=0;i<incoming.length;i++) {
      const pos=start+i, existing=this.tokens[pos];
      if(existing && existing.key===key(incoming[i])) {existing.text=incoming[i];existing.confirmations++;}
      else if(pos<this.committed) this.diagnostic('committed_revision_conflict',{epoch:this.epoch,position:this.base+pos,spoken:existing?.text,revised:incoming[i]});
      else this.tokens[pos]={text:incoming[i],key:key(incoming[i]),firstMs:snapshot.wallMs,confirmations:1};
    }
    const end=start+incoming.length;
    if(end<this.tokens.length && end>=this.committed) this.tokens.length=end;
    this.last=snapshot;
    this.diagnostic('caption_provisional',{epoch:this.epoch,text:snapshot.text,stableTokens:this.tokens.filter(t=>t.confirmations>=2).length});
    this.tick(snapshot.wallMs);
  }
  tick(nowMs: number): void {
    if(!this.last || this.committed>=this.tokens.length) return;
    let stable=this.committed;
    while(stable<this.tokens.length && this.tokens[stable].confirmations>=2 && nowMs-this.tokens[stable].firstMs>=700) stable++;
    let boundary=0;
    for(let i=this.committed;i<stable;i++) if(/[.!?]["')]*$/.test(this.tokens[i].text)) boundary=i+1;
    if(boundary) this.commit(boundary,nowMs,'sentence_boundary');
    else if(this.emptySince!==undefined && nowMs-this.emptySince>=800) this.commit(this.tokens.length,nowMs,'segment_end_fallback');
    else {
      const ready=Math.min(stable,this.tokens.length-2);
      let clause=0;
      for(let i=this.committed+6;i<ready;i++) {
        const a=this.tokens[i].key,b=this.tokens[i+1]?.key;
        if(['and','but','so'].includes(a) && ['i','we','you','it','they','this','that'].includes(b)) clause=i;
      }
      if(clause && (this.windowStart>this.committed || nowMs-this.tokens[this.committed].firstMs>=3000)) this.commit(clause,nowMs,'stable_clause_boundary');
      else if(this.windowStart-this.committed>=12) this.commit(this.safeEnd(Math.min(this.windowStart,stable)),nowMs,'stable_eviction');
      else if(nowMs-this.tokens[this.committed].firstMs>=6000 && ready-this.committed>=8) this.commit(this.safeEnd(ready),nowMs,'bounded_stable_prefix');
    }
    // Retain a bounded alignment context, while absolute occurrence positions survive compaction.
    const trim=Math.min(this.committed,this.windowStart);
    if(trim>128) {this.tokens.splice(0,trim);this.base+=trim;this.committed-=trim;this.windowStart-=trim;}
  }
  private safeEnd(end: number): number {
    // Retain grammatical lead-ins for the following phrase; never delete them.
    const leadIns=new Set(['a','an','the','and','but','so','because','of','to','for','with','in','on','at','that','which','is','are','was','were','has','have','can','would','will']);
    while(end-this.committed>6 && leadIns.has(this.tokens[end-1].key)) end--;
    return end;
  }
  private commit(end: number, nowMs: number, reason: string): void {
    if(end<=this.committed) return;
    const range=this.tokens.slice(this.committed,end);
    if(!range.length || (range.some(t=>t.confirmations<2) && !reason.endsWith('fallback'))) return;
    const start=this.committed; this.committed=end;
    const text=range.map(t=>t.text).join(' '), duration=Math.max(1.5,(range.at(-1)!.firstMs-range[0].firstMs)/1000+0.4);
    const firstMs=range[0].firstMs;
    const cue: SubtitleCue={id:`${this.epoch}:phrase-${this.sequence++}`,index:this.sequence-1,startTime:this.last?.videoSec||0,endTime:(this.last?.videoSec||0)+duration,duration,originalText:text,turkishText:'',speakerId:'speaker-a',isAutoGenerated:true,
      acquisition:{source:'live_dom',wallMs:firstMs,monotonicMs:0,videoSec:this.last?.videoSec||0,language:this.last?.language||null,timestamps:'estimated'}};
    this.emit({cue,epoch:this.epoch,tokenStart:this.base+start,tokenEnd:this.base+end,committedMs:nowMs,reason});
  }
}
