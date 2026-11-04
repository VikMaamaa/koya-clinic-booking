import 'dotenv/config';
import express from 'express';
import { pool } from './db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));              // web page at "/", loads without a key
app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {                   // Level 2: API key on everything below
  if (req.get('X-API-Key') !== process.env.API_KEY)
    return res.status(401).json({ error: 'missing or invalid API key' });
  next();
});

app.post('/reset', async (req, res) => {
  const slots = req.body?.slots;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });
  const isValidSlot = (s) =>
    s && ['id', 'provider', 'start', 'end'].every((k) => typeof s[k] === 'string' && s[k]) &&
    !isNaN(Date.parse(s.start)) && !isNaN(Date.parse(s.end));
  if (!slots.every(isValidSlot)) return res.status(400).json({ error: 'each slot needs id, provider, start and end' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE bookings, idempotency_keys, booking_attempts, slots');
    for (const s of slots) {
      await client.query(
        `INSERT INTO slots(id, provider, start_at, end_at, start_raw, end_raw)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.id, s.provider, s.start, s.end, s.start, s.end]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

app.get('/slots', async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
            NOT EXISTS (SELECT 1 FROM bookings b
                        WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
     FROM slots s
     WHERE ($1::text IS NULL OR s.provider = $1)
     ORDER BY s.start_at, s.id`,
    [provider]);
  res.json({ slots: rows });
});

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(process.env.PORT || 3000, () => console.log('listening'));