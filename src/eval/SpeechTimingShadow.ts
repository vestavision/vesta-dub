/**
 * Predicted timing for reconstructed Turkish units.
 * This does not schedule audio. Syllable rates are the existing Antalia
 * calibration. EMA has no calibration profile, so an EMA figure is not produced.
 * A missing Turkish string produces no speech-duration estimate.
 */

import { CALIBRATION_PROFILES, DurationBudgetEstimator } from '../translation/DurationBudgetEstimator';
import { prepareSpeech } from '../tts/FillerPreparation';

export interface TimedUnit {
  id: string;
  text: string;
  turkish: string;
  startTime: number;
  endTime: number;
}

export interface TurkishSpeechSegment {
  text: string;
  reason: 'whole_unit' | 'punctuation' | 'conjunction';
}

export interface TimingPrediction {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  sourceDurationSec: number;
  gapAfterSec: number;
  overlapNext: boolean;
  firstAudioWaitSec: number;
  turkish: string;
  spokenText: string;
  fillerRemoved: number;
  syllables: number | null;
  estimatedSpeechSec: number | null;
  estimateBasis: 'antalia_syllables_per_sec' | 'not_estimated';
  availableWindowSec: number | null;
  requiredSpeed: number | null;
  aboveSchedulerCompromise: boolean | null;
  aboveMaxStretch: boolean | null;
  unresolvedOverflowSec: number | null;
  segments: TurkishSpeechSegment[];
  segmentsCoverTranslation: boolean;
  assumptions: string[];
}

const SCHEDULER_COMPROMISE_SPEED = 1.12;
const MAX_STRETCH = 1.25;
const LONG_SPEECH_SEC = 8;
const SYLLABLES_PER_SEC = CALIBRATION_PROFILES.antalia?.syllablesPerSec ?? 4.65;

export function predictTiming(units: TimedUnit[]): TimingPrediction[] {
  const ordered = [...units].sort((a, b) => a.startTime - b.startTime);
  return ordered.map((unit, index) => {
    const next = ordered[index + 1];
    const sourceDurationSec = round3(Math.max(0, unit.endTime - unit.startTime));
    const gapAfterSec = next ? round3(Math.max(0, next.startTime - unit.endTime)) : 0;
    const overlapNext = Boolean(next && next.startTime < unit.endTime - 0.02);
    const assumptions = [
      'First-audio wait assumes synthesis cannot start until the reconstructed unit closes.',
      'Speech duration uses the Antalia syllable calibration, not a measured waveform.',
      'EMA duration is not estimated.',
      'The following gap contributes at most 2.0s, matching DurationBudgetEstimator.',
    ];
    const base = {
      id: unit.id,
      sourceStart: round3(unit.startTime),
      sourceEnd: round3(unit.endTime),
      sourceDurationSec,
      gapAfterSec,
      overlapNext,
      firstAudioWaitSec: sourceDurationSec,
      assumptions,
    };
    const turkish = unit.turkish.replace(/\s+/g, ' ').trim();
    if (!turkish) {
      return {
        ...base,
        turkish: '',
        spokenText: '',
        fillerRemoved: 0,
        syllables: null,
        estimatedSpeechSec: null,
        estimateBasis: 'not_estimated' as const,
        availableWindowSec: null,
        requiredSpeed: null,
        aboveSchedulerCompromise: null,
        aboveMaxStretch: null,
        unresolvedOverflowSec: null,
        segments: [],
        segmentsCoverTranslation: false,
      };
    }
    const preparation = prepareSpeech(turkish, { sourceText: unit.text });
    const spoken = preparation.spokenText || preparation.filteredText || turkish;
    const syllables = DurationBudgetEstimator.countTurkishSyllables(spoken);
    const estimatedSpeechSec = round3(Math.max(0.3, syllables / SYLLABLES_PER_SEC + 0.15));
    const silence = Math.min(2, gapAfterSec * 0.8);
    const availableWindowSec = round3(sourceDurationSec + silence);
    const requiredSpeed = availableWindowSec > 0 ? round3(estimatedSpeechSec / availableWindowSec) : null;
    const safeSpeed = requiredSpeed === null ? 1 : Math.max(1, Math.min(MAX_STRETCH, requiredSpeed));
    const afterStretch = estimatedSpeechSec / safeSpeed;
    const segments = segmentTurkish(spoken, estimatedSpeechSec);
    return {
      ...base,
      turkish,
      spokenText: spoken,
      fillerRemoved: preparation.removedTokenCount,
      syllables,
      estimatedSpeechSec,
      estimateBasis: 'antalia_syllables_per_sec' as const,
      availableWindowSec,
      requiredSpeed,
      aboveSchedulerCompromise: requiredSpeed !== null && requiredSpeed > SCHEDULER_COMPROMISE_SPEED,
      aboveMaxStretch: requiredSpeed !== null && requiredSpeed > MAX_STRETCH,
      unresolvedOverflowSec: round3(Math.max(0, afterStretch - availableWindowSec)),
      segments,
      segmentsCoverTranslation: segments.map(segment => segment.text).join(' ') === spoken,
    };
  });
}

export function segmentTurkish(spoken: string, estimatedSpeechSec: number): TurkishSpeechSegment[] {
  const text = spoken.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (estimatedSpeechSec <= LONG_SPEECH_SEC) return [{ text, reason: 'whole_unit' }];
  const punctuated = splitKeeping(text, /(?<=[.;!?])\s+/);
  if (punctuated.length > 1 && punctuated.every(part => part.length >= 8)) {
    return punctuated.map(part => ({ text: part, reason: 'punctuation' as const }));
  }
  const conjunct = splitKeeping(text, /\s+(?=ve\s|ama\s|fakat\s|çünkü\s)/i);
  if (conjunct.length > 1 && conjunct.every(part => part.length >= 12)) {
    return conjunct.map(part => ({ text: part, reason: 'conjunction' as const }));
  }
  return [{ text, reason: 'whole_unit' }];
}

function splitKeeping(text: string, pattern: RegExp): string[] {
  return text.split(pattern).map(part => part.trim()).filter(Boolean);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}
