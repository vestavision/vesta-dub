import { classifyDiscourse, renderDiscourse, type DiscourseMarker, type DiscourseReplacement } from './DiscourseMarkers';
import { TurkishSpeechNormalizer, type NormalizeOptions } from './TurkishSpeechNormalizer';
export type SpeechTokenCategory = 'hesitation' | 'thinking' | 'interjection' | 'backchannel' | 'repetition' | 'asr-duplication' | 'word';
export interface FillerTokenDecision { text: string; start: number; end: number; category: SpeechTokenCategory; action: 'keep' | 'remove'; rule: string; sourceMatch?: {text:string;start:number;end:number}; evidenceId?:string }
export interface FillerContext { sourceText?:string; verifiedAsrDuplicates?: {start:number;end:number;duplicateOf:string;evidenceId:string}[]; discourse?: boolean; pronunciationProfile?: NormalizeOptions['profile'] }
export interface SpeechPreparation { displayText:string; filteredText:string; spokenText:string; tokens:FillerTokenDecision[]; omitted:boolean; removedTokenCount:number; rulesVersion:'v0.1.1'; discourse:DiscourseMarker[]; discourseApplied:DiscourseReplacement[] }
const tokensOf=(text:string)=>[...text.matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)].map(m=>({text:m[0],start:m.index!,end:m.index!+m[0].length}));
const clearHesitation=(s:string)=>/^(?:uh|um|erm|ı{2,}|e{3,})$/u.test(s.toLocaleLowerCase('tr'));
/** Text-only policy: abstain on ambiguity; repeated words need independent revision evidence. */
export function prepareSpeech(displayText:string,context:FillerContext={}):SpeechPreparation {
 const raw=tokensOf(displayText),source=tokensOf(context.sourceText??''),allHesitations=raw.length>0&&raw.every(t=>clearHesitation(t.text));
 const evidence=displayText+' '+(context.sourceText??'');
 const ambiguous=/[?…]|\.\.\.|["“”]|\b(?:emin|belki|sanırım|galiba|acaba|maybe|uncertain|guess|hesitation|filler|word|term|kelimesi|sözcüğü|harf|micrometre|micrometer)\b|(?:^|[\s([{])['‘’]\s*\p{L}/iu.test(evidence);
 const decisions:FillerTokenDecision[]=raw.map((t,i)=>{
  const word=t.text.toLocaleLowerCase('tr');let category:SpeechTokenCategory='word',rule='ordinary-word';
  if(/^(?:uh-huh|uh-uh|mm-hmm|mm-mm|mhm|hı-hı)$/u.test(word)){category='backchannel';rule='backchannel-kept';}
  else if(/^h+m+$/u.test(word)||word==='hmm'){category='thinking';rule='thinking-uncertainty-kept';}
  else if(/^(?:ah|oh|wow|vay|oha)$/u.test(word)){category='interjection';rule='reaction-kept';}
  else if(clearHesitation(word)||word==='er'||word==='ee'){category='hesitation';rule='ambiguous-hesitation-kept';}
  else if(i>0&&raw[i-1].text.toLocaleLowerCase('tr')===word){category='repetition';rule='repetition-without-revision-evidence-kept';}
  const decision:FillerTokenDecision={...t,category,action:'keep',rule};
  const duplicate=context.verifiedAsrDuplicates?.find(d=>d.start===t.start&&d.end===t.end&&d.evidenceId.trim()&&d.duplicateOf===t.text&&raw.some(p=>p.end<=t.start&&p.text===d.duplicateOf));
  if(duplicate){decision.category='asr-duplication';decision.action='remove';decision.rule='externally-verified-asr-revision';decision.evidenceId=duplicate.evidenceId;return decision;}
  const sourceMatch=source.find(s=>s.text.toLocaleLowerCase('tr')===word&&clearHesitation(s.text))??source.find(s=>clearHesitation(s.text));
  const before=displayText.slice(0,t.start),after=displayText.slice(t.end);
  const connectedIdentifier=/[@./\\:_-]$/.test(before)||/^[@./\\:_-][\p{L}\p{N}]/u.test(after);
  const measurement=word==='um'&&i>0&&/^\p{N}+$/u.test(raw[i-1].text);
  const delimited=(!before.trim()||/[,;]\s*$/.test(before))&&/^\s*[,;]/.test(after);
  const interior=i>0&&i<raw.length-1&&source.some(s=>s.text.toLocaleLowerCase('tr')===word)
    &&!/^[\p{N}]+$/u.test(raw[i-1].text)
    &&!/^(?:ah|oh|wow|uh-huh|uh-uh|mm-hmm|mm-mm)$/iu.test(raw[i+1].text);
  const identifier=t.text.length>1&&(t.text===t.text.toUpperCase()||(i>0&&t.text!==word));
  if(category==='hesitation'&&clearHesitation(word)&&!ambiguous&&!identifier&&!connectedIdentifier&&!measurement&&(allHesitations||delimited||interior)&&sourceMatch&&!(raw.length===1&&word==='uh')){
   decision.action='remove';decision.rule=allHesitations?'source-corroborated-hesitation-only':delimited?'source-corroborated-delimited-hesitation':'source-corroborated-interior-hesitation';decision.sourceMatch=sourceMatch;
  }
  return decision;
 });
 let filteredText=displayText;
 for(const t of [...decisions].reverse())if(t.action==='remove')filteredText=filteredText.slice(0,t.start)+filteredText.slice(t.end);
 const removedTokenCount=decisions.filter(t=>t.action==='remove').length;
 if(removedTokenCount){filteredText=filteredText.replace(/^\s*[,;:]\s*/,'').replace(/([,;])\s*[,;]/g,'$1').replace(/\s+([,.;!?])/g,'$1').replace(/\s{2,}/g,' ').trim();if(!/[\p{L}\p{N}]/u.test(filteredText))filteredText='';}
 const discourse=context.discourse===false?[]:classifyDiscourse(context.sourceText??'');
 const rendered=context.discourse===false?{text:filteredText,applied:[] as DiscourseReplacement[]}:renderDiscourse(filteredText,discourse);
 const spokenText=rendered.text?TurkishSpeechNormalizer.normalize(rendered.text,{profile:context.pronunciationProfile??'production'}).spokenText:'';
 return {displayText,filteredText,spokenText,tokens:decisions,omitted:filteredText===''||spokenText==='',removedTokenCount,rulesVersion:'v0.1.1',discourse,discourseApplied:rendered.applied};
}
