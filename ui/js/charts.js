'use strict';
// ---------- «Графики» (a tab of the marks page): the running average of a subject over the year, absences per month ----------
// Plain inline SVG in the page's colours (one series per chart: the accent; text in the ink colours). Hover: a crosshair with a
// tooltip on the line, a tooltip per bar. Each chart has its data as a table under «Таблица».

S.chartSubject = S.chartSubject || '';
const SVGNS = 'http://www.w3.org/2000/svg';
const MON_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** Running average after each numeric mark of the subject ('' = all subjects), oldest first. */
function runningAverage(marks) {
  const out = [];
  let sum = 0, n = 0;
  for (const m of marks) {
    const v = toNum(m.value);
    if (v === null) continue;
    sum += v; n += 1;
    out.push({ m, v, avg: sum / n, d: parseDate(m.date) });
  }
  return out;
}

/** Lessons with an absence, counted per month of the range (months with none are 0). */
function absencesByMonth(start, end) {
  const months = [];
  for (let d = new Date(parseDate(start).getFullYear(), parseDate(start).getMonth(), 1); isoDate(d) <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push({ y: d.getFullYear(), m: d.getMonth(), n: 0, subjects: new Map() });
  for (const l of S.lessonsById.values()) {
    const k = l.start.slice(0, 10);
    if (!l.absence || k < start || k > end) continue;
    const d = parseDate(k), row = months.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
    if (row) { row.n += 1; row.subjects.set(l.subject_name, (row.subjects.get(l.subject_name) || 0) + 1); }
  }
  return months;
}

const el = (tag, attrs, text) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };

/** The line chart: x = date over the range, y = average 2..5 with the 3,5 and 4,5 borders. */
function drawAverage(box, pts, start, end) {
  box.textContent = '';
  const W = Math.max(320, box.clientWidth), H = 260, L = 34, R = 14, T = 12, B = 26;
  const x0 = parseDate(start).getTime(), x1 = Math.max(x0 + 864e5, Math.min(parseDate(end).getTime(), S.today.getTime() + 864e5));
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + ((5 - v) / 3) * (H - T - B); // 2..5
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ch-svg', role: 'img', 'aria-label': 'Средний балл по датам' });
  for (const v of [2, 3, 4, 5]) {
    svg.append(el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'ch-grid' }));
    svg.append(el('text', { x: L - 8, y: Y(v) + 4, class: 'ch-tick', 'text-anchor': 'end' }, String(v)));
  }
  for (const [v, label] of [[4.5, 'на 5'], [3.5, 'на 4']]) {
    svg.append(el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'ch-ref' }));
    svg.append(el('text', { x: W - R - 2, y: Y(v) - 4, class: 'ch-reflabel', 'text-anchor': 'end' }, label));
  }
  // month ticks
  for (let d = new Date(new Date(x0).getFullYear(), new Date(x0).getMonth(), 1); d.getTime() <= x1; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const t = Math.max(d.getTime(), x0);
    svg.append(el('text', { x: X(t) + (t === x0 ? 2 : 0), y: H - 8, class: 'ch-tick', 'text-anchor': t === x0 ? 'start' : 'middle' }, MON_SHORT[d.getMonth()]));
  }
  if (pts.length) {
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.d.getTime()).toFixed(1)},${Y(Math.max(2, p.avg)).toFixed(1)}`).join('');
    svg.append(el('path', { d: path, class: 'ch-line' }));
    for (const p of pts) svg.append(el('circle', { cx: X(p.d.getTime()), cy: Y(Math.max(2, p.avg)), r: 4, class: 'ch-dot' }));
  }
  const cross = el('line', { y1: T, y2: H - B, class: 'ch-cross', visibility: 'hidden' });
  const ring = el('circle', { r: 6, class: 'ch-ring', visibility: 'hidden' });
  svg.append(cross, ring);
  box.append(svg);
  const tip = document.createElement('div');
  tip.className = 'ch-tip'; tip.hidden = true;
  box.append(tip);
  if (!pts.length) return;
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect(), mx = ((e.clientX - r.left) / r.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.d.getTime()) - mx) < Math.abs(X(best.d.getTime()) - mx)) best = p;
    const px = X(best.d.getTime()), py = Y(Math.max(2, best.avg));
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    ring.setAttribute('cx', px); ring.setAttribute('cy', py); ring.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${esc(shortDate(best.m.date))}</b> · ${esc(best.m.subject_name)}<br>Оценка <span class="chip ${cls(best.m.value)}" style="min-width:20px;height:20px;font-size:11px">${esc(best.m.value)}</span>${best.m.work_name || best.m.work_type ? ` · ${esc(best.m.work_name || best.m.work_type)}` : ''}<br>Средний после неё: <b>${fmtAvg(best.avg)}</b>`;
    tip.hidden = false;
    const bx = (px / W) * r.width;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, bx + 12))}px`;
    tip.style.top = `${(py / H) * r.height - tip.offsetHeight / 2}px`;
  });
}

/** The bar chart of absences per month. */
function drawAbsences(box, months) {
  box.textContent = '';
  const W = Math.max(320, box.clientWidth), H = 200, L = 34, R = 14, T = 12, B = 26;
  const max = Math.max(4, ...months.map((m) => m.n));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const bw = (W - L - R) / months.length, Y = (v) => T + (1 - v / top) * (H - T - B);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ch-svg', role: 'img', 'aria-label': 'Пропуски по месяцам' });
  for (let v = 0; v <= top; v += step) {
    svg.append(el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'ch-grid' }));
    svg.append(el('text', { x: L - 8, y: Y(v) + 4, class: 'ch-tick', 'text-anchor': 'end' }, String(v)));
  }
  const tip = document.createElement('div');
  tip.className = 'ch-tip'; tip.hidden = true;
  months.forEach((mo, i) => {
    const x = L + i * bw, w = Math.min(36, bw - 8), cx = x + bw / 2;
    if (mo.n) {
      const y = Y(mo.n), h = H - B - y, r = Math.min(4, h);
      // rounded at the data end only, anchored to the baseline
      svg.append(el('path', { d: `M${cx - w / 2},${H - B}V${y + r}Q${cx - w / 2},${y} ${cx - w / 2 + r},${y}H${cx + w / 2 - r}Q${cx + w / 2},${y} ${cx + w / 2},${y + r}V${H - B}Z`, class: 'ch-bar' }));
      svg.append(el('text', { x: cx, y: y - 5, class: 'ch-val', 'text-anchor': 'middle' }, String(mo.n)));
    }
    svg.append(el('text', { x: cx, y: H - 8, class: 'ch-tick', 'text-anchor': 'middle' }, MON_SHORT[mo.m]));
    const hit = el('rect', { x, y: T, width: bw, height: H - T - B, class: 'ch-hit' });
    hit.addEventListener('mouseenter', () => {
      const list = [...mo.subjects.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${esc(s)}: ${n}`).join('<br>');
      tip.innerHTML = `<b>${MON_NOM[mo.m]} ${mo.y}</b><br>Пропусков: <b>${mo.n}</b>${list ? `<br>${list}` : ''}`;
      tip.hidden = false;
      const r = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, (cx / W) * r.width + 12))}px`;
      tip.style.top = `${(T / H) * r.height}px`;
    });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(hit);
  });
  box.append(svg, tip);
}

/** «Что я пропустил»: every absent lesson of the range, newest first, with its topic and the homework given that day for it. */
function missedLessons(start, end) {
  const out = [];
  for (const l of S.lessonsById.values()) {
    const date = l.start.slice(0, 10);
    if (!l.absence || date < start || date > end) continue;
    const hw = [...S.hw.values()].filter((h) => h.issue_date === date && (h.subject_id ? h.subject_id === l.subject_id : h.subject_name === l.subject_name));
    out.push({ l, date, hw });
  }
  return out.sort((a, b) => b.l.start.localeCompare(a.l.start));
}

function missedHtml(list) {
  if (!list.length) return '<span class="muted">Пропусков нет.</span>';
  return list.map(({ l, date, hw }) => `<button class="miss" data-date="${esc(date)}" data-lid="${esc(l.id)}"><b>${esc(l.subject_name)}</b><span class="muted">${esc(shortDate(date))}, ${esc(hm(l.start))}${l.absence.description ? ` · ${esc(l.absence.description)}` : ''}</span>
    <span>Тема: ${l.theme ? esc(l.theme) : '<span class="muted">не указана</span>'}</span>${hw.map((h) => `<span>Задали: ${esc(h.description || 'без текста')} <span class="muted">(на ${esc(shortDate(h.due_date))})</span></span>`).join('')}</button>`).join('');
}

function chartsHtml(subjects) {
  const opts = [['', 'Все предметы'], ...subjects.map((s) => [s, s])].map(([v, t]) => `<option value="${esc(v)}"${v === S.chartSubject ? ' selected' : ''}>${esc(t)}</option>`).join('');
  return `<div class="ch">
    <div class="ch-card"><div class="ch-head"><h3>Средний балл по датам</h3><select id="ch-subject" aria-label="Предмет">${opts}</select></div>
      <div class="ch-plot" id="ch-avg"></div><div class="ch-note muted" id="ch-avg-note"></div>
      <details class="ch-table"><summary>Таблица</summary><div id="ch-avg-table"></div></details></div>
    <div class="ch-card"><div class="ch-head"><h3>Пропуски по месяцам</h3></div>
      <div class="ch-plot" id="ch-abs"></div><div class="ch-note muted" id="ch-abs-note"></div>
      <details class="ch-table"><summary>Таблица</summary><div id="ch-abs-table"></div></details></div>
    <div class="ch-card"><div class="ch-head"><h3>Что я пропустил</h3></div><div class="miss-list" id="ch-missed"></div></div>
  </div>`;
}

function renderCharts() {
  const range = periodRange('year');
  if (!range) { $('gr-body').innerHTML = '<div class="gr-note">Нет данных о четвертях этого года.</div>'; return; }
  const marks = [...S.marks.values()].filter((m) => m.date >= range.start && m.date <= range.end).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  const subjects = [...new Set(marks.map((m) => m.subject_name))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (S.chartSubject && !subjects.includes(S.chartSubject)) S.chartSubject = '';
  $('gr-body').innerHTML = chartsHtml(subjects);
  const pts = runningAverage(marks.filter((m) => !S.chartSubject || m.subject_name === S.chartSubject));
  drawAverage($('ch-avg'), pts, range.start, range.end);
  const last = pts[pts.length - 1];
  $('ch-avg-note').textContent = last ? `Сейчас ${fmtAvg(last.avg)} по ${pts.length} оценкам. Точка: средний балл после очередной оценки.` : 'Оценок пока нет.';
  $('ch-avg-table').innerHTML = pts.length ? `<table class="gr-table"><thead><tr><th>Дата</th><th>Предмет</th><th>Оценка</th><th>Средний после</th></tr></thead><tbody>${pts.map((p) => `<tr><td>${esc(shortDate(p.m.date))}</td><td>${esc(p.m.subject_name)}</td><td>${esc(p.m.value)}</td><td>${fmtAvg(p.avg)}</td></tr>`).join('')}</tbody></table>` : '';
  const today = isoDate(S.today);
  const months = absencesByMonth(range.start, range.end < today ? range.end : today);
  drawAbsences($('ch-abs'), months);
  const total = months.reduce((a, m) => a + m.n, 0);
  $('ch-abs-note').textContent = total ? `Всего пропусков за год: ${total}.` : 'Пропусков нет.';
  $('ch-abs-table').innerHTML = `<table class="gr-table"><thead><tr><th>Месяц</th><th>Пропусков</th></tr></thead><tbody>${months.map((m) => `<tr><td>${esc(MON_SHORT[m.m])} ${m.y}</td><td>${m.n}</td></tr>`).join('')}</tbody></table>`;
  $('ch-missed').innerHTML = missedHtml(missedLessons(range.start, range.end < today ? range.end : today));
  $('ch-missed').onclick = (e) => { const b = e.target.closest('.miss'); if (b) showLessonDialog(b.dataset.date, b.dataset.lid, b); };
  $('ch-subject').onchange = (e) => { S.chartSubject = e.target.value; renderCharts(); };
}

let chartsResize = 0;
window.addEventListener('resize', () => { clearTimeout(chartsResize); chartsResize = setTimeout(() => { if (S.gp === 'charts' && !$('marksview').hidden && $('ch-avg')) renderCharts(); }, 150); });
