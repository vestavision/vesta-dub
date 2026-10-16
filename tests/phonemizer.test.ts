import { describe, it, expect } from 'vitest';
import { TurkishPhonemizer } from '../src/tts/TurkishPhonemizer';

describe('TurkishPhonemizer', () => {
  const sampleIdMap: Record<string, number[]> = {
    '_': [0],
    '^': [1],
    '$': [2],
    ' ': [3],
    'a': [14],
    'b': [15],
    'c': [16],
    'd': [17],
    'e': [18],
    'f': [19],
    'h': [20],
    'i': [21],
    'j': [22],
    'k': [23],
    'l': [24],
    'm': [25],
    'n': [26],
    'o': [27],
    'p': [28],
    'r': [30],
    's': [31],
    't': [32],
    'u': [33],
    'v': [34],
    'y': [37],
    'z': [38],
    'ç': [40],
    'ø': [42],
    'ɛ': [61],
    'ɟ': [64],
    'ɡ': [66],
    'ɯ': [79],
    'ʃ': [96],
    'ʒ': [108],
    'ː': [122],
    'ɫ': [75],
  };

  const phonemizer = new TurkishPhonemizer(sampleIdMap);

  it('should map Turkish specific vowels and consonants to IPA correctly', () => {
    // "ş" -> "ʃ", "ç" -> "ç", "ı" -> "ɯ", "ö" -> "ø", "ü" -> "y"
    const phonemes = phonemizer.phonemize('ışık');
    expect(phonemes).toContain('ɯ');
    expect(phonemes).toContain('ʃ');
    expect(phonemes).toContain('k');
  });

  it('should handle yumuşak g by lengthening the preceding vowel', () => {
    const phonemes = phonemizer.phonemize('dağ');
    expect(phonemes).toEqual(['d', 'a', 'ː']);
  });

  it('should palatalize g before front vowels', () => {
    const phonemesGel = phonemizer.phonemize('gel');
    expect(phonemesGel[0]).toBe('ɟ'); // front vowel e -> palatal ɟ

    const phonemesGar = phonemizer.phonemize('gar');
    expect(phonemesGar[0]).toBe('ɡ'); // back vowel a -> velar ɡ
  });

  it('should produce valid Piper token IDs sequence with BOS, PAD, and EOS', () => {
    const text = 'dağ';
    const ids = phonemizer.textToIds(text);

    // Should start with BOS (1)
    expect(ids[0]).toBe(1);
    // Should end with EOS (2)
    expect(ids[ids.length - 1]).toBe(2);

    // Should have PAD (0) after each mapped phoneme
    expect(ids).toContain(0);
  });
});
