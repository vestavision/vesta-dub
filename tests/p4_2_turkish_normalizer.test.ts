import { describe, it, expect } from 'vitest';
import {
  TurkishSpeechNormalizer,
  integerToTurkish,
  ordinalToTurkish,
} from '../src/tts/TurkishSpeechNormalizer';
import { PRONUNCIATION_LEXICON } from '../src/tts/pronunciationLexicon';
import { ANTALIA_SYMBOLS } from '../src/tts/AntaliaEngine';

describe('P4.2 Turkish Speech Normalizer & Pronunciation Lexicon Suite', () => {
  describe('1. Cardinal & Ordinal Integer Expansion', () => {
    it('correctly expands single digits', () => {
      expect(integerToTurkish(0)).toBe('sıfır');
      expect(integerToTurkish(1)).toBe('bir');
      expect(integerToTurkish(5)).toBe('beş');
      expect(integerToTurkish(9)).toBe('dokuz');
    });

    it('correctly expands tens and compound numbers', () => {
      expect(integerToTurkish(10)).toBe('on');
      expect(integerToTurkish(21)).toBe('yirmi bir');
      expect(integerToTurkish(50)).toBe('elli');
      expect(integerToTurkish(99)).toBe('doksan dokuz');
    });

    it('correctly applies Turkish hundred and thousand conventions (no "bir yüz" or "bir bin")', () => {
      expect(integerToTurkish(100)).toBe('yüz');
      expect(integerToTurkish(200)).toBe('iki yüz');
      expect(integerToTurkish(1000)).toBe('bin');
      expect(integerToTurkish(2000)).toBe('iki bin');
      expect(integerToTurkish(2026)).toBe('iki bin yirmi altı');
      expect(integerToTurkish(5060)).toBe('beş bin altmış');
    });

    it('correctly expands millions, billions, and trillions', () => {
      expect(integerToTurkish(1_000_000)).toBe('bir milyon');
      expect(integerToTurkish(10_000_000)).toBe('on milyon');
      expect(integerToTurkish(1_000_000_000)).toBe('bir milyar');
      expect(integerToTurkish(100_000_000_000)).toBe('yüz milyar');
    });

    it('correctly generates Turkish ordinals with phonological harmony', () => {
      expect(ordinalToTurkish(1)).toBe('birinci');
      expect(ordinalToTurkish(2)).toBe('ikinci');
      expect(ordinalToTurkish(3)).toBe('üçüncü');
      expect(ordinalToTurkish(4)).toBe('dördüncü');
      expect(ordinalToTurkish(5)).toBe('beşinci');
      expect(ordinalToTurkish(6)).toBe('altıncı');
      expect(ordinalToTurkish(7)).toBe('yedinci');
      expect(ordinalToTurkish(8)).toBe('sekizinci');
      expect(ordinalToTurkish(9)).toBe('dokuzuncu');
      expect(ordinalToTurkish(10)).toBe('onuncu');
      expect(ordinalToTurkish(20)).toBe('yirminci');
    });
  });

  describe('2. User-Reported Production Failures', () => {
    it('Issue 1: 100B expands to "yüz milyar" instead of dropping digits to "B"', () => {
      const res = TurkishSpeechNormalizer.normalize('100B parametreli model');
      expect(res.displayText).toBe('100B parametreli model');
      expect(res.spokenText).toBe('yüz milyar parametreli model');
      expect(res.spokenText).not.toMatch(/\b100\b/);
      expect(res.spokenText).not.toMatch(/\bB\b/);
    });

    it('Issue 2: AI expands to "ey ay" instead of Turkish letter phonemes', () => {
      const res = TurkishSpeechNormalizer.normalize('AI araştırmacıları yeni bir yöntem buldu.');
      expect(res.displayText).toBe('AI araştırmacıları yeni bir yöntem buldu.');
      expect(res.spokenText).toBe('ey ay araştırmacıları yeni bir yöntem buldu.');
    });

    it('lowercase ai from machine translation still expands, while Turkish ay does not', () => {
      expect(TurkishSpeechNormalizer.normalize('Bu bir ai modeli.').spokenText).toBe('Bu bir ey ay modeli.');
      expect(TurkishSpeechNormalizer.normalize('Bu ay yeni bir model geldi.').spokenText).toBe('Bu ay yeni bir model geldi.');
      expect(TurkishSpeechNormalizer.normalize('Meta AI duyuruldu.').spokenText).toBe('meta ey ay duyuruldu.');
    });

    it('Issue 3: MacBook expands to Antalia-validated "mekbuk"', () => {
      const res = TurkishSpeechNormalizer.normalize('Yeni MacBook Pro tanıtıldı.');
      expect(res.displayText).toBe('Yeni MacBook Pro tanıtıldı.');
      expect(res.spokenText).toBe('Yeni mekbuk Pro tanıtıldı.');
    });
  });

  describe('3. Technology Acronyms & Model Designators', () => {
    it('normalizes compound model names like GPT-4, GPT-4o, GPT-3.5', () => {
      expect(TurkishSpeechNormalizer.normalize('GPT-4 modeli').spokenText).toBe('ci pi ti dört modeli');
      expect(TurkishSpeechNormalizer.normalize('GPT-4o sürümü').spokenText).toBe('ci pi ti dört o sürümü');
      expect(TurkishSpeechNormalizer.normalize('GPT-3.5 mimarisi').spokenText).toBe('ci pi ti üç buçuk mimarisi');
    });

    it('normalizes graphics and hardware designators (RTX 5060)', () => {
      const res = TurkishSpeechNormalizer.normalize('Nvidia RTX 5060 ekran kartı');
      expect(res.spokenText).toBe('envidya ar ti eks beş bin altmış ekran kartı');
    });

    it('normalizes core technical acronyms', () => {
      expect(TurkishSpeechNormalizer.normalize('LLM ve AGI çalışmaları').spokenText).toBe('el el em ve ey ci ay çalışmaları');
      expect(TurkishSpeechNormalizer.normalize('GPU ve CPU hızlandırma').spokenText).toBe('ci pi yu ve si pi yu hızlandırma');
      expect(TurkishSpeechNormalizer.normalize('REST API ve SDK dokümantasyonu').spokenText).toBe('REST ey pi ay ve es di key dokümantasyonu');
      expect(TurkishSpeechNormalizer.normalize('UI ve UX tasarımı').spokenText).toBe('yu ay ve yu eks tasarımı');
    });

    it('preserves Turkish apostrophe suffixes on acronyms', () => {
      expect(TurkishSpeechNormalizer.normalize("AI'ın gücü").spokenText).toBe("ey ay'ın gücü");
      expect(TurkishSpeechNormalizer.normalize("GPT'ye sordum").spokenText).toBe("ci pi ti'ye sordum");
      expect(TurkishSpeechNormalizer.normalize("MacBook'u açtım").spokenText).toBe("mekbuk'u açtım");
    });
  });

  describe('4. Currencies, Percentages & Measurements', () => {
    it('normalizes currencies in prefix and suffix notation', () => {
      expect(TurkishSpeechNormalizer.normalize('$100 harcadık').spokenText).toBe('yüz dolar harcadık');
      expect(TurkishSpeechNormalizer.normalize('Fiyatı 50€ oldu').spokenText).toBe('Fiyatı elli euro oldu');
      expect(TurkishSpeechNormalizer.normalize('Ücret 250 TL').spokenText).toBe('Ücret iki yüz elli lira');
      expect(TurkishSpeechNormalizer.normalize('Toplam 250₺').spokenText).toBe('Toplam iki yüz elli lira');
    });

    it('normalizes percentages with Turkish prefix order', () => {
      expect(TurkishSpeechNormalizer.normalize('%50 indirim').spokenText).toBe('yüzde elli indirim');
      expect(TurkishSpeechNormalizer.normalize('50% tamamlandı').spokenText).toBe('yüzde elli tamamlandı');
      expect(TurkishSpeechNormalizer.normalize('%3.5 oran').spokenText).toBe('yüzde üç nokta beş oran');
    });

    it('normalizes physical and digital measurement units', () => {
      expect(TurkishSpeechNormalizer.normalize('100 km yol').spokenText).toBe('yüz kilometre yol');
      expect(TurkishSpeechNormalizer.normalize('5 kg ağırlık').spokenText).toBe('beş kilogram ağırlık');
      expect(TurkishSpeechNormalizer.normalize('16 GB bellek ve 512 MB önbellek').spokenText).toBe('on altı gigabayt bellek ve beş yüz on iki megabayt önbellek');
      expect(TurkishSpeechNormalizer.normalize('48 kHz ses').spokenText).toBe('kırk sekiz kilo hertz ses');
      expect(TurkishSpeechNormalizer.normalize('10 ms gecikme').spokenText).toBe('on milisaniye gecikme');
    });
  });

  describe('5. Decimals & Magnitude Context', () => {
    it('normalizes decimal numbers and buçuk convention', () => {
      expect(TurkishSpeechNormalizer.normalize('3.5').spokenText).toBe('üç buçuk');
      expect(TurkishSpeechNormalizer.normalize('3.5 billion').spokenText).toBe('üç nokta beş milyar');
      expect(TurkishSpeechNormalizer.normalize('0.01 saniye').spokenText).toBe('sıfır nokta bir saniye');
    });

    it('handles model scale magnitudes across K, M, B', () => {
      expect(TurkishSpeechNormalizer.normalize('Llama 3 70B modeli').spokenText).toBe('lama üç yetmiş milyar modeli');
      expect(TurkishSpeechNormalizer.normalize('7B parametre').spokenText).toBe('yedi milyar parametre');
      expect(TurkishSpeechNormalizer.normalize('10M indirme').spokenText).toBe('on milyon indirme');
      expect(TurkishSpeechNormalizer.normalize('100K takipçi').spokenText).toBe('yüz bin takipçi');
      expect(TurkishSpeechNormalizer.normalize('4K video çözünürlüğü').spokenText).toBe('dört ka video çözünürlüğü');
    });
  });

  describe('6. Contract & Vocabulary Compliance', () => {
    it('guarantees displayText is strictly preserved as original Turkish', () => {
      const inputs = [
        '100B parametreli AI modeli.',
        'MacBook Pro üzerinde RTX test edildi.',
        '%25 indirimle 150 TL ödedik.',
      ];
      for (const input of inputs) {
        const res = TurkishSpeechNormalizer.normalize(input);
        expect(res.displayText).toBe(input);
      }
    });

    it('ensures spoken output contains only valid characters for Antalia vocabulary', () => {
      const validSymbolSet = new Set(ANTALIA_SYMBOLS);
      const testSentence = '100B parametreli AI sistemi MacBook Pro üzerinde 48 kHz ses ve %99 doğrulukla çalışıyor.';
      const res = TurkishSpeechNormalizer.normalize(testSentence);

      for (const char of res.spokenText.toLowerCase()) {
        if (!validSymbolSet.has(char)) {
          throw new Error(`Invalid symbol '${char}' found in spoken text: "${res.spokenText}"`);
        }
      }
    });
  });

  describe('7. Targeted Pronunciation Corpus (100 Representative Examples)', () => {
    const corpus = [
      // Numbers & Cardinals
      ['0', 'sıfır'],
      ['1', 'bir'],
      ['2', 'iki'],
      ['3', 'üç'],
      ['4', 'dört'],
      ['5', 'beş'],
      ['6', 'altı'],
      ['7', 'yedi'],
      ['8', 'sekiz'],
      ['9', 'dokuz'],
      ['10', 'on'],
      ['15', 'on beş'],
      ['20', 'yirmi'],
      ['25', 'yirmi beş'],
      ['30', 'otuz'],
      ['42', 'kırk iki'],
      ['50', 'elli'],
      ['64', 'altmış dört'],
      ['75', 'yetmiş beş'],
      ['88', 'seksen sekiz'],
      ['99', 'doksan dokuz'],
      ['100', 'yüz'],
      ['105', 'yüz beş'],
      ['250', 'iki yüz elli'],
      ['500', 'beş yüz'],
      ['1000', 'bin'],
      ['1500', 'bin beş yüz'],
      ['2024', 'iki bin yirmi dört'],
      ['2026', 'iki bin yirmi altı'],
      ['5060', 'beş bin altmış'],
      ['10000', 'on bin'],
      ['100000', 'yüz bin'],
      ['1000000', 'bir milyon'],
      // Ordinals
      ['1.', 'birinci'],
      ['2.', 'ikinci'],
      ['3.', 'üçüncü'],
      ['4.', 'dördüncü'],
      ['5.', 'beşinci'],
      ['10.', 'onuncu'],
      // Percentages
      ['%10', 'yüzde on'],
      ['%25', 'yüzde yirmi beş'],
      ['%50', 'yüzde elli'],
      ['%75', 'yüzde yetmiş beş'],
      ['%100', 'yüzde yüz'],
      ['10%', 'yüzde on'],
      ['50%', 'yüzde elli'],
      // Currencies
      ['$10', 'on dolar'],
      ['$50', 'elli dolar'],
      ['$100', 'yüz dolar'],
      ['100$', 'yüz dolar'],
      ['50€', 'elli euro'],
      ['100 TL', 'yüz lira'],
      ['250₺', 'iki yüz elli lira'],
      // Units
      ['1 km', 'bir kilometre'],
      ['10 km', 'on kilometre'],
      ['5 kg', 'beş kilogram'],
      ['20 ms', 'yirmi milisaniye'],
      ['60 s', 'altmış saniye'],
      ['48 kHz', 'kırk sekiz kilo hertz'],
      ['16 GB', 'on altı gigabayt'],
      ['512 MB', 'beş yüz on iki megabayt'],
      ['1 TB', 'bir terabayt'],
      // Magnitudes
      ['1B', 'bir milyar'],
      ['7B', 'yedi milyar'],
      ['8B', 'sekiz milyar'],
      ['70B', 'yetmiş milyar'],
      ['100B', 'yüz milyar'],
      ['405B', 'dört yüz beş milyar'],
      ['10M', 'on milyon'],
      ['50M', 'elli milyon'],
      ['100K', 'yüz bin'],
      ['4K', 'dört ka'],
      // Acronyms
      ['AI', 'ey ay'],
      ['A.I.', 'ey ay'],
      ['LLM', 'el el em'],
      ['LLMs', 'el el emler'],
      ['GPT', 'ci pi ti'],
      ['AGI', 'ey ci ay'],
      ['GPU', 'ci pi yu'],
      ['CPU', 'si pi yu'],
      ['API', 'ey pi ay'],
      ['SDK', 'es di key'],
      ['UI', 'yu ay'],
      ['UX', 'yu eks'],
      ['ML', 'em el'],
      ['NLP', 'en el pi'],
      ['RL', 'ar el'],
      ['TTS', 'ti ti es'],
      ['ASR', 'ey es ar'],
      ['RAM', 'rem'],
      ['SSD', 'es es di'],
      ['USB', 'yu es bi'],
      ['URL', 'yu ar el'],
      ['IP', 'ay pi'],
      ['HTTP', 'eyç ti ti pi'],
      ['HTTPS', 'eyç ti ti pi es'],
      ['JSON', 'ceysın'],
      ['HTML', 'eyç ti em el'],
      ['CSS', 'si es es'],
      ['SQL', 'es kü el'],
      ['WASM', 'vasım'],
      ['CLI', 'si el ay'],
      ['GUI', 'gu i'],
      // Brands & Models
      ['MacBook', 'mekbuk'],
      ['Macbook', 'mekbuk'],
      ['iPhone', 'ayfon'],
      ['iPad', 'ayped'],
      ['Apple', 'epıl'],
      ['Google', 'gugıl'],
      ['Microsoft', 'maykrosoft'],
      ['YouTube', 'yutub'],
      ['OpenAI', 'opın ey ay'],
      ['DeepMind', 'dip maynd'],
      ['ChatGPT', 'çet ci pi ti'],
      ['Claude', 'klod'],
      ['Gemini', 'cemini'],
      ['GitHub', 'githap'],
      ['Docker', 'dokır'],
      ['Kubernetes', 'kübernitis'],
      ['Python', 'paytın'],
      ['JavaScript', 'cavasikript'],
      ['TypeScript', 'taypsikript'],
      ['Rust', 'rast'],
      ['Chrome', 'krom'],
      ['Brave', 'breyv'],
      ['GPT-4', 'ci pi ti dört'],
      ['GPT-4o', 'ci pi ti dört o'],
      ['RTX 5060', 'ar ti eks beş bin altmış'],
    ];

    it(`verifies all ${corpus.length} representative corpus items`, () => {
      expect(corpus.length).toBeGreaterThanOrEqual(100);
      let successCount = 0;
      for (const [input, expected] of corpus) {
        const res = TurkishSpeechNormalizer.normalize(input);
        expect(res.spokenText.toLowerCase()).toBe(expected.toLowerCase());
        successCount++;
      }
      expect(successCount).toBe(corpus.length);
    });
  });
});
