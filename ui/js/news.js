'use strict';
// ---------- notifications: bell, feed, toast and their settings (the checking itself runs in Rust, see src-tauri/src/news.rs) ----------
const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
S.feed = []; S.notify = null; S.newsReady = false;

function renderBell(unread) {
  const n = $('bell-n');
  n.hidden = !unread;
  n.textContent = unread > 99 ? '99+' : String(unread);
  $('bell').setAttribute('aria-label', unread ? `Что нового, непрочитанных: ${unread}` : 'Что нового');
}
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч`;
  return h < 48 ? 'вчера' : `${Math.round(h / 24)} дн.`;
}
function feedChip(it) {
  if (it.kind === 'mark') return `<span class="chip ${cls(it.value || '')}">${esc(it.value || '')}</span>`;
  return `<span class="chip cn small">${it.kind === 'homework' ? 'ДЗ' : 'Н'}</span>`;
}
function renderFeed() {
  $('feed-list').innerHTML = S.feed.length
    ? S.feed.map((it) => `<button class="fi${it.read ? '' : ' new'}" data-id="${esc(it.id)}" data-kind="${esc(it.kind)}">${feedChip(it)}<div class="t"><b>${esc(it.title)}</b><span>${esc(it.text)}</span></div><small>${esc(ago(it.ts))}</small>${it.read ? '' : '<i class="dot" aria-label="не прочитано"></i>'}</button>`).join('')
    : '<div class="fempty">Пока ничего нового</div>';
}
async function loadFeed() {
  try {
    const f = await invoke('news_feed');
    S.feed = f.items; renderBell(f.unread);
  } catch (_) { S.feed = []; renderBell(0); }
  renderFeed();
}
function positionFeed() {
  const b = $('bell').getBoundingClientRect(), f = $('feed'), w = f.offsetWidth || 380;
  f.style.top = `${Math.round(b.bottom + 8)}px`;
  f.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, b.right - w)))}px`;
}
function openFeed() {
  $('feed').hidden = false;
  $('bell').setAttribute('aria-expanded', 'true');
  positionFeed();
  loadFeed();
}
function closeFeed(returnFocus) {
  if ($('feed').hidden) return;
  $('feed').hidden = true;
  $('bell').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('bell').focus();
}
$('bell').onclick = () => { if ($('feed').hidden) openFeed(); else closeFeed(true); };
$('feed-readall').onclick = async () => { try { await invoke('news_read', { ids: [] }); } catch (_) { /* offline: nothing to do */ } loadFeed(); };
$('feed-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.fi');
  if (!b) return;
  try { await invoke('news_read', { ids: [b.dataset.id] }); } catch (_) { /* ignore */ }
  closeFeed(false);
  view(b.dataset.kind === 'mark' ? 'marks' : b.dataset.kind === 'homework' ? 'tasks' : 'schedule');
  loadFeed();
});
$('feed').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeFeed(true); e.stopPropagation(); } });
document.addEventListener('click', (e) => { if (!$('feed').hidden && !e.target.closest('#feed') && !e.target.closest('#bell')) closeFeed(false); });
window.addEventListener('resize', () => { if (!$('feed').hidden) positionFeed(); });

let toastTimer = 0;
function showToast(p, ms) {
  const mark = p.kinds && p.kinds.length === 1 && p.kinds[0] === 'mark' && p.value;
  const t = $('toast');
  t.innerHTML = `${mark ? `<span class="chip ${cls(p.value)}">${esc(p.value)}</span>` : '<span class="chip cn small">!</span>'}<div class="t"><b>${esc(p.title)}</b><span class="m">${esc(p.body)}</span></div>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 6000);
}
$('toast').onclick = (e) => { e.stopPropagation(); $('toast').hidden = true; openFeed(); }; // stopPropagation: the "click outside the feed" handler would close it at once

/** Called once the app is shown: restores the unread count and listens to what Rust finds. */
async function initNews() {
  if (!invoke) return;
  loadFeed();
  try { S.notify = await invoke('notify_get'); } catch (_) { S.notify = null; }
  renderNotifySettings();
  if (S.newsReady || !tauriEvent || !tauriEvent.listen) return;
  S.newsReady = true;
  tauriEvent.listen('news-updated', (e) => { renderBell(e.payload.unread); if (!$('feed').hidden) loadFeed(); });
  tauriEvent.listen('news-new', (e) => showToast(e.payload));
  tauriEvent.listen('session-expired', () => sessionExpired()); // the background check found the session dead
}

function renderNotifySettings() {
  const s = S.notify;
  if (!s) return;
  $('nt-marks').checked = s.marks; $('nt-homework').checked = s.homework; $('nt-absences').checked = s.absences; $('nt-tray').checked = s.close_to_tray;
  if (invoke) invoke('tray_ready').then((ok) => { $('nt-tray-warn').hidden = ok; }).catch(() => {});
  document.querySelectorAll('#nt-interval button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === s.interval_min)));
  document.querySelectorAll('#nt-detail button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === s.detail)));
}
async function saveNotify(patch) {
  const next = { ...(S.notify || {}), ...patch };
  try { S.notify = await invoke('notify_set', { settings: next }); } catch (e) { $('nt-msg').textContent = `Не удалось сохранить: ${e}`; }
  renderNotifySettings();
}
$('nt-marks').onchange = (e) => saveNotify({ marks: e.target.checked });
$('nt-homework').onchange = (e) => saveNotify({ homework: e.target.checked });
$('nt-absences').onchange = (e) => saveNotify({ absences: e.target.checked });
$('nt-tray').onchange = (e) => saveNotify({ close_to_tray: e.target.checked });
$('nt-interval').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) saveNotify({ interval_min: Number(b.dataset.v) }); });
$('nt-detail').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) saveNotify({ detail: b.dataset.v === '1' }); });
$('nt-check').onclick = async () => {
  $('nt-check').disabled = true; $('nt-msg').textContent = 'Проверяю…';
  try {
    const n = await invoke('news_check_now');
    $('nt-msg').textContent = n ? `Найдено нового: ${n}.` : 'Ничего нового.';
  } catch (e) { $('nt-msg').textContent = e === 'OFFLINE' ? 'Нет связи с Госуслугами.' : `Не удалось проверить: ${e}`; }
  $('nt-check').disabled = false;
};
