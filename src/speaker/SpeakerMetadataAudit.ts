/** Audit raw JSON3 before text cleaning. Fields are inventoried, never promoted to identity. */
export function auditJson3(data: any) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments = events.flatMap((e: any) => Array.isArray(e.segs) ? e.segs : []);
  const keys = (items: any[]) => [...new Set(items.flatMap(x => x && typeof x === 'object' ? Object.keys(x) : []))].sort();
  const marker = /(?:^|\n)\s*(?:>>|[-–—]\s|[A-Z][a-z]+(?: [A-Z][a-z]+)?:)/;
  return { topLevelKeys: keys([data]), eventCount: events.length, eventKeys: keys(events), segmentKeys: keys(segments),
    explicitSpeakerFields: [...keys(events), ...keys(segments)].filter(k => /speaker|voice|actor/i.test(k)),
    dialogueMarkerCueCount: events.filter((e: any) => marker.test((e.segs || []).map((s: any) => s.utf8 || '').join(''))).length,
    timedSegmentCount: segments.filter((s: any) => Number.isFinite(s.tOffsetMs)).length,
    // Layout/window IDs and punctuation have no speaker semantics here.
    usableSpeakerIdentity: false,
  };
}
