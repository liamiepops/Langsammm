#!/usr/bin/env node
// Builds site/privacy.html.
//
//   node tools/privacy.js
//
// Chrome requires a privacy policy at a public, persistent URL that anyone can
// open without signing in, and it requires the wording to use its own
// vocabulary for data types. Saying "we collect nothing" in prose is not enough
// on its own, so the categories are listed explicitly and each one denied.

const fs = require('fs');
const path = require('path');

const EFFECTIVE = '6 September 2026';
const CONTACT = 'liamsemailaddress@gmail.com';

// Google's published list. Naming each one and answering it removes any
// question about a category having been overlooked.
const CATEGORIES = [
  ['Personally identifiable information', 'name, address, email address, age, identification number'],
  ['Health information', 'medical history, symptoms, diagnoses, procedures'],
  ['Financial and payment information', 'transactions, credit card numbers, credit ratings, financial statements'],
  ['Authentication information', 'passwords, credentials, security questions, PINs'],
  ['Personal communications', 'emails, texts, chat messages'],
  ['Location', 'region, IP address, GPS coordinates, anything about the user’s surroundings'],
  ['Web history', 'the list of web pages a user has visited, and the data from those pages'],
  ['User activity', 'network monitoring, clicks, mouse position, scroll, keystroke logging'],
  ['Website content', 'text, images, sounds, videos, or hyperlinks'],
];

const HTML = `<title>Langsammm privacy policy</title>
<style>
  :root {
    --ground:#15141a; --raised:#1d1c23; --rule:#302e38;
    --ink:#efedea; --dim:#8e8983; --ash:#a8a29c; --verm:#d93b2b;
  }
  @media (prefers-color-scheme: light) {
    :root { --ground:#f4f2ef; --raised:#fff; --rule:#dedad4;
            --ink:#191715; --dim:#6b655e; --ash:#6e6862; --verm:#bf3222; }
  }
  :root[data-theme="light"] { --ground:#f4f2ef; --raised:#fff; --rule:#dedad4;
            --ink:#191715; --dim:#6b655e; --ash:#6e6862; --verm:#bf3222; }
  :root[data-theme="dark"] { --ground:#15141a; --raised:#1d1c23; --rule:#302e38;
            --ink:#efedea; --dim:#8e8983; --ash:#a8a29c; --verm:#d93b2b; }

  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink);
         font:16px/1.65 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:56px 24px 90px; }
  h1 { font-size:clamp(26px,4vw,34px); letter-spacing:-.025em; font-weight:680;
       margin:14px 0 0; }
  h2 { font-size:17px; font-weight:650; letter-spacing:-.012em; margin:38px 0 12px; }
  p, li { max-width:64ch; }
  p { margin:0 0 15px; }
  .dim { color:var(--dim); }
  .eyebrow { font:600 10px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing:.14em;
             text-transform:uppercase; color:var(--dim); }
  a { color:var(--verm); }
  table { width:100%; border-collapse:collapse; margin:6px 0 20px; font-size:14.5px; }
  th { text-align:left; font:600 9.5px/1 ui-sans-serif, system-ui, sans-serif;
       letter-spacing:.12em; text-transform:uppercase; color:var(--dim);
       padding:0 10px 9px 0; border-bottom:1px solid var(--rule); }
  td { padding:10px 10px 10px 0; border-bottom:1px solid var(--rule); vertical-align:top; }
  td.no { width:74px; color:var(--ash); font:600 12px/1.5 ui-monospace,Consolas,monospace; }
  td .ex { display:block; color:var(--dim); font-size:13px; margin-top:3px; }
  .mark { display:flex; align-items:center; gap:9px; }
</style>

<div class="wrap">
  <div class="mark">
    <svg viewBox="0.7 5.1 22.6 13.8" height="16" width="26" aria-hidden="true">
      <g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path stroke="var(--ash)" d="M2 12L2.4 8.9L2.8 6.9L3.2 6.5L3.6 7.7L4 10.1L4.4 12.9L4.8 15.4L5.2 17.1L5.6 17.6L6 16.9L6.4 15.1L6.8 12.8L7.2 10.4L7.6 8.3L8 6.9L8.4 6.4L8.8 6.8L9.2 7.9L9.6 9.7L10 11.7L10.4 13.8L10.8 15.5L11.2 16.8"/>
        <path stroke="var(--verm)" d="M11.2 16.8L11.6 17.5L12 17.5L12.4 16.9L12.8 15.7L13.2 14.2L13.6 12.5L14 10.7L14.4 9.1L14.8 7.8L15.2 6.9L15.6 6.4L16 6.5L16.4 7L16.8 7.9L17.2 9.2L17.6 10.6L18 12.1L18.4 13.6L18.8 15L19.2 16.1L19.6 16.9L20 17.4L20.4 17.6L20.8 17.4L21.2 16.9L21.6 16.1L22 15"/>
      </g>
    </svg>
    <span class="eyebrow">Langsammm</span>
  </div>

  <h1>Privacy policy</h1>
  <p class="dim">Effective ${EFFECTIVE}</p>

  <h2>What Langsammm collects</h2>
  <p>
    Nothing. The extension collects no user data, transmits no user data, and
    sends no network requests of any kind while it runs.
  </p>
  <p>
    It processes audio that is already playing in your browser, on your own
    machine, and discards it as it goes. No audio is recorded, stored or
    transmitted.
  </p>

  <h2>Each category, answered</h2>
  <table>
    <thead><tr><th>Collected</th><th>Category</th></tr></thead>
    <tbody>
${CATEGORIES.map(
  ([name, examples]) => `      <tr>
        <td class="no">No</td>
        <td>${name}<span class="ex">${examples}</span></td>
      </tr>`
).join('\n')}
    </tbody>
  </table>

  <h2>What is stored, and where</h2>
  <p>
    Your slider positions are saved using the browser's own extension storage,
    so the extension opens the way you left it. That is a handful of numbers:
    the interval, the envelope width, the crossover frequency and a few
    switches.
  </p>
  <p>
    This data stays in your browser profile. It is never sent anywhere, and no
    part of it identifies you. Removing the extension removes it.
  </p>

  <h2>Permissions</h2>
  <p>
    Langsammm requests one permission, <code>storage</code>, used only for the
    settings described above. It requests no host permissions. Its content
    scripts run on YouTube, SoundCloud and Bandcamp, which is where audio can
    be processed, and it reads nothing from those pages beyond the audio being
    played through them.
  </p>

  <h2>Third parties</h2>
  <p>
    There are none. No analytics, no error reporting, no advertising, no remote
    code. Everything the extension runs is contained in the package you
    installed, including the WebAssembly module that does the signal processing.
  </p>

  <h2>Children</h2>
  <p>
    Since no data is collected from anyone, none is collected from children.
  </p>

  <h2>Changes</h2>
  <p>
    If a future version ever collects anything, this page will say so before
    that version ships, and the effective date above will change.
  </p>

  <h2>Contact</h2>
  <p>
    Questions about this policy, or about the extension, can go to
    <a href="mailto:${CONTACT}">${CONTACT}</a>.
  </p>
</div>
`;

const dir = path.join(__dirname, '..', 'site');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'privacy.html'), HTML);
console.log('site/privacy.html  ' + Math.round(HTML.length / 1024) + ' KB');
