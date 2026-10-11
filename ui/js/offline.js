'use strict';
// ---------- the last weeks kept on disk, shown when Gosuslugi cannot be reached (Rust: src-tauri/src/cache.rs) ----------

/** A week arrived from the server: keep a copy, and if it was one of the stale ones the connection is back for it. */
function weekFetched(key, year, week, w) {
  if (invoke) invoke('cache_put', { studentId: S.student.id, year, week, json: JSON.stringify(w) }).catch(() => {});
  if (S.stale.delete(key) && !S.stale.size) { S.offlineSince = null; renderOfflineBar(); }
}

/** The cached week and when it was fetched (ms), or null. A damaged file counts as "nothing cached". */
async function cachedWeek(year, week) {
  if (!invoke) return null;
  try {
    const c = await invoke('cache_get', { studentId: S.student.id, year, week });
    return c ? { week: JSON.parse(c.json), at: c.saved_at } : null;
  } catch (_) { return null; }
}

function markOffline(at) {
  S.offlineSince = S.offlineSince === null ? at : Math.min(S.offlineSince, at);
  renderOfflineBar();
}

function fetchedText(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MON_SHORT[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderOfflineBar() {
  const b = $('offbar');
  b.hidden = S.offlineSince === null;
  if (S.offlineSince !== null) $('offbar-text').textContent = `Нет связи с Госуслугами. Показаны данные от ${fetchedText(S.offlineSince)}.`;
}

/** Redraw whatever is on screen from the maps (after more weeks arrived or the developer changes changed). */
function redrawAll() {
  if (S.cur) { S.dayData = buildDay(S.cur); renderSched(); renderMain(); renderMarks(); }
  if (!$('schedule').hidden && S.week) renderWeek();
  if (!$('tasksview').hidden) renderTasks();
  if (!$('marksview').hidden) showMarks(S.gp);
}

/** Ask the server again for the weeks that came from the cache. */
async function refreshStale() {
  const keys = [...S.stale];
  $('offbar-retry').disabled = true;
  for (const k of keys) {
    const [y, w] = k.split('-').map(Number);
    try { await loadWeek(isoWeekStart(y, w)); } catch (_) { break; } // still no connection: the bar stays
  }
  $('offbar-retry').disabled = false;
  redrawAll();
}
/** Some day of the given ISO week (Jan 4th is always in week 1). */
function isoWeekStart(year, week) {
  const d = new Date(year, 0, 4);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + (week - 1) * 7);
  return d;
}
$('offbar-retry').onclick = refreshStale;

/** Logout: the cached weeks and the bar belong to the account. */
function offlineReset() { S.stale.clear(); S.offlineSince = null; renderOfflineBar(); }
