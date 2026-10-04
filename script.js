'use strict';

const API = {
  chatStart: 'https://elik.app.n8n.cloud/webhook/cognix-chat',
  chatStatus: 'https://elik.app.n8n.cloud/webhook/cognix-chat-status',
  fitStart: 'https://elik.app.n8n.cloud/webhook/cognix-fit',
  fitStatus: 'https://elik.app.n8n.cloud/webhook/cognix-fit-status',
};
const POLL_EVERY_MS = 2000;
const POLL_CAP_MS = 90000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STATUS_FAILURES = 3; // consecutive failed status checks before giving up
const CONTACT_EMAIL = 'eli.tkg@gmail.com';
const WRITE_US = `כתבו לנו: ${CONTACT_EMAIL}`;

const CHAT_ERRORS = {
  offline: { title: 'אין חיבור לאינטרנט', action: 'בדקו את החיבור ולחצו "נסו שוב".' },
  unreachable: { title: 'תמיר לא זמין כרגע', action: `השרת לא ענה. נסו שוב בעוד דקה, או ${WRITE_US}` },
  server: { title: 'תמיר החזיר שגיאה', action: `נסו שוב בעוד דקה. אם זה חוזר, ${WRITE_US}` },
  failed: { title: 'תמיר נתקל בתקלה בעיבוד השאלה', action: 'נסו לנסח את השאלה מחדש ולשלוח שוב.' },
  notFound: { title: 'הבקשה לא נמצאה במערכת', action: 'ייתכן שהיא פגה. שלחו את השאלה שוב.' },
  timeout: { title: 'תמיר מתעכב יותר מהרגיל', action: `נסו שוב, או ${WRITE_US}` },
};

const FIT_ERRORS = {
  offline: { title: 'אין חיבור לאינטרנט', action: 'בדקו את החיבור ולחצו "נסו שוב". הפרטים שמילאתם נשמרו בטופס.' },
  unreachable: { title: 'בדיקת המוכנות לא זמינה כרגע', action: `השרת לא ענה. נסו שוב בעוד דקה, או ${WRITE_US}` },
  server: { title: 'בדיקת המוכנות החזירה שגיאה', action: `נסו שוב בעוד דקה. אם זה חוזר, ${WRITE_US}` },
  failed: { title: 'הבדיקה נכשלה באמצע', action: `נסו לשלוח שוב. אם זה חוזר, ${WRITE_US}` },
  notFound: { title: 'הבקשה לא נמצאה במערכת', action: 'שלחו את הטופס שוב.' },
  timeout: { title: 'הבדיקה מתעכבת יותר מהרגיל', action: 'ייתכן שהדוח עוד יגיע למייל. אפשר גם לנסות שוב.' },
  busy: { title: 'המערכת עמוסה כרגע', action: `נסו שוב מחר, או ${WRITE_US}` },
};

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =====================================================================
   Shared: network + polling
   ===================================================================== */
class JobError extends Error {
  constructor(kind, data) { super(kind); this.kind = kind; this.data = data; }
}

async function fetchJson(url, options = {}) {
  if (!navigator.onLine) throw new JobError('offline');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    throw new JobError(navigator.onLine ? 'unreachable' : 'offline');
  } finally {
    clearTimeout(t);
  }
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  if (res.status === 400 && data && data.error) throw new JobError('invalid', data);
  if (res.status === 429 || res.status === 503) throw new JobError('busy', data);
  if (!res.ok || !data) throw new JobError('server');
  return data;
}

async function startJob(url, body) {
  const job = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!job.jobId) throw new JobError('server');
  return job.jobId;
}

// Polls until the job leaves "pending". onUpdate receives every status response.
async function pollJob(statusUrl, jobId, startedAt, onUpdate) {
  let failures = 0;
  for (;;) {
    if (Date.now() - startedAt > POLL_CAP_MS) throw new JobError('timeout');
    await sleep(POLL_EVERY_MS);
    let status;
    try {
      status = await fetchJson(`${statusUrl}?jobId=${encodeURIComponent(jobId)}`);
      failures = 0;
    } catch (err) {
      // A single dropped status check is not fatal; keep polling.
      failures += 1;
      if (failures >= MAX_STATUS_FAILURES) throw err;
      continue;
    }
    if (onUpdate) onUpdate(status);
    if (status.status === 'pending') continue;
    if (status.status === 'done') return status;
    if (status.status === 'not_found') throw new JobError('notFound');
    throw new JobError('failed');
  }
}

/* Waiting card with real steps, a live clock and an error box with retry. */
function createJobCard(container, steps, scrollEl = container) {
  const card = document.createElement('div');
  card.className = 'job';
  card.setAttribute('aria-live', 'polite');
  const list = document.createElement('ol');
  list.className = 'job-steps';
  for (const s of steps) {
    const li = document.createElement('li');
    li.dataset.step = s.key;
    li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label"></span><span class="meta"></span>';
    li.querySelector('.label').textContent = s.label;
    list.appendChild(li);
  }
  card.appendChild(list);
  container.appendChild(card);
  const scroll = () => { scrollEl.scrollTop = scrollEl.scrollHeight; };
  scroll();

  const step = (key) => card.querySelector(`[data-step="${key}"]`);
  let clock;
  return {
    el: card,
    active(key) { step(key).classList.add('active'); },
    done(key) { const li = step(key); li.classList.remove('active'); li.classList.add('done'); },
    // Marks every step before `key` done and `key` active (for server-reported stages).
    reach(key) {
      let seen = false;
      for (const s of steps) {
        const li = step(s.key);
        if (s.key === key) { seen = true; if (!li.classList.contains('done')) li.classList.add('active'); }
        else if (!seen) { li.classList.remove('active'); li.classList.add('done'); }
      }
    },
    finish() { clearInterval(clock); for (const s of steps) this.done(s.key); },
    meta(key, node) { step(key).querySelector('.meta').replaceChildren(node); },
    showJobId(key, jobId) {
      const idEl = document.createElement('bdi');
      idEl.dir = 'ltr';
      idEl.className = 'job-id';
      idEl.textContent = `#${jobId}`;
      this.meta(key, idEl);
    },
    startClock(key, startedAt) {
      const seconds = document.createElement('span');
      const tick = () => { seconds.textContent = `${Math.round((Date.now() - startedAt) / 1000)} שנ׳`; };
      tick();
      this.meta(key, seconds);
      clock = setInterval(tick, 1000);
    },
    error(info, onRetry) {
      clearInterval(clock);
      card.querySelectorAll('.active').forEach((li) => li.classList.replace('active', 'failed'));
      const box = document.createElement('div');
      box.className = 'job-error';
      box.setAttribute('role', 'alert');
      const title = document.createElement('b');
      title.textContent = info.title;
      const action = document.createElement('p');
      action.textContent = info.action;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = 'נסו שוב';
      retry.addEventListener('click', () => { box.remove(); onRetry(); }, { once: true });
      box.append(title, action, retry);
      card.appendChild(box);
      scroll();
    },
  };
}

/* =====================================================================
   Chat with תמיר
   ===================================================================== */
const chat = $('#chat');
const messages = $('#messages');
const composer = $('#composer');
const input = $('#chatInput');
const sendBtn = $('#sendBtn');
const chips = $('#chips');
const chatState = $('#chatState');
let chatBusy = false;
let chatOpener = null;

const sessionId = (() => {
  const make = () => (crypto.randomUUID ? crypto.randomUUID() : `cognix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    let id = localStorage.getItem('cognix_chat_session');
    if (!id) { id = make(); localStorage.setItem('cognix_chat_session', id); }
    return id;
  } catch {
    return make();
  }
})();

// Plain text with clickable links; never injects HTML from the server.
function fillWithLinks(el, text) {
  const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      // Trailing sentence punctuation stays outside the link (put back as text).
      const m = part.match(/^(.*?)([.,;:!?״"']+)$/);
      const url = m ? m[1] : part;
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.dir = 'ltr';
      el.appendChild(a);
      if (m) el.appendChild(document.createTextNode(m[2]));
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}

function addBubble(text, who) {
  const b = document.createElement('div');
  b.className = `bubble ${who}`;
  b.dir = 'auto';
  fillWithLinks(b, text);
  messages.appendChild(b);
  messages.scrollTop = messages.scrollHeight;
  return b;
}

const CHAT_STEPS = [
  { key: 'sent', label: 'נשלח' },
  { key: 'job', label: 'התקבל מספר עבודה' },
  { key: 'working', label: 'תמיר מחפש ומנסח תשובה' },
  { key: 'done', label: 'התקבלה תשובה' },
];

function setChatBusy(on) {
  chatBusy = on;
  sendBtn.disabled = on;
  chatState.textContent = on ? '● עובד על תשובה' : '● זמין';
  chatState.classList.toggle('is-busy', on);
}

async function ask(text) {
  if (chatBusy) return;
  setChatBusy(true);
  const card = createJobCard(messages, CHAT_STEPS);
  const startedAt = Date.now();
  try {
    card.active('sent');
    const jobId = await startJob(API.chatStart, { chatInput: text, sessionId });
    card.done('sent');
    card.showJobId('job', jobId);
    card.done('job');
    card.active('working');
    card.startClock('working', startedAt);
    const status = await pollJob(API.chatStatus, jobId, startedAt);
    if (!status.reply) throw new JobError('failed');
    card.finish();
    addBubble(status.reply, 'bot');
    setTimeout(() => card.el.remove(), 1200);
  } catch (err) {
    const kind = err instanceof JobError && CHAT_ERRORS[err.kind] ? err.kind : 'server';
    console.warn('[cognix-chat]', kind, err);
    card.error(CHAT_ERRORS[kind], () => { card.el.remove(); ask(text); });
  } finally {
    setChatBusy(false);
  }
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function submitChat(text) {
  const t = text.trim();
  if (!t || chatBusy) return;
  addBubble(t, 'user');
  input.value = '';
  autoGrow();
  ask(t);
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  submitChat(input.value);
});

// Enter sends, Shift+Enter adds a line (as in claude.ai).
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitChat(input.value);
  }
});
input.addEventListener('input', autoGrow);

chips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) submitChat(chip.textContent);
});

// Native modal <dialog>: the browser keeps focus inside it and closes it on Esc.
function openChat(opener) {
  chatOpener = opener || document.activeElement;
  if (!chat.open) chat.showModal();
  syncVisibleHeight();
  input.focus();
  messages.scrollTop = messages.scrollHeight;
}

chat.addEventListener('close', () => {
  if (chatOpener && typeof chatOpener.focus === 'function') chatOpener.focus();
});
$('#chatClose').addEventListener('click', () => chat.close());
// A click on the backdrop (outside the chat window) closes it.
chat.addEventListener('click', (e) => { if (e.target === chat) chat.close(); });

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-open-chat]');
  if (!trigger) return;
  e.preventDefault();
  openChat(trigger);
});

/* =====================================================================
   Readiness check (automation)
   ===================================================================== */
const fitForm = $('#fitForm');
const fitPanel = $('#fitPanel');
const fitIntro = $('#fitIntro');
const fitSubmit = $('#fitSubmit');
const fitFormError = $('#fitFormError');

const FIT_STEPS = [
  { key: 'received', label: 'הפרטים התקבלו' },
  { key: 'scoring', label: 'מחשבים ציון ומסלול' },
  { key: 'writing', label: 'כותבים דוח אישי' },
  { key: 'sending', label: 'שומרים ושולחים למייל' },
];

function readFitForm() {
  const f = new FormData(fitForm);
  return {
    name: String(f.get('name') || '').trim(),
    email: String(f.get('email') || '').trim(),
    org: String(f.get('org') || '').trim(),
    industry: f.get('industry'),
    size: f.get('size'),
    users: Number(f.get('users')),
    tools: f.getAll('tools'),
    internal: f.get('internal'),
    painPoints: f.getAll('painPoints'),
    aiUse: f.get('aiUse'),
    consent: f.get('consent') === 'on',
    website: String(f.get('website') || ''),
  };
}

function fieldControls(field) {
  const ctl = fitForm.elements[field];
  if (!ctl) return [];
  return ctl.length !== undefined && !ctl.tagName ? Array.from(ctl) : [ctl];
}

function clearFieldErrors() {
  fitForm.querySelectorAll('[aria-invalid="true"]').forEach((c) => c.removeAttribute('aria-invalid'));
  fitForm.querySelectorAll('.field-error').forEach((box) => { box.hidden = true; box.textContent = ''; });
}

// Shows the message next to the field it belongs to (the server's `field`, or the first invalid control).
function showFieldError(field, message) {
  const controls = fieldControls(field);
  controls.forEach((c) => c.setAttribute('aria-invalid', 'true'));
  const wrap = fitForm.querySelector(`[data-field="${field}"]`);
  const box = (wrap && wrap.querySelector('.field-error')) || fitFormError;
  box.textContent = message;
  box.hidden = false;
  if (controls[0] && field !== 'website') controls[0].focus({ preventScroll: false });
}

const nis = (n) => `${Number(n || 0).toLocaleString('en-US')} ₪`;
// Wraps numeric ranges such as "0.5–1" in LTR isolates so RTL text does not flip them.
const iso = (t) => String(t == null ? '' : t).replace(/(\d[\d.,]*\s?[–-]\s?\d[\d.,]*)/g, '\u2066$1\u2069');
function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = iso(text);
  return node;
}

function renderFitResult(result) {
  const box = make('div', 'fit-result');
  box.tabIndex = -1;

  const score = Math.max(0, Math.min(100, Number(result.score) || 0));
  box.append(make('p', 'eyebrow', 'ציון המוכנות שלכם'));
  const scoreRow = make('p', 'fit-score');
  scoreRow.append(make('b', '', String(score)), make('span', '', result.label || ''), make('small', '', 'מתוך 100'));
  const meter = make('div', 'fit-meter');
  meter.setAttribute('aria-hidden', 'true');
  const fill = make('i');
  fill.style.width = `${score}%`;
  meter.append(fill);
  box.append(scoreRow, meter);

  box.append(make('p', 'eyebrow', 'המסלול המומלץ'));
  const track = make('h3', '', result.track || '');
  track.dir = 'auto';
  box.append(track);
  if (result.summary) box.append(make('p', '', result.summary));

  const lines = Array.isArray(result.lines) ? result.lines : [];
  if (lines.length) {
    const list = make('ul', 'fit-lines');
    for (const l of lines) {
      const li = make('li');
      const label = make('span', '', l.label);
      label.dir = 'auto';
      li.append(label, make('b', '', `החל מ-${nis(l.price)}`), make('small', '', l.unit || ''));
      list.append(li);
    }
    box.append(list);
  }
  box.append(make('p', 'fit-range', `הערכה ראשונית: ${nis(result.min)} עד ${nis(result.max)} לפני מע"מ. המחיר הסופי ייקבע אחרי שיחת היכרות.`));

  if (result.hours) {
    const hours = make('div', 'fit-hours');
    const hoursLine = make('p', 'fit-hours-line', `הערכת חיסכון: ${result.hours.low} עד ${result.hours.high} שעות בשבוע`);
    hoursLine.append(' ', make('span', 'fit-tag', 'הערכה גסה, לא הבטחה'));
    hours.append(hoursLine);
    if (result.hours.assumption) hours.append(make('p', '', result.hours.assumption));
    box.append(hours);
  }

  const recs = (Array.isArray(result.recommendations) ? result.recommendations : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .slice(0, 3);
  if (recs.length) {
    box.append(make('p', 'eyebrow', recs.length === 1 ? 'המלצה' : 'המלצות'));
    const ol = make('ol', 'fit-recs');
    for (const r of recs) ol.append(make('li', '', r));
    box.append(ol);
  }

  const notes = Array.isArray(result.notes) ? result.notes : [];
  if (notes.length) {
    box.append(make('p', 'eyebrow', 'כדאי לדעת'));
    const ul = make('ul', 'fit-notes');
    for (const n of notes) ul.append(make('li', '', n));
    box.append(ul);
  }

  const mail = make('p', result.emailSent ? 'fit-mail ok' : 'fit-mail warn');
  if (result.emailSent) {
    mail.append('✓ הדוח המלא נשלח אל ');
    const addr = make('bdi', '', result.email || '');
    addr.dir = 'ltr';
    mail.append(addr, '.');
  } else {
    mail.textContent = `התוצאה מוצגת כאן, אבל לא הצלחנו לשלוח את הדוח למייל. בדקו שהכתובת נכונה, או ${WRITE_US}`;
  }
  box.append(mail);

  const actions = make('div', 'fit-actions');
  const toChat = make('button', 'btn', 'יש שאלות? דברו עם תמיר');
  toChat.type = 'button';
  toChat.dataset.openChat = '';
  const again = make('button', 'btn btn-ghost', 'בדיקה חדשה');
  again.type = 'button';
  again.addEventListener('click', () => {
    fitPanel.replaceChildren(fitIntro);
    fitForm.reset();
    clearFieldErrors();
    fitForm.elements.name.focus();
  });
  actions.append(toChat, again);
  box.append(actions, make('p', 'fit-note', 'זוהי הערכה ראשונית לפי המחירון ולא הצעת מחיר מחייבת. מנוי Claude משולם ישירות ל-Anthropic ואינו כלול.'));
  return box;
}

let fitBusy = false;

async function runFit(data) {
  if (fitBusy) return;
  fitBusy = true;
  fitSubmit.disabled = true;
  clearFieldErrors();
  fitPanel.replaceChildren();
  const card = createJobCard(fitPanel, FIT_STEPS, fitPanel);
  if (window.matchMedia('(max-width: 900px)').matches) fitPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const startedAt = Date.now();
  try {
    card.active('received');
    const jobId = await startJob(API.fitStart, data);
    card.showJobId('received', jobId);
    card.reach('scoring');
    card.startClock('scoring', startedAt);
    const status = await pollJob(API.fitStatus, jobId, startedAt, (s) => {
      if (s.status === 'pending' && FIT_STEPS.some((x) => x.key === s.stage)) card.reach(s.stage);
    });
    if (!status.result) throw new JobError('failed');
    card.finish();
    await sleep(500);
    const view = renderFitResult(status.result);
    fitPanel.replaceChildren(view);
    view.focus({ preventScroll: true });
  } catch (err) {
    if (err instanceof JobError && err.kind === 'invalid') {
      fitPanel.replaceChildren(fitIntro);
      showFieldError(err.data.field, err.data.error);
    } else {
      const kind = err instanceof JobError && FIT_ERRORS[err.kind] ? err.kind : 'server';
      console.warn('[cognix-fit]', kind, err);
      const info = kind === 'busy' && err.data && typeof err.data.error === 'string'
        ? { ...FIT_ERRORS.busy, action: err.data.error }
        : FIT_ERRORS[kind];
      card.error(info, () => { runFit(data); });
    }
  } finally {
    fitBusy = false;
    fitSubmit.disabled = false;
  }
}

// Fixing a field clears its error right away.
fitForm.addEventListener('input', (e) => {
  const name = e.target.name;
  if (!name) return;
  fieldControls(name).forEach((c) => c.removeAttribute('aria-invalid'));
  const wrap = fitForm.querySelector(`[data-field="${name}"]`);
  const box = wrap && wrap.querySelector('.field-error');
  if (box) box.hidden = true;
});

fitForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearFieldErrors();
  const bad = fitForm.querySelector('input:invalid');
  if (bad) {
    const withMsg = fitForm.querySelector(`[name="${bad.name}"][data-msg]`);
    showFieldError(bad.name, (withMsg && withMsg.dataset.msg) || 'נא להשלים את השדה המסומן.');
    return;
  }
  const data = readFitForm();
  if (!data.painPoints.length) {
    showFieldError('painPoints', 'נא לבחור לפחות תחום אחד שגוזל זמן.');
    return;
  }
  runFit(data);
});

/* =====================================================================
   Keep the chat composer visible above the mobile keyboard
   ===================================================================== */
function keepComposerVisible() {
  if (document.activeElement !== input) return;
  composer.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
input.addEventListener('focus', () => setTimeout(keepComposerVisible, 300));

// Expose the visible height so CSS can size the full-screen chat while the keyboard is open.
function syncVisibleHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${Math.round(h)}px`);
}
syncVisibleHeight();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { syncVisibleHeight(); keepComposerVisible(); });
} else {
  window.addEventListener('resize', syncVisibleHeight);
}
