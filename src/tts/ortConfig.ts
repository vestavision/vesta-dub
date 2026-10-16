import * as ort from 'onnxruntime-web';

let configured = false;

export function configureOrt(): void {
  if (configured) return;
  configured = true;

  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    try {
      const rootUrl = chrome.runtime.getURL('');
      const wasmDir = chrome.runtime.getURL('wasm/');
      // Configure both base directory and individual wasm paths
      ort.env.wasm.wasmPaths = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`;
      ort.env.wasm.simd = true;
      console.log('[VestaDub] ONNX Runtime WebAssembly configured with local extension bundle:', rootUrl);
    } catch (e) {
      console.warn('[VestaDub] Failed to set ONNX wasm path:', e);
    }
  }
}
