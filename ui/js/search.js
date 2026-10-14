'use strict';
// ---------- search: homework, lesson topics, marks, my notes and attachment names of the whole school year so far ----------
// Opened by the 🔍 button, Ctrl+K or «/». The first search loads the weeks that are not loaded yet (four at a time); a result opens
// its lesson. Words are matched in any order, «ё» = «е», case does not matter.

const SEARCH_LIMIT = 120;
const normText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
let searchAllLoaded = false;

/** Load every week from the start of the year to the last published one (once per run). */
async function searchLoadAll(progress) {
  if (searchAllLoaded) return;
  const weeks = [];
  for (let m = mondayOf(S.min); m <= S.max; m = addDays(m, 7)) weeks.push(m);
  let n = 0;
  for (let i = 0; i < weeks.length; i += 4) {
    await Promise.all(weeks.slice(i, i + 4).map((m) => loadWeek(m).catch(() => null)));
    n = Math.min(weeks.length, i + 4);
    progress(n, weeks.length);
  }
  searchAllLoaded = true;
}

/** Everything searchable as flat items: { kind, date (Date), lid, dateKey, title, text, extra }. */
function searchItems() {
  const items = [];
  const lessonDate = (id) => { const l = S.lessonsById.get(id); return l ? l.start.slice(0, 10) : null; };
  for (const l of S.lessonsById.values()) {
    if (l.theme) items.push({ kind: 'Тема урока', dateKey: l.start.slice(0, 10), lid: l.id, title: l.subject_name, text: l.theme });
    for (const n of notesOf(l.id)) items.push({ kind: 'Заметка', dateKey: l.start.slice(0, 10), lid: l.id, title: l.subject_name, text: n.t });
  }
  for (const h of S.hw.values()) {
    const lid = h.due_lesson_id && S.lessonsById.has(h.due_lesson_id) ? h.due_lesson_id : null;
    items.push({ kind: 'Задание', dateKey: h.due_date, lid, title: h.subject_name, text: h.description || '' });
    for (const m of h.materials || []) items.push({ kind: 'Файл', dateKey: h.due_date, lid, title: h.subject_name, text: m.name || 'файл' });
  }
  for (const m of S.marks.values()) {
    const lid = m.lesson_id && S.lessonsById.has(m.lesson_id) ? m.lesson_id : null;
    items.push({ kind: 'Оценка', dateKey: (lid && lessonDate(lid)) || m.date, lid, title: m.subject_name, text: [m.work_name, m.work_type, m.comment].filter(Boolean).join(' · '), value: m.value });
  }
  return items;
}

/** Escaped text with the query words wrapped in <mark>. */
function searchMark(text, words) {
  const src = String(text || '');
  const low = normText(src);
  const hits = [];
  for (const w of words) { let i = low.indexOf(w); while (w && i >= 0) { hits.push([i, i + w.length]); i = low.indexOf(w, i + w.length); } }
  hits.sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (const [a, b] of hits) { if (a < at) continue; out += esc(src.slice(at, a)) + '<mark>' + esc(src.slice(a, b)) + '</mark>'; at = b; }
  return out + esc(src.slice(at));
}

function searchRun(q) {
  const words = normText(q).split(/\s+/).filter(Boolean);
  const box = $('search-res');
  if (!words.length) { box.innerHTML = '<div class="muted s-empty">Задания, темы уроков, оценки, заметки и файлы за весь учебный год.</div>'; return; }
  const found = searchItems().filter((it) => { const hay = normText(`${it.title} ${it.text} ${it.kind}`); return words.every((w) => hay.includes(w)); });
  found.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  if (!found.length) { box.innerHTML = '<div class="muted s-empty">Ничего не найдено.</div>'; return; }
  const shown = found.slice(0, SEARCH_LIMIT);
  box.innerHTML = `<div class="muted s-count">Найдено: ${found.length}${found.length > shown.length ? `, показаны первые ${shown.length}` : ''}</div>` + shown.map((it) => {
    const d = parseDate(it.dateKey);
    const when = d ? `${d.getDate()} ${MON_SHORT[d.getMonth()]}` : '';
    const chip = it.value ? `<span class="chip ${cls(it.value)}" style="min-width:24px;height:24px;font-size:12px">${esc(it.value)}</span>` : '';
    return `<button class="s-item" ${it.lid ? `data-date="${esc(it.dateKey)}" data-lid="${esc(it.lid)}"` : 'disabled'}><span class="s-kind">${esc(it.kind)}</span>${chip}<span class="s-main"><b>${searchMark(it.title, words)}</b><span>${searchMark(it.text, words) || '<span class="muted">без текста</span>'}</span></span><span class="s-when">${esc(when)}</span></button>`;
  }).join('');
}

let searchTimer = 0;
async function openSearch() {
  const dlg = $('searchdlg');
  if (dlg.open) { $('search-q').focus(); return; }
  dlg.showModal();
  $('search-q').select();
  searchRun($('search-q').value);
  if (!searchAllLoaded) {
    $('search-load').hidden = false;
    try { await searchLoadAll((n, all) => { $('search-load').textContent = `Загружаю недели учебного года: ${n} из ${all}…`; }); } catch (_) { /* what is loaded is searched */ }
    $('search-load').hidden = true;
    if (dlg.open) searchRun($('search-q').value);
  }
}

$('search-btn').onclick = openSearch;
$('search-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchRun($('search-q').value), 120); });
$('search-close').onclick = () => $('searchdlg').close();
$('search-res').addEventListener('click', (e) => {
  const b = e.target.closest('.s-item[data-lid]');
  if (!b) return;
  $('searchdlg').close();
  showLessonDialog(b.dataset.date, b.dataset.lid, $('search-btn'));
});
document.addEventListener('keydown', (e) => {
  if ($('app').hidden || document.querySelector('dialog[open]:not(#searchdlg)')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) || (e.key === '/' && !typing)) { e.preventDefault(); openSearch(); }
});
