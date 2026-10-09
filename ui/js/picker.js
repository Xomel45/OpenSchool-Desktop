'use strict';
// ---------- custom colour picker, drawn by the app: the native GTK dialog and its pipette are broken on Plasma 6 ----------
const cp = { hex: '#2563eb', h: 210, s: 0.8, v: 0.9, open: false, eyeChecked: false, target: 'accent', opener: null };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}
const rgbToHex = (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
/** `#rgb`, `#rrggbb`, with or without `#`. `strict` accepts only six digits (used while typing). */
function parseHex(text, strict) {
  let t = String(text).trim().replace(/^#/, '');
  if (!strict && /^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(t) ? [0, 2, 4].map((i) => parseInt(t.slice(i, i + 2), 16)) : null;
}

function cpRender(skipHexField) {
  $('cp-plane').style.setProperty('--hue', cp.h);
  const knob = $('cp-knob').style;
  knob.left = `${cp.s * 100}%`; knob.top = `${(1 - cp.v) * 100}%`;
  $('cp-plane').setAttribute('aria-valuetext', `насыщенность ${Math.round(cp.s * 100)}%, яркость ${Math.round(cp.v * 100)}%`);
  $('cp-hue').value = String(Math.round(cp.h));
  $('cp-preview').style.background = cp.hex;
  if (!skipHexField) $('cp-hex').value = cp.hex;
}
/** The hex string is the truth: picking, pasting or typing a colour never goes through HSV, so it cannot drift. */
function cpSetHex(hex, apply, skipHexField) {
  cp.hex = hex.toLowerCase();
  const [h, s, v] = rgbToHsv(...parseHex(cp.hex));
  if (s > 0 && v > 0) cp.h = h; // keep the hue on greys
  cp.s = s; cp.v = v;
  cpRender(skipHexField);
  if (apply) cpApply();
}
/** Dragging works in HSV, and only then is a hex computed from it. */
function cpSetHsv() {
  cp.hex = rgbToHex(hsvToRgb(cp.h, cp.s, cp.v));
  cpRender(false);
  cpApply();
}
/** The picker serves the accent colour and the background colours; `cp.target` says which one the colour goes to. */
function cpApply() {
  if (cp.target === 'accent') { accentPref = cp.hex; pref.set('accent', accentPref); applyAppearance(); return; }
  if (cp.target === 'solid') { bgPref.mode = 'solid'; bgPref.color = cp.hex; }
  else { bgPref.mode = 'gradient'; bgPref[cp.target === 'a' ? 'a' : 'b'] = cp.hex; }
  saveBackground(); applyBackground();
}
function cpStartColor() {
  if (cp.target === 'accent') return HEX.test(accentPref) ? accentPref : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return cp.target === 'solid' ? bgPref.color : bgPref[cp.target];
}
function cpMessage(text) { $('cp-msg').textContent = text; }

async function cpOpen(open, target, opener, host) {
  if (cp.opener) cp.opener.setAttribute('aria-expanded', 'false');
  cp.open = open;
  $('cpicker').hidden = !open;
  if (!open) { cp.opener = null; return; }
  cp.target = target; cp.opener = opener;
  opener.setAttribute('aria-expanded', 'true');
  host.after($('cpicker')); // one picker, shown under the block that opened it
  // Start from the colour being edited, or from what is on screen now; opening changes nothing by itself.
  let start = cpStartColor();
  if (!parseHex(start, true)) start = '#2563eb';
  cpSetHex(start, false);
  cpMessage('');
  if (!cp.eyeChecked) {
    cp.eyeChecked = true;
    try { $('cp-eye').hidden = !(invoke && await invoke('eyedropper_available')); } catch (_) { $('cp-eye').hidden = true; }
  }
}

const plane = $('cp-plane');
function planeAt(e) {
  const r = plane.getBoundingClientRect();
  cp.s = clamp01((e.clientX - r.left) / r.width);
  cp.v = clamp01(1 - (e.clientY - r.top) / r.height);
  cpSetHsv();
}
plane.addEventListener('pointerdown', (e) => { try { plane.setPointerCapture(e.pointerId); } catch (_) { /* not an active pointer */ } planeAt(e); });
plane.addEventListener('pointermove', (e) => { if (plane.hasPointerCapture && plane.hasPointerCapture(e.pointerId)) planeAt(e); });
plane.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.1 : 0.01, k = e.key;
  if (k === 'ArrowLeft') cp.s = clamp01(cp.s - step); else if (k === 'ArrowRight') cp.s = clamp01(cp.s + step);
  else if (k === 'ArrowUp') cp.v = clamp01(cp.v + step); else if (k === 'ArrowDown') cp.v = clamp01(cp.v - step);
  else return;
  e.preventDefault(); cpSetHsv();
});
$('cp-hue').addEventListener('input', (e) => { cp.h = Number(e.target.value); cpSetHsv(); });
$('cp-hex').addEventListener('input', (e) => {
  const text = e.target.value.trim(), rgb = parseHex(text, true);
  // Complain only once six characters are in and they are still not a colour.
  const bad = !rgb && text.replace('#', '').length >= 6;
  e.target.setAttribute('aria-invalid', String(bad));
  cpMessage(bad ? 'Введите цвет как #rrggbb' : '');
  if (rgb) cpSetHex(rgbToHex(rgb), true, true); // live only for complete six-digit colours; the field is not rewritten while typing
});
function cpCommitHexField() {
  const f = $('cp-hex'), rgb = parseHex(f.value, false);
  if (rgb) cpSetHex(rgbToHex(rgb), true, false); else f.value = cp.hex; // junk: go back to the last good colour
  f.setAttribute('aria-invalid', 'false');
  cpMessage('');
}
$('cp-hex').addEventListener('blur', cpCommitHexField);
$('cp-hex').addEventListener('keydown', (e) => { if (e.key === 'Enter') { cpCommitHexField(); e.preventDefault(); } });

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
/** The system clipboard through the Tauri plugin; the web API is only a fallback and can hang, hence the timeouts. */
async function copyText(text) {
  try { await withTimeout(window.__TAURI__.clipboardManager.writeText(text), 2000); return true; } catch (_) { /* fall back */ }
  try { await withTimeout(navigator.clipboard.writeText(text), 1500); return true; } catch (_) { return false; }
}
$('cp-copy').onclick = async () => { cpMessage((await copyText(cp.hex)) ? `Скопировано: ${cp.hex}` : 'Не удалось скопировать'); };
$('cp-eye').onclick = async () => {
  cpMessage('Кликните по любому месту экрана. Esc: отмена.');
  try {
    const hex = await invoke('pick_color');
    if (hex) { cpSetHex(hex, true); cpMessage(`Взят цвет ${cp.hex}`); } else cpMessage('Отменено');
  } catch (e) { cpMessage(`Пипетка не сработала: ${e}`); }
};
$('cp-close').onclick = () => { const o = cp.opener; cpOpen(false); if (o) o.focus(); };
$('cpicker').addEventListener('keydown', (e) => { if (e.key === 'Escape') { const o = cp.opener; cpOpen(false); if (o) o.focus(); e.stopPropagation(); } });
$('accent-custom-btn').onclick = () => cpOpen(!(cp.open && cp.opener === $('accent-custom-btn')), 'accent', $('accent-custom-btn'), $('accent'));
