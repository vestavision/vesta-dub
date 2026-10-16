/**
 * Turkish Phonemizer for Piper TTS
 * Converts Turkish graphemes into IPA phonemes and maps to Piper phoneme IDs.
 * Follows the phonological rules of Turkish (e.g. vowel harmony, front/back velar palatalization,
 * yumuşak g lengthening, dotless ı -> ɯ, ö -> ø, ü -> y, ş -> ʃ, ç -> tʃ).
 */

export interface PiperVoiceConfig {
  phoneme_id_map: Record<string, number[]>;
  audio: { sample_rate: number };
  inference: {
    noise_scale: number;
    length_scale: number;
    noise_w: number;
  };
}

export class TurkishPhonemizer {
  private idMap: Record<string, number[]>;

  constructor(idMap: Record<string, number[]>) {
    this.idMap = idMap;
  }

  /**
   * Convert Turkish raw text to a list of IPA phonemes
   */
  phonemize(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();

    const phonemes: string[] = [];
    const len = normalized.length;

    for (let i = 0; i < len; i++) {
      const c = normalized[i];

      switch (c) {
        case ' ':
          phonemes.push(' ');
          break;
        case '.':
        case ',':
        case '!':
        case '?':
        case ':':
        case ';':
        case '-':
        case "'":
        case '"':
          phonemes.push(c);
          break;

        // Vowels
        case 'a':
        case 'â':
          phonemes.push('a');
          break;
        case 'e':
          phonemes.push('ɛ');
          break;
        case 'ı':
          phonemes.push('ɯ');
          break;
        case 'i':
        case 'î':
          phonemes.push('i');
          break;
        case 'o':
          phonemes.push('o');
          break;
        case 'ö':
          phonemes.push('ø');
          break;
        case 'u':
        case 'û':
          phonemes.push('u');
          break;
        case 'ü':
          phonemes.push('y');
          break;

        // Consonants
        case 'b':
          phonemes.push('b');
          break;
        case 'c':
          phonemes.push('d');
          phonemes.push('ʒ');
          break;
        case 'ç':
          phonemes.push('ç');
          break;
        case 'd':
          phonemes.push('d');
          break;
        case 'f':
          phonemes.push('f');
          break;
        case 'g':
          // Palatal before front vowels, velar otherwise
          if (i + 1 < len && 'eiöü'.includes(normalized[i + 1])) {
            phonemes.push('ɟ');
          } else {
            phonemes.push('ɡ');
          }
          break;
        case 'ğ':
          // Yumuşak g lengthens the preceding vowel or acts as glide
          if (phonemes.length > 0) {
            phonemes.push('ː');
          }
          break;
        case 'h':
          phonemes.push('h');
          break;
        case 'j':
          phonemes.push('ʒ');
          break;
        case 'k':
          phonemes.push('k');
          break;
        case 'l':
          // Velarized dark l after back vowels, clear l elsewhere
          if (i > 0 && 'aıou'.includes(normalized[i - 1])) {
            phonemes.push('ɫ');
          } else {
            phonemes.push('l');
          }
          break;
        case 'm':
          phonemes.push('m');
          break;
        case 'n':
          phonemes.push('n');
          break;
        case 'p':
          phonemes.push('p');
          break;
        case 'r':
          phonemes.push('r');
          break;
        case 's':
          phonemes.push('s');
          break;
        case 'ş':
          phonemes.push('ʃ');
          break;
        case 't':
          phonemes.push('t');
          break;
        case 'v':
          phonemes.push('v');
          break;
        case 'y':
          phonemes.push('j');
          break;
        case 'z':
          phonemes.push('z');
          break;

        default:
          if (this.idMap[c]) {
            phonemes.push(c);
          }
          break;
      }
    }

    return phonemes;
  }

  /**
   * Convert phoneme list into token IDs for Piper
   * Follows Piper VITS convention: BOS (1), then for each phoneme: IDs + PAD (0), ending with EOS (2).
   */
  phonemesToIds(phonemes: string[]): number[] {
    const BOS = 1;
    const EOS = 2;
    const PAD = 0;

    const ids: number[] = [BOS];

    for (const p of phonemes) {
      const mapped = this.idMap[p];
      if (mapped && mapped.length > 0) {
        ids.push(...mapped);
        ids.push(PAD);
      }
    }

    ids.push(EOS);
    return ids;
  }

  /**
   * Complete pipeline: Text -> Token IDs
   */
  textToIds(text: string): number[] {
    const phonemes = this.phonemize(text);
    return this.phonemesToIds(phonemes);
  }
}
