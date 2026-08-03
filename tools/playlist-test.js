#!/usr/bin/env node
// Exercises the pure pieces of the playlist feature without a browser.
//
//   node tools/playlist-test.js
//
// keyFor decides whether two visits count as the same track, so a mistake there
// silently applies the wrong settings. It is lifted straight out of page.js so
// the test cannot drift from the shipping copy.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'extension', 'page.js'), 'utf8');
const sets = fs.readFileSync(path.join(ROOT, 'extension', 'sets.js'), 'utf8');

function lift(src, name, re) {
  const m = src.match(re);
  if (!m) throw new Error('could not find ' + name + ' to lift out');
  return new Function('return (' + m[0] + ')')();
}

const keyFor = lift(page, 'keyFor', /function keyFor\(href\) \{[\s\S]*?\n {2}\}/);
const summarise = lift(sets, 'summarise', /function summarise\(p\) \{[\s\S]*?\n\}/);

let bad = 0;
const eq = (got, want, what) => {
  const ok = got === want;
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok ? '' : `  got ${got}, want ${want}`));
  if (!ok) bad++;
};

console.log('--- track identity ---');
eq(keyFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'yt:dQw4w9WgXcQ', 'youtube watch page');
eq(keyFor('https://youtube.com/watch?v=abc123'), 'yt:abc123', 'youtube without www');
eq(keyFor('https://music.youtube.com/watch?v=abc123'), 'yt:abc123', 'youtube music shares the key');
eq(
  keyFor('https://www.youtube.com/watch?v=abc123&list=PLxyz&index=7'),
  'yt:abc123',
  'playlist position does not change the key'
);
eq(keyFor('https://www.youtube.com/'), null, 'youtube home is not a track');
eq(keyFor('https://www.youtube.com/feed/subscriptions'), null, 'a feed is not a track');
eq(keyFor('https://soundcloud.com/artist/a-track'), 'sc:/artist/a-track', 'soundcloud track');
eq(keyFor('https://soundcloud.com/artist/a-track/'), 'sc:/artist/a-track', 'trailing slash ignored');
eq(keyFor('https://soundcloud.com/artist'), null, 'soundcloud profile is not a track');
eq(
  keyFor('https://artist.bandcamp.com/album/the-record'),
  'bc:artist.bandcamp.com/album/the-record',
  'bandcamp album'
);
eq(keyFor('https://example.com/thing'), 'url:example.com/thing', 'anything else falls back to the path');
eq(keyFor('not a url'), null, 'rubbish gives no key');

// The same video reached two ways has to resolve to one entry, or settings
// saved on one route are invisible from the other.
eq(
  keyFor('https://www.youtube.com/watch?v=abc123&t=42s'),
  keyFor('https://music.youtube.com/watch?v=abc123&list=RDAMVM'),
  'a timestamp and a radio link agree'
);

console.log('\n--- set summaries ---');
eq(summarise(null), 'defaults', 'no parameters reads as defaults');
eq(summarise({ semitones: 3, envResHz: 600, crossoverHz: 150 }), '-3 st  600 Hz  xo 150', 'typical item');
eq(summarise({ semitones: 5, midWet: 0.5, envResHz: 200, crossoverHz: 0 }), '-5 st  50%  200 Hz', 'crossover off is omitted');
eq(
  summarise({ semitones: 3, envResHz: 600, crossoverHz: 150, transient: 0.7, stereoMs: true }),
  '-3 st  600 Hz  xo 150  tr 70%  m/s',
  'every optional field'
);

console.log('\n--- storage shape ---');
const PARAM_KEYS = [
  'semitones', 'midWet', 'sideWet', 'stereoMs', 'crossoverHz',
  'transient', 'envResHz', 'fftSize', 'loudnessMatch',
];
const inPage = (page.match(/const PARAM_KEYS = \[([\s\S]*?)\]/) || [])[1] || '';
const inSets = (sets.match(/const PARAM_KEYS = \[([\s\S]*?)\]/) || [])[1] || '';
const norm = (s) => (s.match(/'[a-zA-Z]+'/g) || []).join(',');
eq(norm(inPage), norm(inSets), 'page.js and sets.js agree on which keys are per-track');
eq(norm(inPage), PARAM_KEYS.map((k) => `'${k}'`).join(','), 'the list is the one this test expects');

// A set item must never be able to smuggle UI state or unknown fields through
// import, or a shared set could switch the panel off on someone else's machine.
eq(inPage.includes("'enabled'"), false, 'enabled stays global');
eq(inPage.includes("'panelOpen'"), false, 'panelOpen stays global');

process.exit(bad ? 1 : 0);
