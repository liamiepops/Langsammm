// Isolated-world content script.
//
// Two jobs. Inject page.js into the page's own realm, because Web Audio has to
// attach to the page's media elements. And act as the settings and wasm courier
// between the page realm and chrome.storage, since the page realm has no
// chrome.* and the page's CSP may refuse to fetch a chrome-extension: URL.

(() => {
  const BASE = chrome.runtime.getURL('');
  const TO_PAGE = 'slowform:to-page';
  const FROM_PAGE = 'slowform:from-page';

  function toPage(msg) {
    window.postMessage({ __slowform: TO_PAGE, ...msg }, '*');
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__slowform !== FROM_PAGE) return;

    if (d.type === 'hello') {
      toPage({ type: 'base', base: BASE });
      sendSettings();
      sendWasm();
    } else if (d.type === 'save') {
      chrome.storage.local.set({ settings: d.settings });
    }
  });

  function sendSettings() {
    chrome.storage.local.get('settings', (r) => {
      toPage({ type: 'settings', settings: r && r.settings ? r.settings : null });
    });
  }

  let wasmBytes = null;
  function sendWasm() {
    if (wasmBytes) {
      toPage({ type: 'wasm', bytes: wasmBytes.slice(0) });
      return;
    }
    fetch(BASE + 'slowform.wasm')
      .then((r) => r.arrayBuffer())
      .then((b) => {
        wasmBytes = b;
        toPage({ type: 'wasm', bytes: b.slice(0) });
      })
      .catch((e) => toPage({ type: 'wasm-error', message: String(e) }));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      toPage({ type: 'settings', settings: changes.settings.newValue, external: true });
    }
  });

  // Which route into the page's world this build uses.
  //
  // Chrome governs a content-script-injected script tag by the *extension's*
  // CSP, so the tag runs even on YouTube. Firefox governs it by the *page's*
  // CSP and blocks it (bugzilla 1267027, still open), but exempts a declarative
  // MAIN-world content script from page CSP instead. So each build declares the
  // route that works for it, and this reads the manifest to find out which,
  // rather than sniffing the browser.
  const declared = (chrome.runtime.getManifest().content_scripts || []).some(
    (cs) => cs.world === 'MAIN' && (cs.js || []).indexOf('page.js') !== -1
  );

  if (!declared) {
    const s = document.createElement('script');
    s.src = BASE + 'page.js';
    s.dataset.base = BASE;
    s.onload = () => s.remove();
    (document.head || document.documentElement).prepend(s);
  }
})();
