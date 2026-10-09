'use strict';
// ---------- appearance: style (classic / terminal / sunrise) and theme (system / light / dark) ----------
const STYLES = ['classic', 'terminal', 'sunrise'];
const SCHEMES = ['system', 'light', 'dark'];
const pref = {
  get(k, d) { try { return localStorage.getItem('openschool.' + k) || d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('openschool.' + k, v); } catch (_) { /* storage may be unavailable */ } },
};
tasksOpenOnly = pref.get('tasksopen', '') === '1';
let style = pref.get('style', '');
if (!style) { const old = pref.get('theme', 'classic'); style = old === 'light' ? 'classic' : old; } // the old single "theme"
if (!STYLES.includes(style)) style = 'classic';
let schemePref = pref.get('scheme', 'system');
if (!SCHEMES.includes(schemePref)) schemePref = 'system';
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let webDark = !!(mq && mq.matches);
let nativeTheme = null; // the OS theme as the window reports it; more reliable than the web view on Linux

const systemIsDark = () => (nativeTheme ? nativeTheme === 'dark' : webDark);
/** The theme the user chose (the system one resolved). Previews of the other styles use it. */
const userScheme = () => (schemePref === 'system' ? (systemIsDark() ? 'dark' : 'light') : schemePref);
/** Terminal ignores the theme: it is always dark. */
const resolvedScheme = () => (style === 'terminal' ? 'dark' : userScheme());

// Accent colour: [name, colour on light themes, colour on dark themes]. Custom colours are used as they are.
const ACCENTS = {
  blue: ['Синий', '#2563EB', '#5B8CFF'], teal: ['Бирюзовый', '#0D9488', '#2DD4BF'], green: ['Зелёный', '#16A34A', '#4ADE80'],
  amber: ['Янтарный', '#D97706', '#FBBF24'], red: ['Красный', '#DC2626', '#F87171'], pink: ['Розовый', '#DB2777', '#F472B6'],
  purple: ['Фиолетовый', '#7C3AED', '#A78BFA'],
};
const HEX = /^#[0-9a-f]{6}$/i;
let accentPref = pref.get('accent', 'default');
if (accentPref !== 'default' && !ACCENTS[accentPref] && !HEX.test(accentPref)) accentPref = 'default'; // ignore junk in storage

function luminance(hex) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** Black or white, whichever reads better on the accent (WCAG contrast). */
function inkFor(hex) {
  const l = luminance(hex);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
}
function accentHex() {
  if (accentPref === 'default') return null;
  if (ACCENTS[accentPref]) return ACCENTS[accentPref][resolvedScheme() === 'dark' ? 2 : 1];
  return accentPref;
}
function applyAccent() {
  const root = document.documentElement, hex = accentHex();
  if (hex) { root.style.setProperty('--accent', hex); root.style.setProperty('--accent-ink', inkFor(hex)); }
  else { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-ink'); }
  const dark = resolvedScheme() === 'dark';
  document.querySelectorAll('#accent .sw[data-a]').forEach((b) => {
    b.style.setProperty('--sw', ACCENTS[b.dataset.a][dark ? 2 : 1]);
    b.setAttribute('aria-pressed', String(b.dataset.a === accentPref));
  });
  $('accent').querySelector('.sw-default').setAttribute('aria-pressed', String(accentPref === 'default'));
  const custom = HEX.test(accentPref);
  const label = $('accent-custom-btn');
  label.classList.toggle('on', custom);
  if (custom) label.style.setProperty('--sw', accentPref); else label.style.removeProperty('--sw');
  $('accent-hint').textContent = accentPref === 'default' ? 'Цвет задаёт выбранный стиль.' : ACCENTS[accentPref] ? ACCENTS[accentPref][0] : `Свой цвет ${accentPref.toLowerCase()}`;
}

function applyAppearance() {
  const scheme = resolvedScheme(), root = document.documentElement, locked = style === 'terminal';
  root.setAttribute('data-style', style);
  root.setAttribute('data-scheme', scheme);
  // The previews show each style the way it looks right now (terminal is always dark).
  document.querySelectorAll('.tprev').forEach((p) => p.setAttribute('data-scheme', p.dataset.style === 'terminal' ? 'dark' : userScheme()));
  document.querySelectorAll('.tcard').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === style)));
  document.querySelectorAll('#scheme button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.p === schemePref)); b.disabled = locked; });
  $('scheme-hint').textContent = locked ? 'В стиле «Терминал» тема не меняется: он всегда тёмный.'
    : schemePref === 'system' ? `Сейчас по системе: ${systemIsDark() ? 'тёмная' : 'светлая'}.` : '';
  applyAccent();
}

document.querySelectorAll('.tcard').forEach((b) => { b.onclick = () => { style = b.dataset.s; pref.set('style', style); applyAppearance(); }; });
document.querySelectorAll('#scheme button').forEach((b) => { b.onclick = () => { schemePref = b.dataset.p; pref.set('scheme', schemePref); applyAppearance(); }; });
document.querySelectorAll('#accent [data-a]').forEach((b) => { b.onclick = () => { accentPref = b.dataset.a; pref.set('accent', accentPref); applyAppearance(); }; });
// ---------- interface scale: the whole web view is zoomed natively (all sizes are in px) ----------
const ZOOMS = [0.85, 1, 1.15, 1.3, 1.5];
let zoomPref = Number(pref.get('zoom', '1'));
if (!ZOOMS.includes(zoomPref)) zoomPref = 1;
function applyZoom() {
  document.querySelectorAll('#zoom button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.z) === zoomPref)));
  try {
    const wv = window.__TAURI__ && window.__TAURI__.webview;
    if (wv) wv.getCurrentWebview().setZoom(zoomPref).catch(() => {});
    else document.documentElement.style.zoom = String(zoomPref); // plain browser / dev mock
  } catch (_) { /* scale is a nicety */ }
}
document.querySelectorAll('#zoom button').forEach((b) => { b.onclick = () => { zoomPref = Number(b.dataset.z); pref.set('zoom', String(zoomPref)); applyZoom(); }; });
applyZoom();
