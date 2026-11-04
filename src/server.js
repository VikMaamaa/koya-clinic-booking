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

// ... routes go here (steps 5 to 9) ...

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(process.env.PORT || 3000, () => console.log('listening'));