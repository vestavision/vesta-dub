/**
 * Scores system sentence cuts against a completed human boundary review.
 * A blank or unfinished review is blocked. This module does not invent labels.
 *
 * Sentence labels are the recall reference.
 * Clause labels are acceptable alternatives: a system cut there is not a false
 * positive, and a miss there is not a false negative.
 * Uncertain labels are excluded from precision and from recall.
 * On a reviewed passage, a position with no label is "no boundary".
 */

export const BOUNDARY_LABELS = ['sentence', 'clause', 'uncertain'] as const;
export type BoundaryLabel = (typeof BOUNDARY_LABELS)[number];

export interface BoundaryScorePassage {
  id: string;
  reviewed: boolean;
  /** Left-token source index → label. Null and missing keys are "no boundary" once reviewed. */
  boundaries: Record<string, BoundaryLabel | null | undefined>;
  /** Left-token source indexes where the system placed a cut. Omit the track-final token. */
  systemCuts: number[];
}

export interface BoundaryScoreReport {
  status: 'blocked' | 'scored';
  reason: string | null;
  reviewedPassages: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  sentenceReference: number;
  clauseAlternativeHits: number;
  uncertainExcluded: number;
  precision: number | null;
  recall: number | null;
}

const EMPTY: BoundaryScoreReport = {
  status: 'blocked',
  reason: 'no_reviewed_passages',
  reviewedPassages: 0,
  truePositive: 0,
  falsePositive: 0,
  falseNegative: 0,
  sentenceReference: 0,
  clauseAlternativeHits: 0,
  uncertainExcluded: 0,
  precision: null,
  recall: null,
};

function isLabel(value: unknown): value is BoundaryLabel {
  return value === 'sentence' || value === 'clause' || value === 'uncertain';
}

export function scoreBoundaries(passages: BoundaryScorePassage[]): BoundaryScoreReport {
  const reviewed = (passages || []).filter(passage => passage.reviewed);
  if (reviewed.length === 0) return { ...EMPTY };
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let sentenceReference = 0;
  let clauseAlternativeHits = 0;
  let uncertainExcluded = 0;
  for (const passage of reviewed) {
    const labels = new Map<number, BoundaryLabel>();
    for (const [key, value] of Object.entries(passage.boundaries || {})) {
      if (isLabel(value)) labels.set(Number(key), value);
    }
    const cuts = new Set(passage.systemCuts || []);
    for (const [after, label] of labels) {
      if (label === 'sentence') {
        sentenceReference += 1;
        if (!cuts.has(after)) falseNegative += 1;
      }
    }
    for (const after of cuts) {
      const label = labels.get(after);
      if (label === 'sentence' || label === 'clause') {
        truePositive += 1;
        if (label === 'clause') clauseAlternativeHits += 1;
      } else if (label === 'uncertain') uncertainExcluded += 1;
      else falsePositive += 1;
    }
  }
  const precisionDenom = truePositive + falsePositive;
  return {
    status: 'scored',
    reason: null,
    reviewedPassages: reviewed.length,
    truePositive,
    falsePositive,
    falseNegative,
    sentenceReference,
    clauseAlternativeHits,
    uncertainExcluded,
    precision: precisionDenom === 0 ? null : truePositive / precisionDenom,
    recall: sentenceReference === 0 ? null : (sentenceReference - falseNegative) / sentenceReference,
  };
}
