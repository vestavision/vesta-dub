import { describe, it, expect } from 'vitest';
import { SemanticSafetyGate } from '../../src/translation/SemanticSafetyGate';

describe('SemanticSafetyGate', () => {
  it('passes semantically equivalent reductions with preserved protected elements', () => {
    const srcEn = 'Right now, we are really testing local models.';
    const origTr = 'Şu anda gerçekten de yerel modelleri test ediyoruz.';
    const candTr = 'Şimdi gerçekten yerel modelleri test ediyoruz.';

    const res = SemanticSafetyGate.validate(srcEn, origTr, candTr);
    expect(res.isValid).toBe(true);
    expect(res.safetyScore).toBe(1.0);
    expect(res.violations.length).toBe(0);
  });

  it('rejects candidate if negation polarity is reversed', () => {
    const srcEn = 'This method is not suitable.';
    const origTr = 'Bu yöntem kesinlikle uygun değil.';
    const candTr = 'Bu yöntem kesinlikle uygun.'; // Dropped "değil"

    const res = SemanticSafetyGate.validate(srcEn, origTr, candTr);
    expect(res.isValid).toBe(false);
    expect(res.violations).toContain('Negation marker was lost (reversing polarity)');
    expect(res.preservedFeatures.negationPolarity).toBe(false);
  });

  it('rejects candidate if numbers or currencies are missing', () => {
    const srcEn = 'Total cost is 1,250 TL with 18% VAT.';
    const origTr = 'Toplam maliyet 1.250 TL olup %18 KDV uygulanır.';
    const candTr = 'Toplam maliyet TL olup KDV uygulanır.'; // Dropped numbers

    const res = SemanticSafetyGate.validate(srcEn, origTr, candTr);
    expect(res.isValid).toBe(false);
    expect(res.preservedFeatures.numbers).toBe(false);
  });

  it('rejects candidate if conditional or causal logic is removed', () => {
    const srcEn = 'If the server fails, restart.';
    const origTr = 'Eğer sunucu yanıt vermez ise sistemi baştan başlatın.';
    const candTr = 'Sunucu yanıt vermez sistemi baştan başlatın.'; // Dropped "eğer" & "ise"

    const res = SemanticSafetyGate.validate(srcEn, origTr, candTr);
    expect(res.isValid).toBe(false);
    expect(res.preservedFeatures.conditions).toBe(false);
  });

  it('rejects candidate if sentence mood is altered (question to statement)', () => {
    const srcEn = 'Can we reproduce this speed?';
    const origTr = 'Biz de bu hızı tekrarlayabilir miyiz?';
    const candTr = 'Biz de bu hızı tekrarlayabiliriz.'; // Statement instead of question

    const res = SemanticSafetyGate.validate(srcEn, origTr, candTr);
    expect(res.isValid).toBe(false);
    expect(res.preservedFeatures.sentenceMood).toBe(false);
  });
});
