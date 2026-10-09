'use strict';
// ---------- background: the style's own, one colour, or a two-colour gradient ----------
const BG_SOLIDS = ['#F8FAFC', '#E2E8F0', '#FDE68A', '#FBCFE8', '#BAE6FD', '#BBF7D0', '#1E293B', '#0F172A', '#312E81', '#4C1D95', '#14532D', '#000000'];
const BG_GRADS = [ // [name, from, to, angle]
  ['Закат', '#FF9966', '#FF5E62', 160], ['Океан', '#2193B0', '#6DD5ED', 160], ['Лес', '#134E5E', '#71B280', 160], ['Ночь', '#0F2027', '#2C5364', 160],
  ['Сирень', '#C471F5', '#FA71CD', 135], ['Мята', '#D4FC79', '#96E6A1', 135], ['Туман', '#E0EAFC', '#CFDEF3', 180], ['Космос', '#1B1F3B', '#4B3C62', 160],
];
const BG_DEFAULT = { mode: 'default', color: '#E2E8F0', a: '#FF9966', b: '#FF5E62', angle: 160, kind: 'image', name: '', dim: 35, blur: 0 };
/** Background settings from storage or from an imported file: anything unexpected falls back to the default. */
function cleanBg(saved) {
  const b = { ...BG_DEFAULT };
  if (!saved || typeof saved !== 'object') return b;
  if (['default', 'solid', 'gradient', 'media'].includes(saved.mode)) b.mode = saved.mode;
  for (const k of ['color', 'a', 'b']) if (typeof saved[k] === 'string' && HEX.test(saved[k])) b[k] = saved[k];
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  b.angle = num(saved.angle, 0, 360, b.angle); b.dim = num(saved.dim, 0, 80, b.dim); b.blur = num(saved.blur, 0, 20, b.blur);
  if (saved.kind === 'video') b.kind = 'video';
  if (typeof saved.name === 'string') b.name = saved.name.slice(0, 120);
  return b;
}
let bgPref = { ...BG_DEFAULT };
try { bgPref = cleanBg(JSON.parse(pref.get('bg', '{}'))); } catch (_) { /* junk in storage: defaults */ }
const saveBackground = () => pref.set('bg', JSON.stringify(bgPref));
const gradCss = (a, b, angle) => `linear-gradient(${angle}deg, ${a}, ${b})`;

/** The stored file (path from the app), shown in the fixed layer; null while none is chosen. */
let bgFile = null;
let bgShown = null; // what the layer currently holds, to avoid reloading a video on every slider move
function showMedia(on) {
  const layer = $('bglayer');
  if (!on || !bgFile) { layer.classList.remove('on'); layer.textContent = ''; bgShown = null; return; }
  const root = document.documentElement.style;
  root.setProperty('--bgdim', String(bgPref.dim / 100));
  root.setProperty('--bgblur', `${bgPref.blur}px`);
  root.setProperty('--bgscale', String(1 + 0.008 * bgPref.blur)); // hides the soft edges blur leaves; grows with the blur, so the first step does not jump
  layer.classList.add('on');
  if (bgShown === bgFile) return;
  bgShown = bgFile;
  layer.textContent = '';
  const src = bgFile; // a http://127.0.0.1 URL from the app (a blob URL in the dev mock)
  const el = document.createElement(bgPref.kind === 'video' ? 'video' : 'img');
  el.className = 'bgm';
  if (bgPref.kind === 'video') { el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; el.preload = 'auto'; }
  el.onerror = () => {
    const code = el.error ? el.error.code : 0; // MediaError: 1 aborted, 2 network, 3 decode, 4 source not supported
    console.warn('background failed', code, el.error && el.error.message);
    bgNote = `Не удалось показать файл (код ошибки ${code || '?'}). ${code === 4 ? 'Формат или кодек не поддерживается системой, либо файл недоступен.' : code === 3 ? 'Файл повреждён или не декодируется.' : ''} Для видео попробуйте WebM (VP8/VP9).`;
    bgFile = null; bgShown = null; layer.classList.remove('on'); layer.textContent = ''; applyBackground();
  };
  el.src = src;
  layer.appendChild(el);
  if (bgPref.kind === 'video') { // some web views never report an error for a video they cannot open: give up after a few seconds and say why
    const file = bgFile;
    setTimeout(() => {
      if (bgFile !== file || el.readyState >= 2) return;
      console.warn('background video never started', el.readyState, el.networkState, el.canPlayType('video/mp4'), el.canPlayType('video/webm'));
      bgNote = `Видео не запустилось за 5 с: readyState ${el.readyState}, networkState ${el.networkState} (3 = источник не найден), MP4: «${el.canPlayType('video/mp4') || 'нет'}», WebM: «${el.canPlayType('video/webm') || 'нет'}».`;
      bgFile = null; bgShown = null; layer.classList.remove('on'); layer.textContent = ''; applyBackground();
    }, 5000);
  }
}
document.addEventListener('visibilitychange', () => { // no point in decoding video nobody sees
  const v = $('bglayer').querySelector('video');
  if (v) { if (document.hidden) v.pause(); else v.play().catch(() => {}); }
});
let bgNote = ''; // the last problem; it stays in the hint until the user does something else
function bgMessage(text) { bgNote = text; $('bg-hint').textContent = text; }

function applyBackground() {
  const root = document.documentElement.style, m = bgPref.mode;
  showMedia(m === 'media');
  if (m === 'solid') { root.setProperty('--ubg', bgPref.color); root.setProperty('--ubgi', 'none'); }
  else if (m === 'gradient') { root.setProperty('--ubg', bgPref.b); root.setProperty('--ubgi', gradCss(bgPref.a, bgPref.b, bgPref.angle)); }
  else { root.removeProperty('--ubg'); root.removeProperty('--ubgi'); }
  document.querySelectorAll('#bgmode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
  $('bg-solid').hidden = m !== 'solid';
  $('bg-grad').hidden = m !== 'gradient';
  $('bg-media').hidden = m !== 'media';
  $('bg-dim').value = String(bgPref.dim); $('bg-blur').value = String(bgPref.blur);
  $('bg-name').textContent = bgFile ? bgPref.name : '';
  $('bg-remove').hidden = !bgFile;
  document.querySelectorAll('#bg-solid .sw[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === bgPref.color.toLowerCase())));
  document.querySelectorAll('#bg-presets .sw').forEach((b) => {
    const g = BG_GRADS[Number(b.dataset.i)];
    b.setAttribute('aria-pressed', String(g[1].toLowerCase() === bgPref.a.toLowerCase() && g[2].toLowerCase() === bgPref.b.toLowerCase() && g[3] === bgPref.angle));
  });
  $('bg-a').style.setProperty('--sw', bgPref.a); $('bg-b').style.setProperty('--sw', bgPref.b);
  $('bg-bar').style.setProperty('--swg', gradCss(bgPref.a, bgPref.b, bgPref.angle));
  $('bg-angle').value = String(bgPref.angle);
  $('bg-hint').textContent = bgNote ? bgNote : m === 'default' ? 'Фон задаёт выбранный стиль.' : m === 'solid' ? `Сплошной ${bgPref.color.toUpperCase()}` : m === 'media' ? (bgFile ? `${bgPref.kind === 'video' ? 'Видео' : 'Картинка'}: затемнение ${bgPref.dim}%, размытие ${bgPref.blur} px` : 'Файл не выбран.') : `Градиент ${bgPref.a.toUpperCase()} → ${bgPref.b.toUpperCase()}, ${bgPref.angle}°`;
}
(function buildBackgroundControls() {
  $('bg-solid').innerHTML = BG_SOLIDS.map((c) => `<button class="sw" data-c="${c}" style="--sw:${c}" aria-pressed="false" aria-label="Цвет ${c}" title="${c}"></button>`).join('')
    + '<button class="sw sw-custom" id="bg-solid-custom" aria-label="Свой цвет фона" title="Свой цвет" aria-expanded="false"></button>';
  $('bg-presets').innerHTML = BG_GRADS.map((g, i) => `<button class="sw grad" data-i="${i}" style="--swg:${gradCss(g[1], g[2], g[3])}" aria-pressed="false" aria-label="Градиент «${g[0]}»" title="${g[0]}"></button>`).join('');
})();
document.querySelectorAll('#bgmode button').forEach((b) => { b.onclick = () => { bgNote = ''; if (b.dataset.m !== bgPref.mode) cpOpen(false); bgPref.mode = b.dataset.m; saveBackground(); applyBackground(); }; });
$('bg-solid').addEventListener('click', (e) => {
  const b = e.target.closest('.sw[data-c]');
  if (b) { bgPref.mode = 'solid'; bgPref.color = b.dataset.c; saveBackground(); applyBackground(); }
});
$('bg-solid-custom').onclick = (e) => cpOpen(!(cp.open && cp.opener === e.currentTarget), 'solid', e.currentTarget, $('bg-picker-host'));
$('bg-presets').addEventListener('click', (e) => {
  const b = e.target.closest('.sw[data-i]');
  if (!b) return;
  const g = BG_GRADS[Number(b.dataset.i)];
  Object.assign(bgPref, { mode: 'gradient', a: g[1], b: g[2], angle: g[3] });
  saveBackground(); applyBackground();
});
$('bg-a').onclick = (e) => cpOpen(!(cp.open && cp.opener === e.currentTarget), 'a', e.currentTarget, $('bg-picker-host'));
$('bg-b').onclick = (e) => cpOpen(!(cp.open && cp.opener === e.currentTarget), 'b', e.currentTarget, $('bg-picker-host'));
