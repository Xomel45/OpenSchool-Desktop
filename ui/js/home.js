'use strict';
// ---------- rendering ----------
function renderStudent() {
  const s = S.student;
  const name = `${titleCase(s.first_name)} ${titleCase(s.last_name)}`.trim();
  $('sname').textContent = name;
  $('ava').textContent = ((s.first_name || '')[0] || '') + ((s.last_name || '')[0] || '');
  const c = S.cls;
  $('sclass').textContent = c ? `${c.class_number} «${c.class_letter}»${c.school_name ? ' · ' + c.school_name : ''}` : '';
}

function marksSorted() {
  const todayKey = isoDate(S.today);
  return [...S.marks.values()].filter((m) => m.date <= todayKey)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
}

function renderMarks() {
  const list = marksSorted().slice(0, 16);
  S.recent = list;
  $('marks').innerHTML = list.length
    ? list.map((m, i) => `<div class="mk" data-i="${i}"><span class="chip ${cls(m.value)}">${esc(m.value)}</span><b>${esc(m.subject_name)}</b><span class="d">${esc(shortDate(m.date))}</span></div>`).join('')
    : '<div class="muted" style="padding:6px 8px 12px">Оценок пока нет</div>';
}

function renderSched() {
  const el = $('sched');
  const { rows, orphanHw } = S.dayData;
  if (!rows.length) {
    const wd = S.cur.getDay();
    el.innerHTML = `<div class="empty">${wd === 0 || wd === 6 ? 'Выходной день' : S.cur > S.today ? 'Расписание на этот день ещё не опубликовано' : 'Уроков нет'}</div>`;
    return;
  }
  const card = (r, i) => {
    const hw = r.hw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc(h.description || 'Без текста')}</span></label>`).join('');
    const mk = r.marks.map((m) => `<span class="chip ${cls(m.value)}" style="min-width:26px;height:26px;font-size:13px">${esc(m.value)}</span>`).join(' ');
    const st = status(r.l);
    return `<div class="ls ${st}" data-i="${i}" data-sel="${S.sel === i}"><button class="lh" aria-pressed="${S.sel === i}"><div class="row"><span class="n">${r.n}</span><span class="nm">${esc(r.l.subject_name)}</span>${mk}<span class="tm">${esc(hm(r.l.start))}–${esc(hm(r.l.end))}</span></div></button>${hw}</div>`;
  };
  const extra = orphanHw.length
    ? `<div class="ls"><div class="lh" style="cursor:default"><div class="row"><span class="nm">Задания без урока</span></div></div>${orphanHw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc((h.subject_name ? h.subject_name + ': ' : '') + (h.description || ''))}</span></label>`).join('')}</div>`
    : '';
  el.innerHTML = rows.map(card).join('') + extra;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV'];
function infoHtml() {
  let q = '';
  const quarters = S.cls ? S.cls.quarters : [];
  const t = isoDate(S.today);
  const cur = quarters.find((p) => p.start_date <= t && t <= p.end_date) || quarters.find((p) => p.start_date > t);
  if (cur) {
    const a = parseDate(cur.start_date), b = parseDate(cur.end_date);
    const running = cur.start_date <= t;
    const pct = running ? Math.min(100, Math.max(0, Math.round(((S.today - a) / (b - a)) * 100))) : 0;
    const left = Math.max(0, Math.ceil((b - S.today) / 864e5));
    q = `<div class="block"><h3>Четверть</h3>${ROMAN[cur.number] || cur.number} четверть: ${a.getDate()} ${MON[a.getMonth()]} – ${b.getDate()} ${MON[b.getMonth()]}<div class="meter"><i style="width:${pct}%"></i></div><span class="muted">${running ? `прошло ${pct}%, осталось ${left} дн.` : 'ещё не началась'}</span></div>`;
  }
  return `<h1>Информация</h1><div class="sub">Четверть и школьные события</div>${q}<div class="block"><h3>Школьные мероприятия</h3><span class="muted">Пока не подключены: источник этих данных ещё не найден.</span></div>`;
}

const lessonStatusText = (l) => { const st = status(l); return st === 'now' ? 'Идёт сейчас' : st === 'past' ? 'Урок прошёл' : 'Ещё впереди'; };

/** The lesson card: used by the home panel and by the pop-up on the schedule page. */
function lessonCardHtml(r, sub) {
  const l = r.l;
  const mk = r.marks.length
    ? r.marks.map((m) => `<span class="big ${cls(m.value)}">${esc(m.value)}</span> <span style="margin:0 14px 0 8px" class="muted">${esc(m.work_name || m.work_type || '')}</span>`).join('')
    : '<span class="muted">Пока нет</span>';
  const hw = r.hw.length
    ? r.hw.map((h) => `<div>${esc(h.description || 'Без текста')}${h.materials.length ? `<div class="muted">${h.materials.map((x) => '📎 ' + esc(x.name)).join(', ')}</div>` : ''}</div>`).join('')
    : '<span class="muted">Не задано</span>';
  return `<h1>${esc(l.subject_name)}</h1><div class="sub">${esc(sub)}</div>
  <dl class="facts"><div><dt>Номер урока</dt><dd>${r.n}-й</dd></div><div><dt>Время</dt><dd>${esc(hm(l.start))}–${esc(hm(l.end))}</dd></div><div><dt>Ведёт</dt><dd>${esc(teacherName(l.teacher) || '—')}</dd></div><div><dt>Кабинет</dt><dd>${esc(l.room || '—')}</dd></div></dl>
  <div class="block"><h3>Тема урока</h3>${l.theme ? esc(l.theme) : '<span class="muted">Не указана</span>'}</div>
  <div class="block"><h3>Домашнее задание</h3>${hw}</div>
  <div class="block"><h3>Оценка</h3>${mk}${l.absence ? `<div class="abs">Пропуск: ${esc(l.absence.description || l.absence.code || 'без пояснения')}</div>` : ''}</div>`;
}

function renderMain() {
  const el = $('main');
  if (S.sel === null) { el.innerHTML = infoHtml(); return; }
  const r = S.dayData.rows[S.sel];
  if (!r) { S.sel = null; el.innerHTML = infoHtml(); return; }
  el.innerHTML = `<button class="back" id="back">← Информация</button>${lessonCardHtml(r, lessonStatusText(r.l))}`;
  $('back').onclick = () => { S.sel = null; renderSched(); renderMain(); };
}

// ---------- day navigation ----------
function renderNavLabel() {
  const c = S.cur, diff = Math.round((c - S.today) / 864e5);
  $('dlabel').textContent = `${WD[c.getDay()][0].toUpperCase()}${WD[c.getDay()].slice(1)}, ${c.getDate()} ${MON[c.getMonth()]}`;
  $('dsub').textContent = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера' : diff > 0 ? `через ${diff} дн.` : `${-diff} дн. назад`;
  $('prev').disabled = c <= S.min;
  $('next').disabled = c >= S.max;
  $('gotoday').style.visibility = diff === 0 ? 'hidden' : 'visible';
}

async function setDay(d) {
  if (d < S.min || d > S.max) return;
  const dir = S.cur ? Math.sign(d - S.cur) : 0;
  S.cur = new Date(d);
  S.sel = null;
  const token = ++S.token;
  renderNavLabel();
  S.dayData = buildDay(S.cur);
  if (!S.weekReqs.has(`${isoWeek(S.cur).year}-${isoWeek(S.cur).week}`)) {
    $('sched').innerHTML = '<div class="empty">Загрузка…</div>';
  }
  try {
    await loadWeek(S.cur);
  } catch (e) {
    if (token !== S.token) return;
    S.dayError = true;
    renderLoadError($('sched'), e, () => setDay(S.cur), true);
    return;
  }
  if (token !== S.token) return; // the user moved on while loading
  S.dayError = false;
  S.dayData = buildDay(S.cur);
  renderSched();
  renderMain();
  renderMarks();
  slideIn($('sched'), dir);
}
const step = (n) => setDay(addDays(S.cur, n));
