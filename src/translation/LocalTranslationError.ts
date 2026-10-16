export type LocalTranslationReason = 'download' | 'hash' | 'runtime';

export class LocalTranslationError extends Error {
  readonly code = 'local_unavailable' as const;

  constructor(readonly reason: LocalTranslationReason) {
    super(localTranslationUserMessage(reason));
    this.name = 'LocalTranslationError';
  }
}

export class TranslationCancelledError extends Error {
  readonly code = 'cancelled' as const;

  constructor() {
    super('Local translation cancelled');
    this.name = 'TranslationCancelledError';
  }
}

export function isLocalTranslationError(error: unknown): error is LocalTranslationError {
  return error instanceof LocalTranslationError;
}

export function isTranslationCancelled(error: unknown): boolean {
  return error instanceof TranslationCancelledError;
}

export function localTranslationUserMessage(reason: LocalTranslationReason): string {
  const detail = reason === 'hash'
    ? 'The downloaded model failed its integrity check.'
    : reason === 'runtime'
      ? 'The model could not run in this browser.'
      : 'The model could not be downloaded.';
  return `Local translation unavailable. ${detail} Dubbing stopped and will not substitute English. Original video volume is restored. Captions were not sent to a cloud translator. There is no automatic resume.`;
}
