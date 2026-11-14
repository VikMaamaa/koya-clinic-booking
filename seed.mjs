// Replaces all slots (and deletes all bookings) with demo slots for the next 7 days.
// Usage: node seed.mjs            (local)
//        BASE=https://your-app.onrender.com node seed.mjs
import 'dotenv/config';

const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;
const providers = ['Dr Ade', 'Dr Bisi', 'Dr Chioma'];
const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '14:00', '14:30', '15:00'];

const slots = [];
for (let day = 1; day <= 7; day++) {
  const date = new Date(Date.now() + day * 864e5);
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
  const ymd = date.toISOString().slice(0, 10);
  providers.forEach((provider, p) => {
    times.forEach((time, t) => {
      if ((day + p + t) % 3 === 0) return;
      const start = new Date(`${ymd}T${time}:00Z`);
      const end = new Date(start.getTime() + 30 * 60e3);
      slots.push({
        id: `${ymd.replaceAll('-', '')}-${p + 1}-${time.replace(':', '')}`,
        provider,
        start: start.toISOString().replace('.000Z', 'Z'),
        end: end.toISOString().replace('.000Z', 'Z'),
      });
    });
  });
}

const res = await fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'X-API-Key': process.env.API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ slots }),
});
console.log(`${res.status} — seeded ${slots.length} slots at ${BASE}`);
