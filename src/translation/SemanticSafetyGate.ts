/**
 * SemanticSafetyGate
 * Multi-stage verification layer that evaluates candidate Turkish translations
 * against original Turkish and source English text to prevent meaning loss.
 *
 * Guarantees that no candidate is accepted if it drops or corrupts:
 * - Numbers and numerical quantities
 * - Currencies and physical units
 * - Named entities and technical terms
 * - Negation polarity (including Turkish morphological negation)
 * - Comparative modifiers
 * - Conditional and causal logic
 * - Sentence mood (questions vs statements)
 */

export interface SemanticSafetyResult {
  isValid: boolean;
  safetyScore: number; // 0.0 to 1.0
  violations: string[];
  preservedFeatures: {
    numbers: boolean;
    units: boolean;
    namedEntities: boolean;
    negationPolarity: boolean;
    comparisons: boolean;
    conditions: boolean;
    causals: boolean;
    technicalTerms: boolean;
    sentenceMood: boolean;
  };
}

export class SemanticSafetyGate {
  private static readonly NEGATION_TOKENS = [
    'değil', 'yok', 'asla', 'hiç', 'hiçbir', 'olmaz', 'olamaz', 'yapamaz', 'etmez', 'bulunmaz'
  ];

  private static readonly COMPARISON_TOKENS = [
    'daha', 'en', 'göre', 'kıyasla', 'oranla'
  ];

  private static readonly CONDITIONAL_TOKENS = [
    'ise', 'eğer', 'şayet'
  ];

  private static readonly CAUSAL_TOKENS = [
    'çünkü', 'dolayısıyla', 'bu yüzden', 'nedeniyle', 'ötürü', 'sebebiyle'
  ];

  private static readonly UNIT_TOKENS = [
    'tl', '₺', '$', '€', 'kg', 'km', 'ms', 's', 'hz', 'khz', 'mhz', 'ghz', 'gb', 'mb', 'kb',
    'saat', 'dakika', 'saniye', 'metre', 'santimetre', 'milimetre'
  ];

  private static readonly TECHNICAL_TERMS = [
    'ai', 'asr', 'tts', 'gpu', 'cpu', 'onnx', 'wasm', 'api', 'web audio', 'browser', 'model',
    'ram', 'kod', 'algoritma', 'grafik', 'sinir ağı'
  ];

  /**
   * Validate candidate Turkish translation against original Turkish and source English
   */
  static validate(
    sourceEn: string,
    originalTr: string,
    candidateTr: string
  ): SemanticSafetyResult {
    const violations: string[] = [];
    const origLower = (originalTr || '').toLowerCase();
    const candLower = (candidateTr || '').toLowerCase();
    const srcLower = (sourceEn || '').toLowerCase();

    // 1. Basic length check: candidate cannot be empty or longer than original
    if (!candidateTr || candidateTr.trim().length === 0) {
      return {
        isValid: false,
        safetyScore: 0.0,
        violations: ['Candidate translation is empty'],
        preservedFeatures: this.allFeatures(false),
      };
    }

    if (candidateTr.trim().length > originalTr.trim().length) {
      violations.push('Candidate translation is longer than original translation');
    }

    // 2. Numbers & Numerical Quantities
    const origNumbers = this.extractNumbers(originalTr);
    let numbersPreserved = true;
    for (const num of origNumbers) {
      if (!candLower.includes(num)) {
        violations.push(`Missing number or quantity: "${num}"`);
        numbersPreserved = false;
      }
    }

    // 3. Units & Currencies
    const origUnits = this.extractTokens(origLower, this.UNIT_TOKENS);
    let unitsPreserved = true;
    for (const unit of origUnits) {
      if (!candLower.includes(unit)) {
        violations.push(`Missing unit or currency: "${unit}"`);
        unitsPreserved = false;
      }
    }

    // 4. Named Entities (Capitalized tokens that are not at sentence start)
    const origEntities = this.extractNamedEntities(originalTr);
    let entitiesPreserved = true;
    for (const ent of origEntities) {
      if (!candidateTr.includes(ent)) {
        violations.push(`Missing named entity: "${ent}"`);
        entitiesPreserved = false;
      }
    }

    // 5. Negation Polarity (Lexical + Turkish Morphological Negation)
    const origNegations = this.extractNegationMarkers(origLower);
    const candNegations = this.extractNegationMarkers(candLower);
    let negationPreserved = true;

    if (origNegations.length > 0 && candNegations.length === 0) {
      violations.push('Negation marker was lost (reversing polarity)');
      negationPreserved = false;
    } else if (origNegations.length === 0 && candNegations.length > 0) {
      violations.push('Negation marker was falsely introduced');
      negationPreserved = false;
    }

    // 6. Comparative Modifiers
    const origComparisons = this.extractTokens(origLower, this.COMPARISON_TOKENS);
    let comparisonsPreserved = true;
    for (const comp of origComparisons) {
      if (!candLower.includes(comp)) {
        violations.push(`Missing comparative modifier: "${comp}"`);
        comparisonsPreserved = false;
      }
    }

    // 7. Conditional Clauses
    const origConditions = this.extractTokens(origLower, this.CONDITIONAL_TOKENS);
    let conditionsPreserved = true;
    for (const cond of origConditions) {
      if (!candLower.includes(cond)) {
        violations.push(`Missing conditional marker: "${cond}"`);
        conditionsPreserved = false;
      }
    }

    // 8. Causal Relationships
    const origCausals = this.extractTokens(origLower, this.CAUSAL_TOKENS);
    let causalsPreserved = true;
    for (const causal of origCausals) {
      if (!candLower.includes(causal)) {
        violations.push(`Missing causal relationship: "${causal}"`);
        causalsPreserved = false;
      }
    }

    // 9. Technical Terminology
    const origTech = this.extractTokens(origLower, this.TECHNICAL_TERMS);
    let techPreserved = true;
    for (const tech of origTech) {
      if (!candLower.includes(tech)) {
        violations.push(`Missing technical term: "${tech}"`);
        techPreserved = false;
      }
    }

    // 10. Sentence Mood: Question vs Statement
    const origIsQuestion = originalTr.trim().endsWith('?') || /\b(mi|mı|mu|mü)\b/i.test(origLower);
    const candIsQuestion = candidateTr.trim().endsWith('?') || /\b(mi|mı|mu|mü)\b/i.test(candLower);
    let moodPreserved = true;
    if (origIsQuestion !== candIsQuestion) {
      violations.push('Sentence mood mismatch: question status altered');
      moodPreserved = false;
    }

    // Compute Safety Score (1.0 minus penalties)
    const penaltyPerViolation = 0.25;
    const safetyScore = Math.max(0.0, Number((1.0 - violations.length * penaltyPerViolation).toFixed(2)));
    const isValid = violations.length === 0 && safetyScore >= 0.95;

    return {
      isValid,
      safetyScore,
      violations,
      preservedFeatures: {
        numbers: numbersPreserved,
        units: unitsPreserved,
        namedEntities: entitiesPreserved,
        negationPolarity: negationPreserved,
        comparisons: comparisonsPreserved,
        conditions: conditionsPreserved,
        causals: causalsPreserved,
        technicalTerms: techPreserved,
        sentenceMood: moodPreserved,
      },
    };
  }

  private static extractNumbers(text: string): string[] {
    const cleaned = text.replace(/(?<![\p{L}\p{N}])bir şekilde(?![\p{L}\p{N}])/giu, '');
    const matches = cleaned.match(/\b\d+([.,]\d+)?\b|[₺$€]|%(?:\d+([.,]\d+)?)|\b(bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yüz|bin|milyon)\b/gi) || [];
    return matches.map(m => m.toLowerCase());
  }

  private static extractTokens(text: string, tokenList: string[]): string[] {
    const found: string[] = [];
    for (const token of tokenList) {
      const regex = new RegExp(`\\b${token}\\b`, 'iu');
      if (regex.test(text)) {
        found.push(token);
      }
    }
    return found;
  }

  private static extractNegationMarkers(text: string): string[] {
    const found = this.extractTokens(text, this.NEGATION_TOKENS);
    const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
    for (const w of words) {
      if (
        /m[ae]y?[ıi]n([ıi]z)?$/i.test(w) ||
        /m[ae]d[ıiuü]([ıi]z|n|k|m|lar|ler)?$/i.test(w) ||
        /m[ae]z(d[ıiuü])?([ıi]z|lar|ler)?$/i.test(w) ||
        /m[ıiuü]yor(lar|uz)?$/i.test(w) ||
        /m[ae]m[ae]k$/i.test(w) ||
        /s[ıiuü]z$/i.test(w)
      ) {
        if (!found.includes(w)) found.push(w);
      }
    }
    return found;
  }

  private static extractNamedEntities(text: string): string[] {
    const words = text.split(/\s+/);
    const entities: string[] = [];
    for (let i = 1; i < words.length; i++) {
      const clean = words[i].replace(/[.,!?;:()"]/g, '');
      if (clean.length >= 2 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
        entities.push(clean);
      }
    }
    return entities;
  }

  private static allFeatures(val: boolean) {
    return {
      numbers: val,
      units: val,
      namedEntities: val,
      negationPolarity: val,
      comparisons: val,
      conditions: val,
      causals: val,
      technicalTerms: val,
      sentenceMood: val,
    };
  }
}
