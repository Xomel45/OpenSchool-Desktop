'use strict';
// ---------- motion: small animations that explain what changed; all off with the system's «reduce motion» ----------
// Only transform and opacity are animated (cheap on any machine). The CSS part is under «motion» in style.css.

const motionOK = () => !(reduceMotion && reduceMotion.matches) && !!document.body.animate;
const EASE_OUT = 'cubic-bezier(.2,.7,.2,1)';

/** Items rise one after another (at most 14, so a long list does not keep moving). */
function staggerIn(root, selector) {
  if (!motionOK() || !root) return;
  const items = [...root.querySelectorAll(selector)].filter((e) => e.offsetParent !== null).slice(0, 14);
  items.forEach((it, i) => it.animate(
    [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: 260, delay: 30 + i * 28, easing: EASE_OUT, fill: 'backwards' },
  ));
}

const PAGE_ITEMS = '.ls, .tk-day, .dcol, .gr-table tbody tr, .ch-card, .block, .box.me, .up-test, .file.dl';

/** A page that has just been shown: a short rise of the page and its items. */
function pageIn(el) {
  if (!motionOK() || !el) return;
  el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE_OUT });
  staggerIn(el, PAGE_ITEMS);
}

/** A number counts up to its value (the average of the marks summary): "3,75". */
function countUp(el, value, digits) {
  if (!el || !Number.isFinite(value)) return;
  const fmt = (x) => String(Math.round(x * 10 ** digits) / 10 ** digits).replace('.', ',');
  if (!motionOK()) { el.textContent = fmt(value); return; }
  const from = Math.max(0, value - 1.5), t0 = performance.now(), dur = 600;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (value - from) * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The bell jumps when something new arrives. */
let bellLast = null;
function bellPop(unread) {
  if (bellLast !== null && unread > bellLast && motionOK()) {
    $('bell').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-14deg)' }, { transform: 'rotate(10deg)' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(0)' }], { duration: 600, easing: 'ease-out' });
    $('bell-n').animate([{ transform: 'scale(.4)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 380, easing: EASE_OUT });
  }
  bellLast = unread;
}

/** A homework ticked done: the box gives a small spring. */
document.addEventListener('change', (e) => {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox' || !cb.closest('.hw') || !motionOK()) return;
  cb.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(.9)' }, { transform: 'scale(1)' }], { duration: 320, easing: EASE_OUT });
});

/** Charts: the line is drawn from left to right, the dots follow, the bars grow from the baseline. */
function chartIn(svg) {
  if (!motionOK() || !svg) return;
  const line = svg.querySelector('.ch-line');
  if (line && line.getTotalLength) {
    const len = line.getTotalLength();
    line.style.strokeDasharray = `${len}`;
    line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 900, easing: 'cubic-bezier(.4,0,.2,1)' }).onfinish = () => { line.style.strokeDasharray = ''; };
  }
  svg.querySelectorAll('.ch-dot').forEach((d, i, all) => d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 900 * (i / Math.max(1, all.length)), fill: 'backwards' }));
  svg.querySelectorAll('.ch-bar').forEach((b, i) => b.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: i * 50, easing: EASE_OUT, fill: 'backwards' }));
  svg.querySelectorAll('.ch-val').forEach((v, i) => v.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 300 + i * 50, fill: 'backwards' }));
}
