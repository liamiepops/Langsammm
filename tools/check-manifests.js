#!/usr/bin/env node
// Keeps the Chrome and Firefox manifests from drifting apart.
//
//   node tools/check-manifests.js
//
// The two differ on purpose in exactly two places: Firefox declares page.js as
// a MAIN-world content script and carries a gecko id. Everything else has to
// match, and every file either one references has to exist.

const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
const chrome = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const firefox = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.firefox.json'), 'utf8'));

const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
};

// Fields that must be identical.
for (const key of ['manifest_version', 'name', 'version', 'description', 'permissions', 'icons', 'action', 'content_security_policy', 'web_accessible_resources']) {
  check(
    JSON.stringify(chrome[key]) === JSON.stringify(firefox[key]),
    `${key} differs between the two manifests`
  );
}

// Firefox needs an add-on id to be publishable; Chrome must not carry one, or
// it reports an unrecognised key.
check(!chrome.browser_specific_settings, 'Chrome manifest should not carry browser_specific_settings');
const gecko = firefox.browser_specific_settings && firefox.browser_specific_settings.gecko;
check(!!(gecko && gecko.id), 'Firefox manifest needs browser_specific_settings.gecko.id');
check(
  !!(gecko && parseFloat(gecko.strict_min_version) >= 128),
  'Firefox needs strict_min_version 128 or later for world: MAIN'
);

// Injection routes.
const mainWorld = (m) => (m.content_scripts || []).filter((cs) => cs.world === 'MAIN');
check(mainWorld(chrome).length === 0, 'Chrome manifest must not declare a MAIN-world script; bridge.js injects instead');
check(mainWorld(firefox).length === 1, 'Firefox manifest must declare exactly one MAIN-world script');
const ffMain = mainWorld(firefox)[0];
if (ffMain) {
  check((ffMain.js || []).includes('page.js'), 'the Firefox MAIN-world script must be page.js');
  check(ffMain.run_at === 'document_start', 'the Firefox MAIN-world script must run at document_start');
}

// bridge.js must be present in both, and the match lists must agree.
const bridgeOf = (m) => (m.content_scripts || []).find((cs) => (cs.js || []).includes('bridge.js'));
const cb = bridgeOf(chrome);
const fb = bridgeOf(firefox);
check(!!cb && !!fb, 'both manifests must run bridge.js');
if (cb && fb) {
  check(
    JSON.stringify(cb.matches.slice().sort()) === JSON.stringify(fb.matches.slice().sort()),
    'bridge.js match lists differ between the two manifests'
  );
  if (ffMain) {
    check(
      JSON.stringify(fb.matches.slice().sort()) === JSON.stringify(ffMain.matches.slice().sort()),
      'the Firefox MAIN-world matches must equal the bridge matches'
    );
  }
}

// Web accessible resources must not be broader than where the scripts run.
for (const [label, m] of [['chrome', chrome], ['firefox', firefox]]) {
  const war = (m.web_accessible_resources || [])[0];
  const b = bridgeOf(m);
  if (war && b) {
    check(
      JSON.stringify(war.matches.slice().sort()) === JSON.stringify(b.matches.slice().sort()),
      `${label}: web_accessible_resources matches should equal the content script matches`
    );
  }
  for (const r of (war && war.resources) || []) {
    check(fs.existsSync(path.join(EXT, r)), `${label}: web accessible resource missing: ${r}`);
  }
  for (const p of [...Object.values(m.icons || {}), ...Object.values((m.action || {}).default_icon || {})]) {
    check(fs.existsSync(path.join(EXT, p)), `${label}: icon missing: ${p}`);
  }
  for (const cs of m.content_scripts || []) {
    for (const j of cs.js || []) {
      check(fs.existsSync(path.join(EXT, j)), `${label}: content script missing: ${j}`);
    }
  }
}

// The CSP Firefox permits is narrower than Chrome's: only 'self' and
// 'wasm-unsafe-eval' are allowed in script-src.
const csp = (firefox.content_security_policy || {}).extension_pages || '';
const scriptSrc = (csp.match(/script-src([^;]*)/) || [])[1] || '';
for (const token of scriptSrc.trim().split(/\s+/).filter(Boolean)) {
  check(
    ["'self'", "'wasm-unsafe-eval'"].includes(token),
    `Firefox rejects ${token} in script-src`
  );
}

if (problems.length) {
  console.error('manifest check failed:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('manifests agree: chrome injects page.js, firefox declares it in the MAIN world');
