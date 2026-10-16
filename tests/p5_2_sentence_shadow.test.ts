import { describe, expect, it } from 'vitest';
import { evaluateSentenceShadow } from '../scripts/p5.2-sentence-shadow';
const native = (texts: string[]) => JSON.stringify({events:texts.map((text,i)=>({tStartMs:i*1000,dDurationMs:1000,segs:[{utf8:text}]}))});
describe('observation-only sentence admission',()=>{
  it('reports removed repeated words rather than certifying coverage',()=>{
    const result=evaluateSentenceShadow(native(['very','very important']));
    expect(result.missingTokenCounts).toContainEqual({token:'very',count:1});
    expect(result.reportedDedupedTokens).toBe(1);
    expect(result.assemblyAdmitted).toBe(false);
  });
  it('keeps the original most mostly and might might examples visible for review',()=>{
    const result=evaluateSentenceShadow(native(['most mostly','might might']));
    expect(result.repetitionExcerpts).toHaveLength(2);
    expect(result.sourceTokens).toBe(4);
    expect(result.outputTokens).toBe(4);
  });
  it('exposes hyphen joins as token transformations, not exact provenance',()=>{
    const result=evaluateSentenceShadow(native(['train-','ing']));
    expect(result.missingTokenCounts).toEqual([{token:'train-',count:1},{token:'ing',count:1}]);
    expect(result.addedTokenCounts).toEqual([{token:'training',count:1}]);
  });
});
