CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,
  end_at    TIMESTAMPTZ NOT NULL,
  start_raw TEXT NOT NULL,
  end_raw   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id         TEXT PRIMARY KEY,
  seq        BIGSERIAL UNIQUE,
  slot_id    TEXT NOT NULL REFERENCES slots(id),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one confirmed booking per slot, enforced by Postgres even under concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot ON bookings(slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings(email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status_code   INT,
  response_body JSONB
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id    BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_by_email ON booking_attempts(email, at);
