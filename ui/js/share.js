'use strict';
// ---------- «Скопировать задания»: the homework of a day as one plain text for a class chat ----------

/** «Задания на четверг, 16 октября:» + one numbered line per homework (subject: text, files). Empty when there is none. */
function homeworkText(d) {
  const { rows, orphanHw } = buildDay(d);
  const lines = [];
  for (const r of rows) for (const h of r.hw) lines.push({ s: r.l.subject_name, h });
  for (const h of orphanHw) lines.push({ s: h.subject_name || 'Без предмета', h });
  if (!lines.length) return '';
  const head = `Задания на ${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}:`;
  const body = lines.map(({ s, h }, i) => {
    const files = (h.materials || []).map((m) => m.name || 'файл');
    return `${i + 1}. ${s}: ${(h.description || 'без текста').replace(/\s+/g, ' ').trim()}${files.length ? ` (файлы: ${files.join(', ')})` : ''}`;
  });
  return [head, ...body].join('\n');
}

$('tk-body').addEventListener('click', async (e) => {
  const b = e.target.closest('.tk-copy');
  if (!b) return;
  e.stopPropagation();
  const text = homeworkText(parseDate(b.dataset.date));
  if (!text) return;
  const ok = await copyText(text);
  b.textContent = ok ? '✓ Скопировано' : 'Не вышло';
  setTimeout(() => { if (b.isConnected) b.textContent = 'Копировать'; }, 2000);
});
