// Usage: npm start (in another terminal), then: node test.mjs
// Against a deployed API: BASE=https://your-app.onrender.com node test.mjs
import 'dotenv/config';

const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;
const KEY = process.env.API_KEY;

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
};

async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}

const inDays = (d, h = 9) => {
  const t = new Date(Date.now() + d * 864e5);
  t.setUTCHours(h, 0, 0, 0);
  return t.toISOString().replace('.000Z', 'Z');
};
const slot = (id, provider, d, h) => ({ id, provider, start: inDays(d, h), end: inDays(d, h).replace(':00:00Z', ':30:00Z') });
const run = Date.now().toString(36);
const mail = (name) => `${name}-${run}@example.com`;

console.log(`Testing ${BASE}\n`);

// ---- Level 2: API key
check('no API key -> 401', (await call('GET', '/slots', undefined, { 'X-API-Key': '' })).status === 401);
check('wrong API key -> 401', (await call('GET', '/slots', undefined, { 'X-API-Key': 'wrong' })).status === 401);

// ---- Level 1: reset and list slots
const slots = [
  slot('s3', 'Dr Bisi', 12, 9), slot('s1', 'Dr Ade', 10, 9), slot('s2', 'Dr Ade', 11, 9),
  slot('s4', 'Dr Bisi', 13, 9), slot('p1', 'Dr Ade', 20, 9), slot('p2', 'Dr Ade', 20, 10),
  slot('p3', 'Dr Ade', 20, 11), slot('old', 'Dr Ade', -5, 9),
];
check('POST /reset -> 200', (await call('POST', '/reset', { slots })).status === 200);

let r = await call('GET', '/slots');
const starts = r.body?.slots?.map((s) => s.start) ?? [];
check('GET /slots returns every slot', r.status === 200 && starts.length === slots.length, r.body);
check('slots sorted by start', starts.every((s, i) => i === 0 || Date.parse(starts[i - 1]) <= Date.parse(s)), starts);
check('slot start returned exactly as sent', r.body?.slots?.find((s) => s.id === 's1')?.start === slots[1].start);
check('all slots available after reset', r.body?.slots?.every((s) => s.available === true));
r = await call('GET', '/slots?provider=' + encodeURIComponent('Dr Bisi'));
check('provider filter', r.body?.slots?.length === 2 && r.body.slots.every((s) => s.provider === 'Dr Bisi'), r.body);

// ---- Level 1: book and look up
r = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada Obi', email: mail('ada') });
check('book s1 -> 201 confirmed', r.status === 201 && r.body?.status === 'confirmed' && r.body?.id, r);
const s1Id = r.body?.id;
r = await call('GET', `/bookings/${s1Id}`);
check('GET /bookings/:id -> 200', r.status === 200 && r.body?.id === s1Id, r);
check('GET unknown booking -> 404', (await call('GET', '/bookings/does-not-exist')).status === 404);
r = await call('GET', '/slots');
check('booked slot shows available=false', r.body?.slots?.find((s) => s.id === 's1')?.available === false);

// ---- Level 2: validation
const v = mail('valid');
check('missing name -> 400', (await call('POST', '/bookings', { slot_id: 's2', email: v })).status === 400);
check('empty email -> 400', (await call('POST', '/bookings', { slot_id: 's2', name: 'X', email: '  ' })).status === 400);
check('invalid email -> 400', (await call('POST', '/bookings', { slot_id: 's2', name: 'X', email: 'not-an-email' })).status === 400);
check('missing slot_id -> 400', (await call('POST', '/bookings', { name: 'X', email: mail('v2') })).status === 400);
check('unknown slot -> 404', (await call('POST', '/bookings', { slot_id: 'nope', name: 'X', email: mail('v3') })).status === 404);
check('slot in the past -> 400', (await call('POST', '/bookings', { slot_id: 'old', name: 'X', email: mail('v4') })).status === 400);
r = await call('POST', '/bookings', { slot_id: 's2', name: '  Trim Me  ', email: `  MiXeD-${run}@Example.COM ` });
check('name trimmed, email trimmed + lowercased', r.status === 201 && r.body?.name === 'Trim Me' && r.body?.email === `mixed-${run}@example.com`, r.body);
const s2Id = r.body?.id;

// ---- Level 3: concurrency and cancellation
const race = await Promise.all(Array.from({ length: 20 }, (_, i) =>
  call('POST', '/bookings', { slot_id: 's3', name: `P${i}`, email: mail(`race${i}`) })));
const codes = race.map((x) => x.status);
check('20 simultaneous bookings -> exactly one 201', codes.filter((c) => c === 201).length === 1, codes);
check('the other 19 -> 409', codes.filter((c) => c === 409).length === 19, codes);

check('booking an already-booked slot -> 409', (await call('POST', '/bookings', { slot_id: 's2', name: 'Late', email: mail('late') })).status === 409);
r = await call('DELETE', `/bookings/${s2Id}`);
check('cancel -> 200 cancelled', r.status === 200 && r.body?.status === 'cancelled', r);
check('cancel again -> 409', (await call('DELETE', `/bookings/${s2Id}`)).status === 409);
check('cancel unknown -> 404', (await call('DELETE', '/bookings/does-not-exist')).status === 404);
r = await call('GET', '/slots');
check('cancelled slot is available again', r.body?.slots?.find((s) => s.id === 's2')?.available === true);
check('cancelled slot can be rebooked', (await call('POST', '/bookings', { slot_id: 's2', name: 'Next', email: mail('next') })).status === 201);

// ---- Level 4: idempotency
const idemBody = { slot_id: 's4', name: 'Idem', email: mail('idem') };
const key = `key-${run}`;
const first = await call('POST', '/bookings', idemBody, { 'Idempotency-Key': key });
const second = await call('POST', '/bookings', idemBody, { 'Idempotency-Key': key });
check('same key + same body -> same status and id', first.status === 201 && second.status === 201 && first.body?.id === second.body?.id, [first, second]);
check('same key + different body -> 422',
  (await call('POST', '/bookings', { ...idemBody, name: 'Other' }, { 'Idempotency-Key': key })).status === 422);

await call('DELETE', `/bookings/${first.body?.id}`);
const key2 = `key2-${run}`;
const burst = await Promise.all(Array.from({ length: 5 }, () =>
  call('POST', '/bookings', { ...idemBody, email: mail('idem2') }, { 'Idempotency-Key': key2 })));
const ids = new Set(burst.map((x) => x.body?.id));
check('5 simultaneous retries with one key -> one booking', burst.every((x) => x.status === 201) && ids.size === 1, burst.map((x) => [x.status, x.body?.id]));

// ---- Level 4: pagination
const pager = mail('pager');
for (const id of ['p1', 'p2', 'p3']) await call('POST', '/bookings', { slot_id: id, name: 'Pager', email: pager });
r = await call('GET', `/bookings?email=${encodeURIComponent(pager.toUpperCase())}&limit=2`);
check('page 1: 2 bookings + cursor (email case ignored)', r.status === 200 && r.body?.bookings?.length === 2 && r.body?.next_cursor, r.body);
const page1 = r.body?.bookings ?? [];
r = await call('GET', `/bookings?email=${encodeURIComponent(pager)}&limit=2&cursor=${encodeURIComponent(r.body?.next_cursor)}`);
check('page 2: 1 booking + next_cursor null', r.status === 200 && r.body?.bookings?.length === 1 && r.body?.next_cursor === null, r.body);
check('oldest first across pages', [...page1, ...(r.body?.bookings ?? [])].map((b) => b.slot_id).join() === 'p1,p2,p3');
for (const bad of ['0', '51', 'abc', '2.5']) {
  check(`limit=${bad} -> 400`, (await call('GET', `/bookings?email=${encodeURIComponent(pager)}&limit=${bad}`)).status === 400);
}
check('missing email -> 400', (await call('GET', '/bookings')).status === 400);

// ---- Level 5: rate limiting
const spammer = mail('spam');
const attempts = [];
for (let i = 0; i < 6; i++) attempts.push(await call('POST', '/bookings', { slot_id: 'nope', name: 'Spam', email: spammer }));
check('first 5 attempts are not rate limited', attempts.slice(0, 5).every((x) => x.status === 404), attempts.map((x) => x.status));
const sixth = attempts[5];
const retryAfter = sixth.headers.get('retry-after');
check('6th attempt -> 429 with Retry-After in whole seconds', sixth.status === 429 && /^\d+$/.test(retryAfter ?? '') && Number(retryAfter) > 0, [sixth.status, retryAfter]);
check('other emails are not affected', (await call('POST', '/bookings', { slot_id: 'nope', name: 'Other', email: mail('other') })).status === 404);

console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
