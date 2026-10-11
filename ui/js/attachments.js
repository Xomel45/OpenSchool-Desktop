'use strict';
// ---------- homework attachments: a click downloads the file and opens it ----------
// The program does the work (src-tauri/src/attach.rs and the Bridge): it checks the address, the size and the kind of answer, saves the
// file in the Downloads folder (OpenSchool/) and opens documents, pictures and media with the system's default program.

/** The attachment buttons of one homework (empty when it has none). */
function attHtml(h) {
  if (!h.materials || !h.materials.length) return '';
  return `<div class="atts">${h.materials.map((m, i) => `<button type="button" class="att" data-hw="${esc(h.id)}" data-i="${i}" title="Скачать и открыть">📎 ${esc(m.name || 'файл')}</button>`).join('')}</div>`;
}

let attNoteTimer = 0;
function attNote(text, ms) {
  const t = $('attnote');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(attNoteTimer);
  attNoteTimer = setTimeout(() => { t.hidden = true; }, ms || 7000);
}

/** What the user reads for a failure (the program's error texts are matched by their markers). */
function attErrorText(e) {
  const s = String(e && e.message ? e.message : e);
  if (s === 'OFFLINE') return 'Нет связи с Госуслугами: файл не скачать.';
  if (s.includes('file too big')) return 'Файл больше 50 МБ: не скачиваю.';
  if (s.includes('not a file')) return 'Сервер вернул веб-страницу вместо файла. Возможно, нужно войти заново.';
  if (s.includes('not https') || s.includes('bad link') || s.includes('user name')) return 'Ссылка вложения выглядит небезопасной: не открываю.';
  if (s.includes('HTTP 403') || s.includes('HTTP 404')) return `Сервер не отдаёт файл (${s.match(/HTTP \d+/)[0]}).`;
  return `Не удалось скачать: ${s}`;
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest && ev.target.closest('.att');
  if (!b) return;
  ev.preventDefault();
  ev.stopPropagation(); // inside a label: the checkbox of the homework must not toggle
  const h = S.hw.get(b.dataset.hw), m = h && h.materials[Number(b.dataset.i)];
  if (!m || !m.link) { attNote('У этого вложения нет ссылки.'); return; }
  if (!invoke) { attNote('Скачивание работает только в приложении.'); return; }
  b.disabled = true;
  attNote(`Скачиваю «${m.name || 'файл'}»…`, 60000);
  try {
    const r = await invoke('download_material', { link: m.link, name: m.name || '' });
    attNote(r.opened ? `Открыто. Файл сохранён: ${r.path}` : `Сохранено: ${r.path}. Этот тип файла сам не открывается.`, 9000);
  } catch (e) { attNote(attErrorText(e)); }
  b.disabled = false;
}, true);
