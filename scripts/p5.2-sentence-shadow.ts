import { TranscriptSentenceAssembler } from '../src/subtitles/TranscriptSentenceAssembler';
import { CaptionParser } from '../src/subtitles/CaptionParser';

/** Observation only: no scheduler, translation or extension-state writes. */
export function evaluateSentenceShadow(text: string) {
  const cues = CaptionParser.parse(text);
  const groups = TranscriptSentenceAssembler.assemble(cues);
  const rawTokens = cues.flatMap(c => c.originalText.trim().split(/\s+/));
  const outputTokens = groups.flatMap(g => g.text.trim().split(/\s+/));
  const counts = (tokens: string[]) => tokens.reduce<Record<string, number>>((m,t) => { m[t]=(m[t]||0)+1; return m; },{});
  const before = counts(rawTokens), after = counts(outputTokens);
  const missing = Object.entries(before).filter(([t,n]) => n > (after[t]||0)).map(([token,n]) => ({token,count:n-(after[token]||0)}));
  const added = Object.entries(after).filter(([t,n]) => n > (before[t]||0)).map(([token,n]) => ({token,count:n-(before[token]||0)}));
  return {
    sourceCues: cues.length, sourceTokens: rawTokens.length, proposedGroups: groups.length,
    outputTokens: outputTokens.length, reportedDedupedTokens: groups.reduce((n,g)=>n+g.dedupedTokens,0),
    boundaries: groups.reduce<Record<string,number>>((m,g)=>{m[g.boundary]=(m[g.boundary]||0)+1;return m;},{}),
    missingTokenCounts: missing, addedTokenCounts: added,
    coverageNote: 'Exact token multiset comparison; not positional provenance or proof of semantic completeness. Hyphen joins appear as missing and added tokens.',
    repetitionExcerpts: cues.filter(c=>/\bmost mostly\b|\bmight might\b|\b(\w+)\s+\1\b/i.test(c.originalText)).slice(0,20).map(c=>({index:c.index,text:c.originalText,start:c.startTime,end:c.endTime})),
    groupExcerpts: groups.slice(0,6),
    assemblyAdmitted: false,
  };
}
