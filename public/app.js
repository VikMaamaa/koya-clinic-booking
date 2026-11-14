const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_STORE = 'koya-booking-email';
const desktop = window.matchMedia('(min-width: 900px)');

const state = {
  slots: [],
  slotById: {},
  slotsSignature: '',
  provider: '',
  day: null,
  selectedId: null,
  booking: null,
  idemKey: null,
  cooldown: null,
  lookupEmail: '',
  nextCursor: null,
};

// ---------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA');
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const fmtWhen = (slot) => `${fmtDate(slot.start)} · ${fmtTime(slot.start)} – ${fmtTime(slot.end)}`;
const initials = (name) => name.replace(/^dr\.?\s+/i, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const shortRef = (id) => id.replace(/-/g, '').slice(0, 8).toUpperCase();
const isBookable = (s) => !!s && s.available && new Date(s.start) > new Date();
const isPast = (s) => !!s && new Date(s.start) <= new Date();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timezoneLabel() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = new Intl.DateTimeFormat([], { timeZoneName: 'short' })
    .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  return `Times are shown in your timezone (${zone}${offset ? `, ${offset}` : ''}).`;
}

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

// ---------- API

class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-API-Key': window.API_KEY, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, Number(res.headers.get('Retry-After')) || 0);
  }
  return data;
}

// Only network failures are retried. The Idempotency-Key stays the same, so a request
// that reached the server before the connection dropped can't create a second booking.
async function withNetworkRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError || i >= attempts) throw err;
      await sleep(600 * i);
    }
  }
}

// ---------- slots

async function loadSlots({ quiet = false } = {}) {
  if (!quiet && !state.slots.length) renderSkeleton();
  try {
    const { slots } = await api('GET', '/slots');
    const signature = JSON.stringify(slots);
    if (quiet && signature === state.slotsSignature) return;
    state.slotsSignature = signature;
    state.slots = slots;
    state.slotById = Object.fromEntries(slots.map((s) => [s.id, s]));

    if (state.selectedId && !isBookable(state.slotById[state.selectedId])) {
      clearSelection();
      toast('Sorry, that time was just taken. Please choose another.');
    }
    renderPicker();
  } catch {
    if (quiet) return;
    $('days').replaceChildren();
    $('times').replaceChildren(el('div', { class: 'empty' },
      el('p', { text: 'We couldn’t load available times.' }),
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Try again', onclick: () => loadSlots() })));
  }
}

function renderSkeleton() {
  $('days').replaceChildren(...Array.from({ length: 5 }, () => el('div', { class: 'skeleton skeleton-day', 'aria-hidden': 'true' })));
  $('times').replaceChildren(el('div', { class: 'time-grid', 'aria-hidden': 'true' },
    ...Array.from({ length: 8 }, () => el('div', { class: 'skeleton skeleton-time' }))));
}

function renderPicker() {
  const providers = [...new Set(state.slots.map((s) => s.provider))].sort();
  if (state.provider && !providers.includes(state.provider)) state.provider = '';
  renderProviders(providers);

  const byDay = new Map();
  for (const s of state.slots) {
    if (!isBookable(s) || (state.provider && s.provider !== state.provider)) continue;
    const key = dayKey(s.start);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }
  if (!byDay.has(state.day)) state.day = byDay.keys().next().value ?? null;

  renderDays(byDay);
  renderTimes(byDay.get(state.day) ?? []);
}

function renderProviders(providers) {
  const chip = (value, label) => el('button', {
    type: 'button',
    class: value ? 'chip' : 'chip all',
    'aria-pressed': String(state.provider === value),
    onclick: () => { state.provider = value; renderPicker(); },
  }, value ? el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(value) }) : null, label);
  $('providers').replaceChildren(chip('', 'All doctors'), ...providers.map((p) => chip(p, p)));
}

function renderDays(byDay) {
  $('days').replaceChildren(...[...byDay.keys()].map((key) => {
    const date = new Date(`${key}T12:00:00`);
    const selected = key === state.day;
    const count = byDay.get(key).length;
    return el('button', {
      type: 'button',
      class: 'day',
      role: 'tab',
      'aria-selected': String(selected),
      tabindex: selected ? '0' : '-1',
      'data-day': key,
      'aria-label': `${date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, ${count} free`,
      onclick: () => selectDay(key),
    },
      el('span', { class: 'dow', text: date.toLocaleDateString([], { weekday: 'short' }) }),
      el('span', { class: 'num', text: String(date.getDate()) }),
      el('span', { class: 'count', text: `${count} free` }));
  }));
}

function selectDay(key, focus = false) {
  state.day = key;
  renderPicker();
  if (focus) $('days').querySelector(`[data-day="${key}"]`)?.focus();
}

$('days').addEventListener('keydown', (e) => {
  const keys = [...$('days').querySelectorAll('.day')].map((b) => b.dataset.day);
  const i = keys.indexOf(state.day);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: keys.length - 1 }[e.key];
  if (next === undefined || !keys[next]) return;
  e.preventDefault();
  selectDay(keys[next], true);
});

function renderTimes(slots) {
  if (!slots.length) {
    $('times').replaceChildren(el('div', { class: 'empty' },
      el('p', { text: state.provider ? `${state.provider} has no free times right now.` : 'There are no free times right now. Please check back later.' }),
      state.provider
        ? el('button', { class: 'btn btn-secondary', type: 'button', text: 'Show all doctors', onclick: () => { state.provider = ''; renderPicker(); } })
        : null));
    return;
  }

  const periods = [
    ['Morning', (h) => h < 12],
    ['Afternoon', (h) => h >= 12 && h < 17],
    ['Evening', (h) => h >= 17],
  ];
  const groups = periods.map(([label, inPeriod]) => {
    const list = slots.filter((s) => inPeriod(new Date(s.start).getHours()));
    if (!list.length) return null;
    return el('div', { class: 'period' },
      el('h3', { text: label }),
      el('div', { class: 'time-grid' }, ...list.map(timeButton)));
  });
  $('times').replaceChildren(el('h2', { class: 'times-title', text: fmtDate(slots[0].start) }), ...groups.filter(Boolean));
}

function timeButton(s) {
  // With a doctor chip selected the name is already clear, so only show it under All doctors.
  return el('button', {
    type: 'button',
    class: 'time',
    'aria-pressed': String(s.id === state.selectedId),
    'aria-label': `${fmtTime(s.start)} with ${s.provider}`,
    onclick: () => selectSlot(s.id),
  },
    el('strong', { text: fmtTime(s.start) }),
    state.provider ? null : el('span', { text: s.provider }));
}

// ---------- booking panel

function setPanel(mode) {
  $('panel').dataset.state = mode;
  const step = { empty: 1, form: 2, done: 3 }[mode];
  for (const li of document.querySelectorAll('#stepper li')) {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < step);
    li.classList.toggle('current', n === step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
  document.body.classList.toggle('sheet-open', mode !== 'empty');
}

function selectSlot(id) {
  const slot = state.slotById[id];
  state.selectedId = id;
  state.booking = null;
  state.idemKey = crypto.randomUUID();
  $('sum-avatar').textContent = initials(slot.provider);
  $('sum-provider').textContent = slot.provider;
  $('sum-when').textContent = fmtWhen(slot);
  $('form-error').textContent = '';
  if (!$('email').value) $('email').value = localStorage.getItem(EMAIL_STORE) || '';
  setPanel('form');
  renderPicker();
  if (desktop.matches) $('name').focus();
}

function clearSelection() {
  state.selectedId = null;
  if ($('panel').dataset.state === 'form') setPanel('empty');
}

function closePanel() {
  state.selectedId = null;
  state.booking = null;
  setPanel('empty');
  renderPicker();
}

function setSubmit(label, { disabled = false, spinner = false } = {}) {
  const btn = $('submit');
  btn.disabled = disabled;
  btn.replaceChildren(...(spinner ? [el('span', { class: 'spinner', 'aria-hidden': 'true' })] : []), label);
}

function validate() {
  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const errors = {
    name: name ? '' : 'Please enter your name.',
    email: !email ? 'Please enter your email.' : EMAIL_RE.test(email) ? '' : 'That email doesn’t look right.',
  };
  for (const field of ['name', 'email']) {
    $(`${field}-error`).textContent = errors[field];
    $(field).setAttribute('aria-invalid', String(Boolean(errors[field])));
  }
  const firstInvalid = ['name', 'email'].find((f) => errors[f]);
  if (firstInvalid) $(firstInvalid).focus();
  return !firstInvalid;
}

for (const field of ['name', 'email']) {
  $(field).addEventListener('input', () => {
    $(`${field}-error`).textContent = '';
    $(field).removeAttribute('aria-invalid');
    // Edited details are a new request, so they get a new key (reusing it would return 422).
    state.idemKey = crypto.randomUUID();
  });
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedId || state.cooldown || !validate()) return;

  const body = { slot_id: state.selectedId, name: $('name').value.trim(), email: $('email').value.trim() };
  $('form-error').textContent = '';
  setSubmit('Booking…', { disabled: true, spinner: true });
  try {
    const booking = await withNetworkRetry(() => api('POST', '/bookings', body, { 'Idempotency-Key': state.idemKey }));
    localStorage.setItem(EMAIL_STORE, body.email);
    state.selectedId = null;
    showBooking(booking);
    loadSlots({ quiet: true });
    showMyBookings(body.email);
  } catch (err) {
    handleBookingError(err);
  } finally {
    if (!state.cooldown) setSubmit('Confirm booking');
  }
});

function handleBookingError(err) {
  if (!(err instanceof ApiError)) {
    $('form-error').textContent = 'We couldn’t reach the clinic. Check your connection and try again — you won’t be booked twice.';
    return;
  }
  state.idemKey = crypto.randomUUID();

  if (err.status === 409 || err.status === 404 || (err.status === 400 && /started/i.test(err.message))) {
    const messages = {
      409: 'Someone just booked that time. We’ve refreshed the list — please pick another.',
      404: 'That time is no longer available. We’ve refreshed the list.',
      400: 'That time has already started. Please choose a later one.',
    };
    clearSelection();
    toast(messages[err.status]);
    loadSlots({ quiet: true }).then(renderPicker);
    return;
  }
  if (err.status === 429) {
    startCooldown(err.retryAfter || 60);
    return;
  }
  $('form-error').textContent =
    err.status === 400 ? `Please check your details: ${err.message}.`
    : err.status === 401 ? 'This page isn’t authorised to make bookings. Please contact the clinic.'
    : 'Something went wrong on our side. Please try again.';
}

function startCooldown(seconds) {
  clearInterval(state.cooldown);
  $('form-error').textContent = 'Too many booking attempts with this email. Please wait a moment and try again.';
  let left = seconds;
  const tick = () => {
    if (left <= 0) {
      clearInterval(state.cooldown);
      state.cooldown = null;
      $('form-error').textContent = '';
      setSubmit('Confirm booking');
      return;
    }
    setSubmit(`Try again in ${left}s`, { disabled: true });
    left--;
  };
  state.cooldown = setInterval(tick, 1000);
  tick();
}

function showBooking(booking) {
  state.booking = booking;
  const slot = state.slotById[booking.slot_id];
  const cancelled = booking.status === 'cancelled';

  $('done').classList.toggle('cancelled', cancelled);
  $('done-title').textContent = cancelled ? 'Booking cancelled' : 'You’re booked';
  $('done-when').textContent = slot ? fmtWhen(slot) : `Slot ${booking.slot_id}`;
  $('done-provider').textContent = slot ? `with ${slot.provider}` : '';
  $('done-ref').textContent = shortRef(booking.id);
  $('done-ref').title = booking.id;
  $('done-email').textContent = booking.email;
  $('add-cal').classList.toggle('hidden', cancelled || !slot || isPast(slot));
  $('cancel-link').classList.toggle('hidden', cancelled || isPast(slot));

  setPanel('done');
  renderPicker();
  $('done-title').focus();
}

async function viewBooking(id) {
  try {
    showBooking(await api('GET', `/bookings/${encodeURIComponent(id)}`));
    if (desktop.matches) $('panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'We couldn’t reach the clinic. Please try again.');
  }
}

function downloadCalendar(booking) {
  const slot = state.slotById[booking.slot_id];
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escape = (s) => s.replace(/([,;\\])/g, '\\$1');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Koya Clinic//Booking//EN', 'BEGIN:VEVENT',
    `UID:${booking.id}@koya-clinic`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(slot.start)}`,
    `DTEND:${stamp(slot.end)}`,
    `SUMMARY:${escape(`Appointment with ${slot.provider}`)}`,
    `DESCRIPTION:${escape(`Koya Clinic booking reference ${shortRef(booking.id)}`)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const link = el('a', { href: url, download: `koya-appointment-${shortRef(booking.id)}.ics` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function confirmDialog(text) {
  const dialog = $('cancel-dialog');
  $('cancel-text').textContent = text;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'cancel'), { once: true });
  });
}

async function cancelBooking(booking) {
  const slot = state.slotById[booking.slot_id];
  const ok = await confirmDialog(slot
    ? `Your ${fmtTime(slot.start)} appointment on ${fmtDate(slot.start)} with ${slot.provider} will be cancelled and the time released.`
    : 'This booking will be cancelled.');
  if (!ok) return;

  try {
    const updated = await api('DELETE', `/bookings/${encodeURIComponent(booking.id)}`);
    toast('Your appointment has been cancelled.');
    afterCancel(updated);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      toast('This booking was already cancelled.');
      afterCancel({ ...booking, status: 'cancelled' });
    } else {
      toast(err instanceof ApiError ? err.message : 'We couldn’t reach the clinic. Please try again.');
    }
  }
}

function afterCancel(updated) {
  if (state.booking?.id === updated.id) showBooking(updated);
  loadSlots({ quiet: true });
  if (state.lookupEmail) loadMyBookings(false);
}

$('close-panel').addEventListener('click', closePanel);
$('backdrop').addEventListener('click', closePanel);
$('book-another').addEventListener('click', () => {
  closePanel();
  $('picker-title').focus();
  $('picker-title').scrollIntoView({ behavior: 'smooth' });
});
$('add-cal').addEventListener('click', () => downloadCalendar(state.booking));
$('cancel-link').addEventListener('click', () => cancelBooking(state.booking));
$('copy-ref').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.booking.id);
    toast('Booking ID copied.');
  } catch {
    toast(`Booking ID: ${state.booking.id}`);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('sheet-open') && !desktop.matches && !$('cancel-dialog').open) closePanel();
});

// ---------- my bookings

function showMyBookings(email) {
  $('lookup-email').value = email;
  state.lookupEmail = email;
  state.nextCursor = null;
  loadMyBookings(false);
}

async function loadMyBookings(append) {
  const params = new URLSearchParams({ email: state.lookupEmail, limit: '5' });
  if (append && state.nextCursor) params.set('cursor', state.nextCursor);
  $('more').disabled = true;
  try {
    const { bookings, next_cursor } = await api('GET', `/bookings?${params}`);
    state.nextCursor = next_cursor;
    const rows = bookings.map(bookingRow);
    if (append) $('my-bookings').append(...rows);
    else $('my-bookings').replaceChildren(...rows);
    $('more').classList.toggle('hidden', !next_cursor);
    $('lookup-msg').textContent = $('my-bookings').children.length ? '' : 'No bookings found for that email.';
  } catch (err) {
    $('lookup-msg').textContent = err instanceof ApiError ? err.message : 'We couldn’t reach the clinic. Please try again.';
  } finally {
    $('more').disabled = false;
  }
}

function bookingRow(b) {
  const slot = state.slotById[b.slot_id];
  const status = b.status === 'cancelled' ? 'cancelled' : isPast(slot) ? 'past' : 'confirmed';
  return el('li', {},
    el('span', { class: 'avatar', 'aria-hidden': 'true', text: slot ? initials(slot.provider) : '?' }),
    el('div', { class: 'info' },
      el('strong', { text: slot ? `${fmtDate(slot.start)}, ${fmtTime(slot.start)}` : `Slot ${b.slot_id}` }),
      el('span', { text: `${slot ? `${slot.provider} · ` : ''}Ref ${shortRef(b.id)}` })),
    el('span', { class: `badge ${status}`, text: status === 'past' ? 'Past' : b.status }),
    el('div', { class: 'row-actions' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'View', onclick: () => viewBooking(b.id) }),
      status === 'confirmed'
        ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm danger', text: 'Cancel', onclick: () => cancelBooking(b) })
        : null));
}

$('lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('lookup-email').value.trim();
  if (!email) return;
  localStorage.setItem(EMAIL_STORE, email);
  showMyBookings(email);
});
$('more').addEventListener('click', () => loadMyBookings(true));

// ---------- start

$('tz').textContent = timezoneLabel();
setPanel('empty');
loadSlots().then(() => {
  const saved = localStorage.getItem(EMAIL_STORE);
  if (saved) showMyBookings(saved);
});

// Keep availability fresh: when the tab regains focus, and every 30s while it's visible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadSlots({ quiet: true });
});
setInterval(() => {
  if (document.visibilityState === 'visible') loadSlots({ quiet: true });
}, 30000);
