'use strict';
// ---------- the app icon (window and tray): a choice of pictures made by icons/make_icons.py ----------
// Keep this list in step with src-tauri/src/appicon.rs (a Rust test compares them). `dev` icons show only in the developer mode.
const APP_ICONS = [
  { id: 'graphite', title: 'Графит', dev: false },
  { id: 'ink', title: 'Контур', dev: false },
  { id: 'night', title: 'Ночь', dev: false },
  { id: 'paper', title: 'Бумага', dev: false },
  { id: 'dusk', title: 'Закат', dev: false },
  { id: 'indigo', title: 'Индиго', dev: false },
  { id: 'dawn', title: 'Заря', dev: false },
  { id: 'ring', title: 'Круг', dev: false },
  { id: 'disc', title: 'Диск', dev: true },
  { id: 'spark', title: 'Искра', dev: true },
];
const APP_ICON_DEFAULT = 'graphite';
let iconPref = pref.get('icon', APP_ICON_DEFAULT);
if (!APP_ICONS.some((i) => i.id === iconPref)) iconPref = APP_ICON_DEFAULT;

/** The icon in use: a developer-only one falls back to the default while the developer mode is off (the choice is kept). */
function effectiveIcon() {
  const i = APP_ICONS.find((x) => x.id === iconPref);
  return i && (!i.dev || (typeof DEV !== 'undefined' && DEV.on)) ? i.id : APP_ICON_DEFAULT;
}

function renderIcons() {
  const host = $('icon-grid');
  if (!host.children.length) {
    host.innerHTML = APP_ICONS.map((i) => `<button class="icard" data-i="${i.id}" aria-pressed="false"${i.dev ? ' data-dev' : ''}><img src="icons/${i.id}.png" alt="" width="64" height="64"><span>${i.title}</span></button>`).join('');
    host.querySelectorAll('.icard').forEach((b) => { b.onclick = () => { iconPref = b.dataset.i; pref.set('icon', iconPref); applyIcon(); }; });
  }
  const now = effectiveIcon();
  host.querySelectorAll('.icard').forEach((b) => {
    b.hidden = b.hasAttribute('data-dev') && !(typeof DEV !== 'undefined' && DEV.on);
    b.setAttribute('aria-pressed', String(b.dataset.i === now));
  });
}

function applyIcon() {
  renderIcons();
  if (invoke) invoke('set_app_icon', { id: iconPref }).catch(() => {}); // the program keeps the choice (and falls back for a developer-only icon itself)
}
renderIcons();
// The program keeps the choice (it sets the icon at start): take it over when this page remembers something else.
if (invoke) invoke('get_app_icon').then((id) => {
  if (id && id !== iconPref && APP_ICONS.some((i) => i.id === id)) { iconPref = id; pref.set('icon', id); renderIcons(); }
}).catch(() => {});
