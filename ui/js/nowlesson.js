'use strict';
// ---------- «Сейчас идёт урок»: the window title and the tray say what is on (src-tauri/src/tray.rs `set_now`) ----------
// Every 30 seconds from today's lessons: the lesson on now and the minutes left, the next lesson during a break, the first lesson
// in the morning; nothing after the last one. Switched off in Настройки → Уведомления → Окно.

const minutesWord = (n) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'минута' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'минуты' : 'минут'; };
const inMin = (n) => `через ${n} ${minutesWord(n) === 'минута' ? 'минуту' : minutesWord(n)}`; // «через 1 минуту», «через 3 минуты»

/** The text for the lessons of one day at the moment `now` ("" = nothing to say). Lessons sorted by start. */
function nowText(lessons, now) {
  const room = (l) => (l.room ? `, каб. ${l.room}` : '');
  for (let i = 0; i < lessons.length; i++) {
    const l = lessons[i], a = parseDT(l.start), b = parseDT(l.end);
    if (now < a) {
      const left = Math.ceil((a - now) / 6e4);
      return i === 0 ? `Первый урок: ${l.subject_name} в ${hm(l.start)}${room(l)}` : `Перемена · дальше ${l.subject_name}${room(l)} ${inMin(left)}`;
    }
    if (now < b) {
      const left = Math.ceil((b - now) / 6e4);
      return `Сейчас: ${l.subject_name}${room(l)} · до конца ${left} ${minutesWord(left)}`;
    }
  }
  return '';
}

let nowLast = null;
function nowTick() {
  if (!invoke || !S.today) return;
  let text = '';
  if (pref.get('nowtitle', '1') === '1' && !$('app').hidden) {
    const now = new Date(), day = new Date(now); day.setHours(0, 0, 0, 0);
    text = nowText(buildDay(day).rows.map((r) => r.l), now);
  }
  if (text === nowLast) return;
  nowLast = text;
  invoke('set_now', { text }).catch(() => {});
}
setInterval(nowTick, 30000);

$('nt-now').checked = pref.get('nowtitle', '1') === '1';
$('nt-now').onchange = (e) => { pref.set('nowtitle', e.target.checked ? '1' : '0'); nowTick(); };
