'use strict';
// ---------- --ai-debug / -ad: a report about the app that can be pasted to an AI ----------
// The report states facts (versions, settings, counts, shapes of data, kinds of outcomes). It never copies data: no names, ids,
// subjects, teachers, texts, addresses, cookies, marks. Texts that come from outside go through aiScrub, and the whole report
// through the program's last cleaning (`ai_clean`) before it is shown. Without the flag the page is hidden and nothing is built.
const AI = { on: false, errors: [], at: Date.now() };

/** Hide what a message may carry: quoted values, addresses, mail, long numbers, token-like words. Short identifiers in quotes stay. */
function aiScrub(text, max = 200) {
  let s = String(text);
  s = s.replace(/"[^"]*"/g, '"…"').replace(/'([^']*)'/g, (m, v) => (/^[A-Za-z_$][\w$.]{0,40}$/.test(v) ? m : "'…'"));
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\S+@\S+\.\S+/g, '<email>').replace(/\d{5,}/g, '<n>');
  s = s.split(' ').map((w) => (w.length >= 20 && /^[\w+/=.-]+$/.test(w) && (/\d/.test(w) && /[A-Za-z]/.test(w) || w.length >= 32) ? '<token>' : w)).join(' ');
  return s.slice(0, max);
}
function aiPushError(kind, text) {
  AI.errors.push({ at: Date.now(), kind, text: aiScrub(text) });
  if (AI.errors.length > 60) AI.errors.shift();
}
window.addEventListener('error', (e) => aiPushError('error', `${e.message || 'error'} @ ${String(e.filename || '').split('/').pop()}:${e.lineno || 0}`));
window.addEventListener('unhandledrejection', (e) => aiPushError('rejection', e.reason && e.reason.message ? e.reason.message : String(e.reason)));
for (const k of ['error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { try { aiPushError(`console.${k}`, a.map((x) => (typeof x === 'string' ? x : x && x.message ? x.message : typeof x)).join(' ')); } catch (_) { /* never break logging */ } orig(...a); };
}

const aiDay = 864e5;
const aiShape = (v) => String(v).replace(/[0-9]/g, '9').replace(/[A-Za-zА-Яа-яЁё]+/g, 'a').slice(0, 8);
const aiCount = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ') || '—'; };
const aiStats = (nums) => { if (!nums.length) return '—'; const s = [...nums].sort((a, b) => a - b); return `min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}`; };

/** What the loaded weeks look like: counts, empty fields, odd links. Dates are days from today; subjects are not named. */
function aiShapeOfData() {
  const out = [];
  const t = S.today;
  const day = (s) => (t && s ? Math.round((parseDate(s) - t) / aiDay) : null);
  const curMonday = t ? isoWeekStart(isoWeek(t).year, isoWeek(t).week).getTime() : null;
  const weeks = [...S.rawWeeks.values()].sort((a, b) => a.year - b.year || a.iso_week - b.iso_week);
  const lessonIds = new Set(), allLessons = [];
  for (const w of weeks) for (const l of w.lessons) { allLessons.push(l); lessonIds.add(l.id); }
  const subjects = new Map(); // anonymous labels: S1, S2…, so "the same subject" stays visible
  const label = (id) => { if (!subjects.has(id)) subjects.set(id, `S${subjects.size + 1}`); return subjects.get(id); };
  for (const w of weeks) {
    const key = `${w.year}-${w.iso_week}`;
    const off = curMonday === null ? '?' : Math.round((isoWeekStart(w.year, w.iso_week).getTime() - curMonday) / (7 * aiDay));
    const L = w.lessons, H = w.homeworks, M = w.marks;
    const per = [0, 0, 0, 0, 0, 0, 0];
    for (const l of L) { const d = parseDate(l.start).getDay(); per[(d + 6) % 7]++; }
    out.push(`- week ${off >= 0 ? '+' : ''}${off} (${S.stale.has(key) ? 'from the offline copy' : 'fresh'}): lessons ${L.length} [Mon..Sun ${per.join('/')}], homework ${H.length}, marks ${M.length}`);
    out.push(`  - lessons: subjects ${new Set(L.map((l) => l.subject_id)).size}, teachers ${new Set(L.map((l) => teacherKey(l.teacher))).size}, with absence ${L.filter((l) => l.absence).length}, empty theme ${L.filter((l) => !l.theme).length}, empty room ${L.filter((l) => !l.room).length}, end<=start ${L.filter((l) => l.end <= l.start).length}, lengths (min) ${aiStats(L.map((l) => Math.round((new Date(l.end.replace(' ', 'T')) - new Date(l.start.replace(' ', 'T'))) / 6e4)).filter(Number.isFinite))}`);
    out.push(`  - homework: with materials ${H.filter((h) => h.materials && h.materials.length).length}, no due lesson id ${H.filter((h) => !h.due_lesson_id).length}, due lesson not in loaded weeks ${H.filter((h) => h.due_lesson_id && !lessonIds.has(h.due_lesson_id)).length}, due before issue ${H.filter((h) => h.due_date < h.issue_date).length}, text length ${aiStats(H.map((h) => (h.description || '').length))}, due in days ${aiStats(H.map((h) => day(h.due_date)).filter((x) => x !== null))}`);
    out.push(`  - marks: value shapes ${aiCount(M.map((m) => aiShape(m.value)))}, double ${M.filter((m) => m.value2).length}, type codes ${aiCount(M.map((m) => m.work_type_code))}, no lesson id ${M.filter((m) => !m.lesson_id).length}, lesson not loaded ${M.filter((m) => m.lesson_id && !lessonIds.has(m.lesson_id)).length}, with comment ${M.filter((m) => m.comment).length}, subjects with marks ${[...new Set(M.map((m) => label(m.subject_id)))].sort().join(' ') || '—'}`);
  }
  const dup = allLessons.length - lessonIds.size;
  out.push(`- all weeks: ${weeks.length} loaded, duplicate lesson ids ${dup}`);
  return out;
}

function aiUiFacts() {
  const out = [];
  const nav = [...document.querySelectorAll('nav [aria-current="page"], .nav [aria-current="page"], header [aria-current="page"]')].map((b) => b.id || b.textContent.trim()).join(', ');
  out.push(`- page: ${nav || '?'}; viewport ${innerWidth}×${innerHeight}, pixel ratio ${devicePixelRatio}, interface scale ${zoomPref}`);
  out.push(`- style ${style}, scheme ${schemePref} (in use ${resolvedScheme()}), accent ${accentPref === 'default' ? 'default' : ACCENTS[accentPref] ? accentPref : 'custom colour'}, icon ${iconPref} (in use ${effectiveIcon()})`);
  out.push(`- background: mode ${bgPref.mode}${bgPref.mode === 'media' ? `, kind ${bgPref.kind}, file ${bgFile ? 'present' : 'missing'}` : ''}, dim ${bgPref.dim}, blur ${bgPref.blur}`);
  out.push(`- offline bar: ${S.offlineSince === null ? 'hidden' : 'shown'}; stale weeks ${S.stale.size}; developer mode ${DEV.on ? `on (edits: ${devIsEmpty() ? 'none' : 'some'})` : 'off'}`);
  const shown = [...document.querySelectorAll('[id]')].filter((e) => /err|fail|warn|expired|offbar/i.test(e.id) && !e.hidden && e.offsetParent !== null).map((e) => e.id);
  out.push(`- visible message elements: ${shown.join(', ') || 'none'}`);
  let keys = [];
  try { keys = Object.keys(localStorage).filter((k) => k.startsWith('openschool.')).map((k) => `${k.slice(11)}(${(localStorage.getItem(k) || '').length})`); } catch (_) { /* storage unavailable */ }
  out.push(`- stored by the page (name(length)): ${keys.join(', ') || '—'}`);
  return out;
}

const aiAgo = (s) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

async function aiBuildReport() {
  const f = await invoke('ai_facts');
  const L = [];
  L.push('# OpenSchool: diagnostic report (anonymised)');
  L.push('');
  L.push('OpenSchool is an unofficial desktop client (Rust + Tauri, web page UI) for the Russian school diary «Моя школа» on Gosuslugi: schedule, homework, marks, background notifications. This report was made by the program itself with `--ai-debug`. It contains only facts about the app and the shape of the loaded data; names, ids, subjects, teachers, texts, addresses, cookies and mark values are NOT included. Dates are relative to today. Please use it to find the cause of the problem described below the report.');
  L.push('');
  L.push('## Program');
  L.push(`- OpenSchool ${f.version} (${f.build} build), Tauri ${f.tauri}, web view ${f.webview || 'unknown'}`);
  L.push(`- ${f.os} ${f.arch}; desktop ${f.desktop || '—'}, session ${f.session_type || '—'}, language ${f.language || '—'}; tray ${f.tray ? 'available' : 'not available'}; running for ${aiAgo(f.uptime_s)}`);
  L.push('');
  L.push('## Network');
  L.push(`- mode ${f.net.mode}, direct ${f.net.direct}, last check ${f.net.reachable === null ? 'not done' : f.net.reachable ? 'server reachable' : 'server NOT reachable'}, exit country ${f.net.country || 'unknown'}`);
  L.push('');
  L.push('## Login');
  L.push(`- secret store ${f.secret_store.available ? 'available' : 'NOT available'}, saved session ${f.secret_store.has_session ? 'yes' : 'no'}; page: student ${S.student ? 'loaded' : 'not loaded'}, class info ${S.cls ? 'loaded' : 'missing'}`);
  L.push('');
  L.push('## Notifications');
  L.push(`- marks ${f.notify.marks}, homework ${f.notify.homework}, absences ${f.notify.absences}, every ${f.notify.interval_min} min, detailed ${f.notify.detail}, close to tray ${f.notify.close_to_tray}`);
  L.push('');
  L.push('## Offline copy');
  L.push(`- ${f.cache_minutes.length} weeks stored; age in minutes: ${f.cache_minutes.slice(0, 12).join(', ') || '—'}${f.cache_minutes.length > 12 ? ', …' : ''}`);
  L.push('');
  L.push('## Page');
  L.push(...aiUiFacts());
  L.push('');
  L.push('## Loaded data (shape only)');
  try { L.push(...aiShapeOfData()); } catch (e) { L.push(`- could not describe the data: ${aiScrub(e && e.message)}`); }
  L.push('');
  L.push('## Requests (newest last; kind, outcome, milliseconds)');
  if (!f.events.length) L.push('- none yet');
  for (const e of f.events.slice(-60)) L.push(`- ${aiAgo(e.seconds_ago)} ago: ${e.what} → ${e.outcome}${e.ms ? ` (${e.ms} ms)` : ''}`);
  L.push('');
  L.push('## Page errors (newest last)');
  if (!AI.errors.length) L.push('- none');
  for (const e of AI.errors.slice(-30)) L.push(`- ${aiAgo(Math.round((Date.now() - e.at) / 1000))} ago: ${e.kind}: ${e.text}`);
  L.push('');
  L.push('## Problem');
  L.push('(describe it here)');
  return invoke('ai_clean', { text: L.join('\n') });
}

let aiText = '';
async function aiRefresh() {
  $('ai-msg').textContent = 'Собираю…';
  try { aiText = await aiBuildReport(); $('ai-out').textContent = aiText; $('ai-msg').textContent = 'Готово. Отчёт без имён, номеров, текстов и оценок; перед отправкой всё равно просмотрите его глазами.'; }
  catch (e) { $('ai-msg').textContent = `Не удалось: ${e instanceof Error ? e.message : e}`; }
}
$('ai-refresh').onclick = aiRefresh;
$('ai-copy').onclick = async () => { if (!aiText) await aiRefresh(); $('ai-msg').textContent = (await copyText(aiText)) ? 'Скопировано.' : 'Не удалось скопировать: выделите текст вручную.'; };
$('ai-save').onclick = async () => {
  if (!aiText) await aiRefresh();
  try { $('ai-msg').textContent = `Сохранено: ${await invoke('ai_save', { text: aiText })}`; } catch (e) { $('ai-msg').textContent = `Не удалось сохранить: ${e}`; }
};

async function initAiDebug() {
  try { AI.on = !!(invoke && await invoke('ai_debug_mode')); } catch (_) { AI.on = false; }
  $('ai-nav').hidden = !AI.on;
}
