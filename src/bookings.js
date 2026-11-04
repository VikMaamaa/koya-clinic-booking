import crypto from 'node:crypto';
import { pool } from './db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTEMPTS_PER_MINUTE = 5;

export const toBooking = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: r.created_at.toISOString(),
});

async function createBooking(client, body) {
  const b = body ?? {};
  const slotId = typeof b.slot_id === 'string' ? b.slot_id : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  // Failed attempts count too, so this runs before validation.
  if (email) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
    const { rows: [rl] } = await client.query(
      `SELECT count(*)::int AS n,
              ceil(extract(epoch FROM min(at) + interval '60 seconds' - now()))::int AS retry_after
       FROM booking_attempts
       WHERE email = $1 AND at > now() - interval '60 seconds'`,
      [email]);
    if (rl.n >= MAX_ATTEMPTS_PER_MINUTE) {
      return { status: 429, body: { error: 'too many booking attempts, try again later' }, retryAfter: Math.max(1, rl.retry_after) };
    }
    await client.query('INSERT INTO booking_attempts(email) VALUES ($1)', [email]);
  }

  if (!slotId.trim() || !name || !email) {
    return { status: 400, body: { error: 'slot_id, name and email are required' } };
  }
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'email is not valid' } };

  const slot = await client.query('SELECT start_at FROM slots WHERE id = $1', [slotId]);
  if (!slot.rowCount) return { status: 404, body: { error: 'slot not found' } };
  if (slot.rows[0].start_at <= new Date()) return { status: 400, body: { error: 'slot has already started' } };

  // The partial unique index decides the winner; a losing concurrent insert returns no rows.
  const ins = await client.query(
    `INSERT INTO bookings(id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slotId, name, email]);
  if (!ins.rowCount) return { status: 409, body: { error: 'slot is already booked' } };

  return { status: 201, body: toBooking(ins.rows[0]) };
}

export async function getBooking(req, res) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'booking not found' });
  res.json(toBooking(rows[0]));
}

export async function cancelBooking(req, res) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
     WHERE id = $1 AND status = 'confirmed'
     RETURNING *`,
    [req.params.id]);
  if (rows.length) return res.json(toBooking(rows[0]));

  const exists = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!exists.rowCount) return res.status(404).json({ error: 'booking not found' });
  res.status(409).json({ error: 'booking is already cancelled' });
}

export async function postBooking(req, res) {
  const idemKey = req.get('Idempotency-Key');
  const hash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // A concurrent request with the same key blocks on this insert until the first one commits.
    if (idemKey) {
      const claimed = await client.query(
        `INSERT INTO idempotency_keys(key, request_hash) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING RETURNING key`,
        [idemKey, hash]);
      if (!claimed.rowCount) {
        const { rows: [saved] } = await client.query('SELECT * FROM idempotency_keys WHERE key = $1', [idemKey]);
        await client.query('COMMIT');
        if (saved.request_hash !== hash) {
          return res.status(422).json({ error: 'Idempotency-Key was already used with a different body' });
        }
        return res.status(saved.status_code).json(saved.response_body);
      }
    }

    const result = await createBooking(client, req.body);

    // Rolling back releases the idempotency key so a later retry isn't stuck replaying a 429.
    if (result.status === 429) {
      await client.query('ROLLBACK');
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json(result.body);
    }

    if (idemKey) {
      await client.query(
        'UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1',
        [idemKey, result.status, result.body]);
    }
    await client.query('COMMIT');
    res.status(result.status).json(result.body);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
