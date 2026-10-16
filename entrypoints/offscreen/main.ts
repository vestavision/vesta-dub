import { openExtensionBergamotPort } from '../../src/translation/BergamotSession';
import { IndexedDbTranslationCache } from '../../src/translation/LocalTranslationCache';
import { LocalTranslationEngine } from '../../src/translation/LocalTranslationEngine';
import { listenForOffscreenTranslation, OFFSCREEN_STATUS_PUSH } from '../../src/translation/OffscreenController';

const engine = new LocalTranslationEngine({
  cache: new IndexedDbTranslationCache(),
  openPort: openExtensionBergamotPort,
  onStatus: status => {
    // The service worker writes chrome.storage. A direct write from this document
    // did not reach the popup in Brave 155.
    void chrome.runtime.sendMessage({ type: OFFSCREEN_STATUS_PUSH, status }).catch(() => {});
  },
});

listenForOffscreenTranslation(engine);
