'use strict';
// ---------- export / import of the whole look as one .cfg (a zip made by the app) ----------
/** Take over an imported configuration (already checked by `cfgParse`). `url` is the imported background, if any. */
async function applyConfig(c, url) {
  const p = cfgParse(c);
  if (p.style) style = p.style;
  if (p.scheme) schemePref = p.scheme;
  if (p.accent) accentPref = p.accent;
  if (p.zoom) { zoomPref = p.zoom; pref.set('zoom', String(zoomPref)); applyZoom(); }
  if (p.icon) { iconPref = p.icon; pref.set('icon', iconPref); applyIcon(); }
  if (p.bg) bgPref = p.bg;
  if (url) { bgFile = url; bgShown = null; }
  if (bgPref.mode === 'media' && !bgFile) bgPref.mode = 'default'; // the archive had no file and none is stored
  if (bgPref.kind === 'image' && url && /\.(mp4|webm)$/i.test(url)) bgPref.kind = 'video'; // trust the real file, not the claim
  if (bgPref.kind === 'video' && url && !/\.(mp4|webm)$/i.test(url)) bgPref.kind = 'image';
  pref.set('style', style); pref.set('scheme', schemePref); pref.set('accent', accentPref); saveBackground();
  cpOpen(false);
  bgShown = null;
  applyAppearance(); applyBackground();
  if (p.notifications) await saveNotify(p.notifications);
  if (p.network) await netCall('net_set', { mode: p.network.mode });
}
$('cfg-export').onclick = async () => {
  $('cfg-msg').textContent = 'Выберите, куда сохранить…';
  try {
    const path = await invoke('export_config', { config: JSON.stringify(await cfgBuild(), null, 2) });
    $('cfg-msg').textContent = path ? `Сохранено: ${path}` : 'Отменено.';
  } catch (e) { $('cfg-msg').textContent = `Не удалось сохранить: ${e}`; }
};
$('cfg-import').onclick = async () => {
  $('cfg-msg').textContent = 'Выберите файл…';
  try {
    const got = await invoke('import_config');
    if (!got) { $('cfg-msg').textContent = 'Отменено.'; return; }
    await applyConfig(JSON.parse(got.config), got.background);
    $('cfg-msg').textContent = 'Настройки импортированы.';
  } catch (e) { $('cfg-msg').textContent = `Не удалось импортировать: ${e instanceof Error ? e.message : e}`; }
};

const VIDEO_EXT = ['mp4', 'webm'];
$('bg-pick').onclick = () => $('bg-file').click();
$('bg-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  bgNote = '';
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (f.size > 300 * 1024 * 1024) { bgMessage('Файл больше 300 МБ.'); return; }
  bgMessage('Копирую файл…');
  try {
    const path = await invoke('set_background', new Uint8Array(await f.arrayBuffer()), { headers: { ext } });
    bgFile = path; bgShown = null;
    Object.assign(bgPref, { mode: 'media', kind: VIDEO_EXT.includes(ext) ? 'video' : 'image', name: f.name.slice(0, 120) });
    saveBackground(); applyBackground();
  } catch (err) { bgMessage(`Не удалось: ${err}`); }
});
$('bg-remove').onclick = async () => {
  bgNote = '';
  try { await invoke('clear_background'); } catch (_) { /* nothing stored */ }
  bgFile = null; bgShown = null; bgPref.mode = 'default'; bgPref.name = ''; saveBackground(); applyBackground();
};
$('bg-dim').addEventListener('input', (e) => { bgPref.dim = Number(e.target.value); saveBackground(); applyBackground(); });
$('bg-blur').addEventListener('input', (e) => { bgPref.blur = Number(e.target.value); saveBackground(); applyBackground(); });
$('bg-angle').addEventListener('input', (e) => { bgPref.mode = 'gradient'; bgPref.angle = Number(e.target.value); saveBackground(); applyBackground(); });
applyBackground();
(async () => { // the stored file is looked up once at start; if it is gone, the media mode falls back to the style's background
  try { bgFile = invoke ? await invoke('background_path') : null; } catch (_) { bgFile = null; }
  if (!bgFile && bgPref.mode === 'media') { bgPref.mode = 'default'; saveBackground(); }
  applyBackground();
})();
if (mq) {
  const onChange = (e) => { webDark = e.matches; applyAppearance(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
}
try {
  const win = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow();
  if (win) {
    win.theme().then((t) => { nativeTheme = t || null; applyAppearance(); }).catch(() => {});
    win.onThemeChanged((e) => { nativeTheme = e.payload || null; applyAppearance(); }).catch(() => {});
  }
} catch (_) { /* no window API: the web view's own preference is used */ }
applyAppearance();
