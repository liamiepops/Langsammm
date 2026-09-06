const DEFAULTS = {
  enabled: true,
  semitones: 3,
  midWet: 1.0,
  sideWet: 1.0,
  stereoMs: false,
  crossoverHz: 150,
  transient: 0,
  envResHz: 600,
  fftSize: 2048,
  loudnessMatch: true,
  panelOpen: true,
};

const enabledBtn = document.getElementById('enabled');
const panelBtn = document.getElementById('panel');
const semSel = document.getElementById('semitones');
const rateEl = document.getElementById('rate');

for (let s = 1; s <= 7; s++) {
  const o = document.createElement('option');
  o.value = String(s);
  o.textContent = '-' + s + ' st';
  semSel.append(o);
}

let state = Object.assign({}, DEFAULTS);

function render() {
  enabledBtn.className = state.enabled ? 'on' : '';
  panelBtn.className = state.panelOpen ? 'on' : '';
  panelBtn.textContent = state.panelOpen ? 'showing' : 'show';
  semSel.value = String(state.semitones);
  rateEl.textContent = (Math.pow(2, -state.semitones / 12) * 100).toFixed(2) + '%';
}

function commit() {
  chrome.storage.local.set({ settings: state });
  render();
}

chrome.storage.local.get('settings', (r) => {
  if (r && r.settings) Object.assign(state, r.settings);
  render();
});

enabledBtn.onclick = () => {
  state.enabled = !state.enabled;
  commit();
};
panelBtn.onclick = () => {
  state.panelOpen = !state.panelOpen;
  commit();
};
semSel.onchange = () => {
  state.semitones = parseFloat(semSel.value);
  commit();
};
