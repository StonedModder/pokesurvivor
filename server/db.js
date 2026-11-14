/* ============ server/db.js — conexión a Postgres y tablas ============
 * Vale cualquier Postgres: Neon (desde el Marketplace de Vercel), Supabase o
 * uno local. La dirección sale de DATABASE_URL (o POSTGRES_URL, el nombre que
 * pone la integración de Vercel).
 *
 * Las tablas se crean solas la primera vez (CREATE TABLE IF NOT EXISTS), así
 * que no hay que ejecutar nada a mano después de conectar la base de datos.
 */
const postgres = require('postgres');

let sql = null;
let schemaP = null;

function db() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw Object.assign(new Error('Falta DATABASE_URL'), { status: 503, code: 'no-db' });
  // Funciones serverless: pocas conexiones por instancia, y sin sentencias
  // preparadas (el pooler de Neon/Supabase no las admite).
  sql = postgres(url, { max: 3, prepare: false, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  return sql;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  uid        text PRIMARY KEY,
  lower      text UNIQUE NOT NULL,          -- nombre para entrar, en minúsculas
  name       text NOT NULL,
  salt       text NOT NULL,
  hash       text NOT NULL,                 -- scrypt
  fails      int  NOT NULL DEFAULT 0,       -- intentos fallidos seguidos
  locked     timestamptz,                   -- bloqueado hasta (demasiados intentos)
  created    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,              -- sha256 del token (el token sólo lo tiene el navegador)
  uid        text NOT NULL REFERENCES users ON DELETE CASCADE,
  created    timestamptz NOT NULL DEFAULT now(),
  seen       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions (uid);
CREATE TABLE IF NOT EXISTS saves (
  uid        text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  save       jsonb NOT NULL,
  ver        int  NOT NULL DEFAULT 1,       -- sube en cada escritura (para fusionar sin pisar)
  updated    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS profiles (
  uid        text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  name       text NOT NULL,
  lower      text UNIQUE NOT NULL,          -- apodo único
  data       jsonb NOT NULL DEFAULT '{}',   -- favoritos, título, marcas, medallas
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS friendships (
  a          text NOT NULL REFERENCES users ON DELETE CASCADE,   -- a < b
  b          text NOT NULL REFERENCES users ON DELETE CASCADE,
  from_uid   text NOT NULL,
  status     text NOT NULL,                 -- 'pending' | 'ok'
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (b);
CREATE TABLE IF NOT EXISTS presence (
  uid        text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  on_line    boolean NOT NULL,
  room       text NOT NULL DEFAULT '',
  play       boolean NOT NULL DEFAULT false,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invites (
  to_uid     text NOT NULL REFERENCES users ON DELETE CASCADE,
  from_uid   text NOT NULL REFERENCES users ON DELETE CASCADE,
  room       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (to_uid, from_uid)
);
CREATE TABLE IF NOT EXISTS rooms (
  id         text PRIMARY KEY,
  host       text NOT NULL REFERENCES users ON DELETE CASCADE,
  open       boolean NOT NULL DEFAULT true,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS room_members (
  room       text NOT NULL REFERENCES rooms ON DELETE CASCADE,
  uid        text NOT NULL REFERENCES users ON DELETE CASCADE,
  name       text NOT NULL,
  dex        int,
  shiny      boolean NOT NULL DEFAULT false,
  joined     timestamptz NOT NULL DEFAULT now(),
  seen       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room, uid)
);
CREATE TABLE IF NOT EXISTS room_msgs (
  id         bigserial PRIMARY KEY,
  room       text NOT NULL REFERENCES rooms ON DELETE CASCADE,
  to_uid     text NOT NULL,
  from_uid   text NOT NULL,
  body       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_msgs_to ON room_msgs (room, to_uid, id);
CREATE TABLE IF NOT EXISTS runs (
  uid        text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  started    timestamptz NOT NULL,
  mode       text NOT NULL
);
CREATE TABLE IF NOT EXISTS lb (
  board      text NOT NULL,                 -- s_d20261008, g_all, s_all_p25...
  id         text NOT NULL,                 -- uid, o los uid del equipo ordenados y unidos con _
  t          int  NOT NULL,
  uids       text[] NOT NULL,
  names      text[] NOT NULL,
  dex        int[] NOT NULL,
  shiny      boolean[] NOT NULL,
  lv         int NOT NULL,
  kills      int NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board, id)
);
CREATE INDEX IF NOT EXISTS lb_top ON lb (board, t DESC);
CREATE INDEX IF NOT EXISTS lb_uids ON lb USING gin (uids);
`;

/** Crea las tablas una vez por instancia (es idempotente y tarda unos ms). */
function ready() {
  if (!schemaP) {
    schemaP = db().unsafe(SCHEMA).catch(e => { schemaP = null; throw e; });
  }
  return schemaP.then(() => db());
}

module.exports = { db, ready, SCHEMA };
