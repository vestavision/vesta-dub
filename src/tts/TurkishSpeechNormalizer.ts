import { PRONUNCIATION_LEXICON, LexiconEntry } from './pronunciationLexicon';

export interface NormalizationResult {
  /** Original grammatically correct Turkish display text for subtitles */
  displayText: string;
  /** Pronunciation-optimized text exclusively for Turkish TTS */
  spokenText: string;
}

export interface NormalizeOptions {
  /**
   * `candidate` also applies listening-candidate lexicon entries.
   * Playback uses `production` until a human review promotes a candidate.
   */
  profile?: 'production' | 'candidate';
}

const ONES: Record<number, string> = {
  0: 'sıfır',
  1: 'bir',
  2: 'iki',
  3: 'üç',
  4: 'dört',
  5: 'beş',
  6: 'altı',
  7: 'yedi',
  8: 'sekiz',
  9: 'dokuz',
};

const TENS: Record<number, string> = {
  10: 'on',
  20: 'yirmi',
  30: 'otuz',
  40: 'kırk',
  50: 'elli',
  60: 'altmış',
  70: 'yetmiş',
  80: 'seksen',
  90: 'doksan',
};

const SCALES: Array<{ value: number; name: string }> = [
  { value: 1_000_000_000_000, name: 'trilyon' },
  { value: 1_000_000_000, name: 'milyar' },
  { value: 1_000_000, name: 'milyon' },
  { value: 1_000, name: 'bin' },
  { value: 100, name: 'yüz' },
];

/**
 * Convert integer to spoken Turkish words
 */
export function integerToTurkish(n: number): string {
  if (n === 0) return 'sıfır';
  if (n < 0) return 'eksi ' + integerToTurkish(-n);

  let num = Math.floor(n);
  const parts: string[] = [];

  // Trillions, Billions, Millions
  for (const scale of SCALES.slice(0, 3)) {
    if (num >= scale.value) {
      const count = Math.floor(num / scale.value);
      parts.push(integerToTurkish(count) + ' ' + scale.name);
      num %= scale.value;
    }
  }

  // Thousands: in Turkish, 1000 is "bin", not "bir bin"; 2000 is "iki bin"
  if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    if (thousands === 1) {
      parts.push('bin');
    } else {
      parts.push(integerToTurkish(thousands) + ' bin');
    }
    num %= 1000;
  }

  // Hundreds: in Turkish, 100 is "yüz", not "bir yüz"; 200 is "iki yüz"
  if (num >= 100) {
    const hundreds = Math.floor(num / 100);
    if (hundreds === 1) {
      parts.push('yüz');
    } else {
      parts.push(ONES[hundreds] + ' yüz');
    }
    num %= 100;
  }

  // Tens and ones
  if (num >= 10) {
    const ten = Math.floor(num / 10) * 10;
    parts.push(TENS[ten]);
    num %= 10;
  }

  if (num > 0) {
    parts.push(ONES[num]);
  }

  return parts.join(' ');
}

/**
 * Convert Turkish ordinal number (e.g. 1. -> birinci)
 */
export function ordinalToTurkish(n: number): string {
  const cardinal = integerToTurkish(n);
  // Phonological suffix harmony for Turkish ordinals (-inci, -ıncı, -üncü, -uncu)
  const lastVowel = cardinal.match(/[aeıioöuü]/g)?.pop() || 'i';
  let suffix = 'inci';
  if (lastVowel === 'a' || lastVowel === 'ı') suffix = 'ıncı';
  else if (lastVowel === 'e' || lastVowel === 'i') suffix = 'inci';
  else if (lastVowel === 'o' || lastVowel === 'u') suffix = 'uncu';
  else if (lastVowel === 'ö' || lastVowel === 'ü') suffix = 'üncü';

  // If word ends in a vowel, drop initial vowel of suffix (e.g., iki + nci -> ikinci, yedi + nci -> yedinci)
  if (/[aeıioöuü]$/.test(cardinal)) {
    suffix = suffix.slice(1);
  }
  // dör(t) -> dördüncü
  let stem = cardinal;
  if (stem.endsWith('dört')) {
    stem = stem.slice(0, -1) + 'd';
  }
  return stem + suffix;
}

export class TurkishSpeechNormalizer {
  /**
   * Main entrypoint: Takes display text and returns { displayText, spokenText }
   */
  static normalize(text: string, options?: NormalizeOptions): NormalizationResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { displayText: '', spokenText: '' };
    }

    let spoken = trimmed;
    // Bergamot sometimes emits a dialogue dash. It is not a spoken word.
    spoken = spoken.replace(/^\s*[-–—•]\s+(?=\p{L})/u, '');

    // 1. Protect special literals: URLs, emails, code blocks from destruction
    const placeholders: Map<string, string> = new Map();
    let placeholderCounter = 0;

    spoken = spoken.replace(/https?:\/\/[^\s]+/g, (match) => {
      const key = `__URL_${placeholderCounter++}__`;
      placeholders.set(key, 'link');
      return key;
    });

    // 2. Normalize compound model identifiers before lexicon (e.g. GPT-4, GPT-4o, GPT-3.5)
    spoken = spoken.replace(/\bGPT-4o\b/gi, 'ci pi ti dört o');
    spoken = spoken.replace(/\bGPT-4\b/gi, 'ci pi ti dört');
    spoken = spoken.replace(/\bGPT-3\.5\b/gi, 'ci pi ti üç buçuk');
    spoken = spoken.replace(/\bRTX\s*(\d{4})\b/gi, (_, modelNum) => {
      return `ar ti eks ${integerToTurkish(parseInt(modelNum, 10))}`;
    });

    // 3. Normalize magnitude abbreviations with context (100B, 70B, 7B, 3.5B, 10M, 100K)
    // 100B / 100 B parameters -> yüz milyar
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*[bB]\b/g, (_, numStr) => {
      const normalizedNum = numStr.replace(',', '.');
      const val = parseFloat(normalizedNum);
      if (Number.isInteger(val)) {
        return `${integerToTurkish(val)} milyar`;
      } else {
        const [intPart, decPart] = normalizedNum.split('.');
        const intWord = integerToTurkish(parseInt(intPart, 10));
        const decWord = integerToTurkish(parseInt(decPart, 10));
        return `${intWord} nokta ${decWord} milyar`;
      }
    });

    // Millions (10M -> on milyon)
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*[mM]\b/g, (_, numStr) => {
      const normalizedNum = numStr.replace(',', '.');
      const val = parseFloat(normalizedNum);
      if (Number.isInteger(val)) {
        return `${integerToTurkish(val)} milyon`;
      } else {
        const [intPart, decPart] = normalizedNum.split('.');
        const intWord = integerToTurkish(parseInt(intPart, 10));
        const decWord = integerToTurkish(parseInt(decPart, 10));
        return `${intWord} nokta ${decWord} milyon`;
      }
    });

    // Thousands (100K -> yüz bin; 4K video -> dört ka)
    spoken = spoken.replace(/\b4[kK]\b/g, 'dört ka');
    spoken = spoken.replace(/\b8[kK]\b/g, 'sekiz ka');
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*[kK]\b/g, (_, numStr) => {
      const normalizedNum = numStr.replace(',', '.');
      const val = parseFloat(normalizedNum);
      if (Number.isInteger(val)) {
        return `${integerToTurkish(val)} bin`;
      } else {
        return `${integerToTurkish(Math.round(val))} bin`;
      }
    });

    // 4. English Billion/Million words in mixed translations (e.g. "3.5 billion", "100 billion")
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*billion\b/gi, (_, numStr) => {
      const normalizedNum = numStr.replace(',', '.');
      const val = parseFloat(normalizedNum);
      if (Number.isInteger(val)) return `${integerToTurkish(val)} milyar`;
      const [intPart, decPart] = normalizedNum.split('.');
      return `${integerToTurkish(parseInt(intPart, 10))} nokta ${integerToTurkish(parseInt(decPart, 10))} milyar`;
    });
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*million\b/gi, (_, numStr) => {
      const normalizedNum = numStr.replace(',', '.');
      const val = parseFloat(normalizedNum);
      if (Number.isInteger(val)) return `${integerToTurkish(val)} milyon`;
      const [intPart, decPart] = normalizedNum.split('.');
      return `${integerToTurkish(parseInt(intPart, 10))} nokta ${integerToTurkish(parseInt(decPart, 10))} milyon`;
    });

    // 5. Currency Expressions ($100, 100$, 50€, 250₺, 250 TL)
    spoken = spoken.replace(/[$]\s*(\d+(?:[.,]\d+)?)/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} dolar`);
    spoken = spoken.replace(/(\d+(?:[.,]\d+)?)\s*[$]/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} dolar`);
    spoken = spoken.replace(/[€]\s*(\d+(?:[.,]\d+)?)/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} euro`);
    spoken = spoken.replace(/(\d+(?:[.,]\d+)?)\s*[€]/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} euro`);
    spoken = spoken.replace(/[₺]\s*(\d+(?:[.,]\d+)?)/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} lira`);
    spoken = spoken.replace(/(\d+(?:[.,]\d+)?)\s*[₺]/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} lira`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:TL|tl)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} lira`);

    // 6. Percentages (%50, 50%)
    spoken = spoken.replace(/%\s*(\d+(?:[.,]\d+)?)/g, (_, n) => `yüzde ${TurkishSpeechNormalizer.normalizeNumberString(n)}`);
    spoken = spoken.replace(/(\d+(?:[.,]\d+)?)\s*%/g, (_, n) => `yüzde ${TurkishSpeechNormalizer.normalizeNumberString(n)}`);

    // 7. Physical and Digital Units
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:GB|gb)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} gigabayt`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:MB|mb)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} megabayt`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:TB|tb)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} terabayt`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:kHz|khz)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} kilo hertz`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:Hz|hz)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} hertz`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:km|KM)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} kilometre`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:kg|KG)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} kilogram`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:ms|MS)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} milisaniye`);
    spoken = spoken.replace(/\b(\d+(?:[.,]\d+)?)\s*(?:sn|s)\b/g, (_, n) => `${TurkishSpeechNormalizer.normalizeNumberString(n)} saniye`);

    // 8. Pronunciation Lexicon replacement (boundary aware, suffix aware).
    // Longer phrases win, so "Meta AI" and "OpenAI" are not rewritten as a bare "AI".
    const profile = options?.profile ?? 'production';
    const lexicon = PRONUNCIATION_LEXICON
      .filter(entry => profile === 'candidate' || entry.status !== 'listening-candidate')
      .sort((a, b) => b.canonical.length - a.canonical.length);
    for (const entry of lexicon) {
      const flags = entry.caseSensitive ? 'g' : 'gi';
      const escaped = entry.canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      if (entry.canonical.includes('.')) {
        // For dotted acronyms like A.I., match with boundary or whitespace/punctuation
        const regex = new RegExp(`(?<=^|\\s|[(\\[])${escaped}(?=$|\\s|[.,!?:;)\\]])`, flags);
        spoken = spoken.replace(regex, entry.spoken);
      } else if (entry.matchMode === 'suffix_aware') {
        // Matches canonical optionally followed by apostrophe + suffix (e.g. AI'ın, MacBook'u)
        const regex = new RegExp(`\\b${escaped}(?:['’]([a-zA-ZçğıöşüÇĞİÖŞÜ]+))?\\b`, flags);
        spoken = spoken.replace(regex, (_, suffix) => {
          if (suffix) {
            return `${entry.spoken}'${suffix}`;
          }
          return entry.spoken;
        });
      } else {
        const regex = new RegExp(`\\b${escaped}\\b`, flags);
        spoken = spoken.replace(regex, entry.spoken);
      }
    }

    // 9. Ordinal numbers (1., 2., 3., etc.)
    spoken = spoken.replace(/\b(\d+)\.(?=\s|$|[A-Za-zçğıöşüÇĞİÖŞÜ])/g, (_, numStr) => {
      const val = parseInt(numStr, 10);
      if (val >= 1 && val <= 1000) {
        return ordinalToTurkish(val);
      }
      return `${integerToTurkish(val)}.`;
    });

    // 10. Floating-point and Decimal numbers (3.5, 0.05, 12,5)
    spoken = spoken.replace(/\b(\d+)[.,](\d+)\b/g, (_, intPart, decPart) => {
      const intNum = parseInt(intPart, 10);
      const decNum = parseInt(decPart, 10);
      if (decPart === '5' && intNum > 0) {
        return `${integerToTurkish(intNum)} buçuk`;
      }
      return `${integerToTurkish(intNum)} nokta ${integerToTurkish(decNum)}`;
    });

    // 11. Remaining standalone integers
    spoken = spoken.replace(/\b\d+\b/g, (match) => {
      const val = parseInt(match, 10);
      if (Number.isFinite(val)) {
        return integerToTurkish(val);
      }
      return match;
    });

    // 12. Restore protected placeholders
    for (const [key, replacement] of placeholders) {
      spoken = spoken.replace(key, replacement);
    }

    // 13. Clean up whitespace and non-speech symbols
    spoken = spoken
      .replace(/\s+/g, ' ')
      .replace(/["“”«»]/g, '')
      .replace(/\s+([.,!?:;])/g, '$1')
      .trim();

    return {
      displayText: trimmed,
      spokenText: spoken,
    };
  }

  private static normalizeNumberString(numStr: string): string {
    const clean = numStr.replace(',', '.');
    const val = parseFloat(clean);
    if (Number.isInteger(val)) {
      return integerToTurkish(val);
    }
    const [intPart, decPart] = clean.split('.');
    return `${integerToTurkish(parseInt(intPart, 10))} nokta ${integerToTurkish(parseInt(decPart, 10))}`;
  }
}
