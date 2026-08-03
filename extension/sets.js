// The set editor. Runs as an extension page, so it talks to chrome.storage
// directly and any playing tab picks the changes up through storage.onChanged.

const PARAM_KEYS = [
  'semitones', 'midWet', 'sideWet', 'stereoMs', 'crossoverHz',
  'transient', 'envResHz', 'fftSize', 'loudnessMatch',
];

let sets = [];
let active = null;
let selected = null;

const $ = (id) => document.getElementById(id);
const msg = (t) => ($('msg').textContent = t || '');

function load() {
  chrome.storage.local.get(['sets', 'active'], (r) => {
    sets = (r && r.sets) || [];
    active = (r && r.active) || null;
    if (!sets.some((s) => s.id === selected)) selected = sets.length ? sets[0].id : null;
    render();
  });
}

function save() {
  chrome.storage.local.set({ sets, active });
}

const current = () => sets.find((s) => s.id === selected) || null;

// A short line describing what a track will sound like, so the list is
// readable without opening anything.
function summarise(p) {
  if (!p) return 'defaults';
  const bits = [];
  bits.push('-' + (p.semitones === undefined ? 3 : p.semitones) + ' st');
  const amt = p.midWet === undefined ? 1 : p.midWet;
  if (amt !== 1) bits.push(Math.round(amt * 100) + '%');
  bits.push((p.envResHz === undefined ? 600 : p.envResHz) + ' Hz');
  const xo = p.crossoverHz === undefined ? 150 : p.crossoverHz;
  if (xo > 0) bits.push('xo ' + xo);
  if (p.transient) bits.push('tr ' + Math.round(p.transient * 100) + '%');
  if (p.stereoMs) bits.push('m/s');
  return bits.join('  ');
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) {
    if (c == null || c === false) continue;
    e.append(typeof c === 'object' ? c : String(c));
  }
  return e;
}

function renderList() {
  const box = $('setlist');
  box.textContent = '';
  if (!sets.length) {
    box.append(el('div', { class: 'empty' }, 'No sets yet.'));
    return;
  }
  for (const s of sets) {
    const on = active && active.setId === s.id;
    box.append(
      el(
        'button',
        { class: s.id === selected ? 'on' : '', onclick: () => { selected = s.id; render(); } },
        el('span', { class: 'n' }, (on ? '▶ ' : '') + (s.name || 'untitled')),
        el('span', { class: 'c' }, String(s.items.length))
      )
    );
  }
}

function move(i, delta) {
  const s = current();
  const j = i + delta;
  if (j < 0 || j >= s.items.length) return;
  const [it] = s.items.splice(i, 1);
  s.items.splice(j, 0, it);
  save();
  render();
}

function renderItems() {
  const box = $('items');
  box.textContent = '';
  const s = current();
  if (!s) {
    box.append(el('div', { class: 'empty' }, 'Select or create a set.'));
    return;
  }
  if (!s.items.length) {
    box.append(
      el(
        'div',
        { class: 'empty' },
        'Empty. Make this set active, play a track, dial it in, then press add in the panel.'
      )
    );
    return;
  }

  const body = el('tbody');
  s.items.forEach((it, i) => {
    body.append(
      el(
        'tr',
        {},
        el('td', { class: 'i' }, String(i + 1)),
        el(
          'td',
          { class: 't' },
          it.url
            ? el('a', { href: it.url, target: '_blank', rel: 'noreferrer' }, it.title || it.key)
            : it.title || it.key
        ),
        el('td', { class: 'p' }, summarise(it.params)),
        el(
          'td',
          { class: 'act' },
          el('button', { class: 'tiny', title: 'move up', onclick: () => move(i, -1) }, '↑'),
          el('button', { class: 'tiny', title: 'move down', onclick: () => move(i, 1) }, '↓'),
          el(
            'button',
            {
              class: 'tiny danger',
              title: 'remove',
              onclick: () => {
                s.items.splice(i, 1);
                save();
                render();
              },
            },
            '×'
          )
        )
      )
    );
  });

  const table = el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, '#'),
        el('th', {}, 'Track'),
        el('th', {}, 'Settings'),
        el('th', {}, '')
      )
    ),
    body
  );
  box.append(table);
}

function render() {
  renderList();
  renderItems();
  const s = current();
  $('name').value = s ? s.name || '' : '';
  $('name').disabled = !s;
  $('activate').disabled = !s;
  $('delset').disabled = !s;
  $('export').disabled = !s;
  const isActive = !!(s && active && active.setId === s.id);
  $('activate').textContent = isActive ? 'Active' : 'Make active';
  $('activate').className = isActive ? 'primary' : '';
  const auto = !!(active && active.autoAdvance);
  $('auto').textContent = auto ? 'on' : 'off';
  $('auto').className = auto ? 'tiny on' : 'tiny';
}

$('newset').onclick = () => {
  const id = 's' + Date.now().toString(36);
  sets.push({ id, name: 'Set ' + (sets.length + 1), items: [] });
  selected = id;
  save();
  render();
  $('name').focus();
};

$('name').oninput = () => {
  const s = current();
  if (!s) return;
  s.name = $('name').value;
  save();
  renderList();
};

$('activate').onclick = () => {
  const s = current();
  if (!s) return;
  const isActive = active && active.setId === s.id;
  active = isActive
    ? { setId: null, autoAdvance: !!(active && active.autoAdvance) }
    : { setId: s.id, autoAdvance: !!(active && active.autoAdvance) };
  save();
  render();
  msg(isActive ? 'No set is running.' : 'Playing tabs will follow this set.');
};

$('delset').onclick = () => {
  const s = current();
  if (!s) return;
  if (!confirm('Delete "' + (s.name || 'untitled') + '" and its ' + s.items.length + ' items?')) return;
  sets = sets.filter((x) => x.id !== s.id);
  if (active && active.setId === s.id) active = { setId: null, autoAdvance: active.autoAdvance };
  selected = sets.length ? sets[0].id : null;
  save();
  render();
};

$('auto').onclick = () => {
  active = { setId: (active && active.setId) || null, autoAdvance: !(active && active.autoAdvance) };
  save();
  render();
  msg(
    active.autoAdvance
      ? 'The tab will move to the next track when one ends. Adverts are skipped over.'
      : ''
  );
};

$('export').onclick = () => {
  const s = current();
  if (!s) return;
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (s.name || 'set').replace(/[^\w -]+/g, '') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('import').onclick = () => $('file').click();

$('file').onchange = () => {
  const f = $('file').files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    let data;
    try {
      data = JSON.parse(rd.result);
    } catch (e) {
      msg('That file is not JSON.');
      return;
    }
    if (!data || !Array.isArray(data.items)) {
      msg('That file has no items array, so it is not a set.');
      return;
    }
    // Rebuild rather than trust: only known fields, and only known parameters.
    const items = data.items
      .filter((it) => it && (it.key || it.url))
      .map((it) => {
        const p = {};
        for (const k of PARAM_KEYS) if (it.params && it.params[k] !== undefined) p[k] = it.params[k];
        return {
          key: String(it.key || ''),
          url: String(it.url || ''),
          title: String(it.title || ''),
          params: p,
        };
      });
    const id = 's' + Date.now().toString(36);
    sets.push({ id, name: String(data.name || 'Imported'), items });
    selected = id;
    save();
    render();
    msg('Imported ' + items.length + ' tracks.');
  };
  rd.readAsText(f);
  $('file').value = '';
};

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.sets || c.active) load();
});

load();
