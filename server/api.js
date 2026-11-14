/* ============ server/api.js — la API del juego ============
 * Una sola función (POST /api/v1 con { op, ...datos }) para no pasar del
 * límite de funciones del plan gratuito de Vercel. El navegador manda su
 * sesión en "Authorization: Bearer <token>".
 *
 * Sustituye a Firebase:
 *   cuentas       register, login, logout, deleteAccount, me
 *   partida       saveGet, savePut (con número de versión: si otro ordenador
 *                 guardó antes, devuelve lo suyo y el navegador lo fusiona)
 *   amigos        nick, profileGet, profilePut, poll (amigos + en línea +
 *                 invitaciones de una vez), friendRequest, friendAccept,
 *                 friendRemove, invite, inviteDel, presence
 *   salas         roomCreate, roomJoin, roomLeave, roomOpen, roomMember,
 *                 roomPoll (miembros + mensajes), roomSend
 *   ranking       runStart, rankSubmit, rankTop, rankMine
 *
 * Lo que antes hacían las reglas de Firestore (cada uno sólo toca lo suyo,
 * marcas validadas contra trampas) lo comprueba ahora el servidor.
 */
const crypto = require('crypto');
const { ready } = require('./db');

const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
const MAX_PLAYERS = 4;
const ONLINE_S = 100;                 // "en línea" si ha dado señales hace menos de esto
const MEMBER_S = 75;                  // un miembro de sala sin señales tanto tiempo se va (pestañas en segundo plano preguntan poco)
const INVITE_S = 180;
const SESSION_DAYS = 180;
const MAX_SAVE = 1024 * 1024;         // 1 MB de partida como mucho
const TOP = 50;
const TZ = 'Europe/Madrid';

class ApiError extends Error {
  constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; }
}
const bad = (code, msg) => new ApiError(400, code, msg);

// ---------------- utilidades ----------------

const rid = (n = 20) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function scrypt(pass, salt) {
  return new Promise((res, rej) => crypto.scrypt(pass, salt, 32, { N: 16384, r: 8, p: 1 },
    (e, k) => (e ? rej(e) : res(k.toString('hex')))));
}
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const int = v => (Number.isInteger(v) ? v : null);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

// ---------------- periodos del ranking (igual que js/net/ranking.js) ----------------

function periodIds(date = new Date()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
  const y = +p.year, m = +p.month, d = +p.day;
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  const p2 = n => String(n).padStart(2, '0');
  return { d: 'd' + y + p2(m) + p2(d), w: 'w' + t.getUTCFullYear() + '-' + p2(week), m: 'm' + y + p2(m), a: 'all' };
}
const BOARD = /^[sg]_(d\d{8}|w\d{4}-\d{2}|m\d{6}|all(_p\d{1,4})?)$/;

// ---------------- sesión ----------------

async function auth(sql, req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token) || '';
  if (!token || token.length > 100) throw new ApiError(401, 'no-session');
  const [s] = await sql`
    UPDATE sessions SET seen = now() WHERE token_hash = ${sha(token)}
      AND seen > now() - make_interval(days => ${SESSION_DAYS})
    RETURNING uid`;
  if (!s) throw new ApiError(401, 'no-session');
  return s.uid;
}

async function newSession(sql, uid) {
  const token = rid(40);
  await sql`INSERT INTO sessions (token_hash, uid) VALUES (${sha(token)}, ${uid})`;
  return token;
}

async function nickOf(sql, uid) {
  const [p] = await sql`SELECT name FROM profiles WHERE uid = ${uid}`;
  return p ? p.name : null;
}

// =====================================================================
//                                CUENTAS
// =====================================================================

const ops = {};
const open = new Set(['ping', 'register', 'login']);     // sin sesión

ops.ping = async () => ({ ok: true });

ops.register = async (sql, _uid, { name, pass }) => {
  name = (str(name, 40) || '').trim();
  if (!VALID.test(name)) throw bad('bad-name', 'El nombre debe tener 3-16 letras, números o _.');
  if (typeof pass !== 'string' || pass.length < 6 || pass.length > 200) throw bad('weak-password', 'La contraseña debe tener al menos 6 caracteres.');
  const lower = name.toLowerCase();
  const uid = rid(20), salt = rid(16), hash = await scrypt(pass, salt);
  try {
    await sql.begin(async tx => {
      await tx`INSERT INTO users (uid, lower, name, salt, hash) VALUES (${uid}, ${lower}, ${name}, ${salt}, ${hash})`;
      // El nombre de la cuenta es también su apodo público (si está libre).
      await tx`INSERT INTO profiles (uid, name, lower) VALUES (${uid}, ${name}, ${lower}) ON CONFLICT (lower) DO NOTHING`;
    });
  } catch (e) {
    if (e.code === '23505') throw bad('name-taken', 'Ese nombre ya existe.');
    throw e;
  }
  return { uid, name, token: await newSession(sql, uid) };
};

ops.login = async (sql, _uid, { name, pass }) => {
  const lower = (str(name, 40) || '').trim().toLowerCase();
  const [u] = await sql`SELECT uid, name, salt, hash, fails, locked FROM users WHERE lower = ${lower}`;
  const wrong = bad('wrong-password', 'Usuario o contraseña incorrectos.');
  if (!u) { await scrypt(String(pass || ''), 'x'); throw wrong; }      // mismo tiempo exista o no
  if (u.locked && u.locked > new Date()) throw new ApiError(429, 'too-many-requests', 'Demasiados intentos seguidos. Espera un poco.');
  const hash = await scrypt(String(pass || ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) {
    // 8 fallos seguidos: 5 minutos sin poder probar.
    await sql`UPDATE users SET
      locked = CASE WHEN fails + 1 >= 8 THEN now() + interval '5 minutes' ELSE locked END,
      fails = CASE WHEN fails + 1 >= 8 THEN 0 ELSE fails + 1 END
      WHERE uid = ${u.uid}`;
    throw wrong;
  }
  if (u.fails || u.locked) await sql`UPDATE users SET fails = 0, locked = NULL WHERE uid = ${u.uid}`;
  return { uid: u.uid, name: u.name, token: await newSession(sql, u.uid) };
};

ops.me = async (sql, uid) => {
  const [u] = await sql`SELECT name FROM users WHERE uid = ${uid}`;
  return { uid, name: u.name };
};

ops.logout = async (sql, uid, _b, req) => {
  const token = (req.headers.authorization || '').slice(7);
  await sql`DELETE FROM sessions WHERE token_hash = ${sha(token)}`;
  return { ok: true };
};

/** Borra la cuenta y TODO lo suyo (partida, apodo, amigos, salas, marcas). */
ops.deleteAccount = async (sql, uid) => {
  await sql.begin(async tx => {
    await tx`DELETE FROM lb WHERE ${uid} = ANY(uids)`;
    await tx`DELETE FROM users WHERE uid = ${uid}`;          // el resto cae en cascada
  });
  return { ok: true };
};

// =====================================================================
//                                PARTIDA
// =====================================================================

ops.saveGet = async (sql, uid) => {
  const [s] = await sql`SELECT save, ver FROM saves WHERE uid = ${uid}`;
  return s ? { save: s.save, ver: s.ver } : { save: null, ver: 0 };
};

/**
 * Guarda si nadie ha guardado desde la versión que tenía el navegador.
 * Si no, devuelve la de la nube: el navegador fusiona (G.DB.merge) y reintenta.
 */
ops.savePut = async (sql, uid, { save, ver }) => {
  if (!save || typeof save !== 'object' || Array.isArray(save)) throw bad('bad-save');
  if (JSON.stringify(save).length > MAX_SAVE) throw bad('save-too-big', 'La partida es demasiado grande.');
  ver = int(ver) || 0;
  const rows = ver === 0
    ? await sql`INSERT INTO saves (uid, save, ver) VALUES (${uid}, ${sql.json(save)}, 1)
                ON CONFLICT (uid) DO NOTHING RETURNING ver`
    : await sql`UPDATE saves SET save = ${sql.json(save)}, ver = ver + 1, updated = now()
                WHERE uid = ${uid} AND ver = ${ver} RETURNING ver`;
  if (rows.length) return { ok: true, ver: rows[0].ver };
  const [cur] = await sql`SELECT save, ver FROM saves WHERE uid = ${uid}`;
  return { conflict: true, save: cur ? cur.save : null, ver: cur ? cur.ver : 0 };
};

// =====================================================================
//                         APODO, PERFIL Y AMIGOS
// =====================================================================

ops.nick = async (sql, uid, { name }) => {
  name = (str(name, 40) || '').trim();
  if (!VALID.test(name)) throw bad('bad-name', 'El apodo debe tener 3-16 letras, números o _.');
  try {
    await sql`INSERT INTO profiles (uid, name, lower) VALUES (${uid}, ${name}, ${name.toLowerCase()})
              ON CONFLICT (uid) DO UPDATE SET name = excluded.name, lower = excluded.lower, at = now()`;
  } catch (e) {
    if (e.code === '23505') throw bad('taken', 'Ese apodo ya lo tiene otro jugador.');
    throw e;
  }
  return { ok: true, name };
};

ops.profileGet = async (sql, uid, { of }) => {
  const [p] = await sql`SELECT name, data FROM profiles WHERE uid = ${str(of, 40) || uid}`;
  return { profile: p ? Object.assign({}, p.data, { name: p.name }) : null };
};

ops.profilePut = async (sql, uid, { data }) => {
  data = data || {};
  const favs = Array.isArray(data.favs) ? data.favs.slice(0, 3).map(f => ({ dex: (f && f.dex) | 0, shiny: !!(f && f.shiny) })) : [];
  const title = str(data.title, 40) || '';
  const best = {};
  if (data.best && typeof data.best === 'object') {
    for (const k of ['solo', 'group', 'level', 'bosses', 'legends', 'kills', 'medals']) best[k] = Math.max(0, Math.min(1e9, data.best[k] | 0));
  }
  const medals = Array.isArray(data.medals) ? data.medals.slice(0, 8).filter(m => typeof m === 'string' && m.length <= 40) : [];
  const r = await sql`UPDATE profiles SET data = ${sql.json({ favs, title, best, medals })}, at = now() WHERE uid = ${uid} RETURNING uid`;
  if (!r.length) throw bad('no-nick', 'Primero elige tu apodo.');
  return { ok: true };
};

/** Lista de amigos con su "en línea", e invitaciones recibidas. Opcionalmente apunta tu presencia. */
ops.poll = async (sql, uid, { pres }) => {
  if (pres) await writePresence(sql, uid, pres);
  const friends = await sql`
    SELECT CASE WHEN f.a = ${uid} THEN f.b ELSE f.a END AS uid, f.status, f.from_uid,
           p.name, pr.on_line, pr.room, pr.play, pr.at AS seen
      FROM friendships f
      LEFT JOIN profiles p ON p.uid = CASE WHEN f.a = ${uid} THEN f.b ELSE f.a END
      LEFT JOIN presence pr ON pr.uid = CASE WHEN f.a = ${uid} THEN f.b ELSE f.a END
     WHERE f.a = ${uid} OR f.b = ${uid}`;
  await sql`DELETE FROM invites WHERE to_uid = ${uid} AND at < now() - make_interval(secs => ${INVITE_S})`;
  const invites = await sql`
    SELECT i.from_uid, i.room, i.at, p.name FROM invites i
      JOIN friendships f ON (f.a, f.b) = (LEAST(i.to_uid, i.from_uid), GREATEST(i.to_uid, i.from_uid)) AND f.status = 'ok'
      LEFT JOIN profiles p ON p.uid = i.from_uid
     WHERE i.to_uid = ${uid}`;
  const now = Date.now();
  return {
    friends: friends.map(f => {
      const ok = f.status === 'ok';
      const on = ok && !!f.on_line && f.seen && now - f.seen < ONLINE_S * 1000;
      return { uid: f.uid, name: f.name || '???', status: ok ? 'ok' : f.from_uid === uid ? 'out' : 'in',
               online: !!on, play: !!(on && f.play), room: on ? f.room : '', seen: ok && f.seen ? +f.seen : 0 };
    }),
    invites: invites.map(i => ({ from: i.from_uid, name: i.name || '???', room: i.room, at: +i.at }))
  };
};

async function writePresence(sql, uid, p) {
  const on = p.on !== false, room = str(p.room, 40) || '', play = !!p.play;
  await sql`INSERT INTO presence (uid, on_line, room, play) VALUES (${uid}, ${on}, ${room}, ${play})
            ON CONFLICT (uid) DO UPDATE SET on_line = excluded.on_line, room = excluded.room, play = excluded.play, at = now()`;
}
ops.presence = async (sql, uid, b) => { await writePresence(sql, uid, b); return { ok: true }; };

ops.friendRequest = async (sql, uid, { name }) => {
  name = (str(name, 40) || '').trim();
  if (!VALID.test(name)) throw bad('bad-name', 'Escribe el apodo exacto de tu amigo.');
  if (!(await nickOf(sql, uid))) throw bad('no-nick', 'Primero elige tu apodo.');
  const [o] = await sql`SELECT uid, name FROM profiles WHERE lower = ${name.toLowerCase()}`;
  if (!o) throw bad('not-found', 'No hay ningún jugador con ese apodo.');
  if (o.uid === uid) throw bad('self', 'Ese eres tú.');
  const [a, b] = pair(uid, o.uid);
  const [f] = await sql`SELECT status, from_uid FROM friendships WHERE a = ${a} AND b = ${b}`;
  if (f && f.status === 'ok') throw bad('already', 'Ya sois amigos.');
  if (f && f.from_uid === uid) throw bad('already-sent', 'Ya le enviaste una solicitud.');
  if (f) {                                                   // te la había mandado él: se acepta
    await sql`UPDATE friendships SET status = 'ok', at = now() WHERE a = ${a} AND b = ${b}`;
    return { ok: true, msg: 'Ahora eres amigo de ' + o.name };
  }
  await sql`INSERT INTO friendships (a, b, from_uid, status) VALUES (${a}, ${b}, ${uid}, 'pending') ON CONFLICT DO NOTHING`;
  return { ok: true, msg: 'Solicitud enviada a ' + o.name };
};

ops.friendAccept = async (sql, uid, { other }) => {
  const [a, b] = pair(uid, str(other, 40) || '');
  const r = await sql`UPDATE friendships SET status = 'ok', at = now()
                       WHERE a = ${a} AND b = ${b} AND status = 'pending' AND from_uid <> ${uid} RETURNING a`;
  if (!r.length) throw bad('no-request', 'No hay solicitud.');
  return { ok: true, msg: 'Ahora eres amigo de ' + ((await nickOf(sql, other)) || '???') };
};

ops.friendRemove = async (sql, uid, { other }) => {
  const [a, b] = pair(uid, str(other, 40) || '');
  await sql`DELETE FROM friendships WHERE a = ${a} AND b = ${b}`;
  await sql`DELETE FROM invites WHERE (to_uid = ${uid} AND from_uid = ${other}) OR (to_uid = ${other} AND from_uid = ${uid})`;
  return { ok: true };
};

ops.invite = async (sql, uid, { to, room }) => {
  to = str(to, 40); room = str(room, 40);
  if (!to || !room) throw bad('bad-invite');
  const [a, b] = pair(uid, to);
  const [f] = await sql`SELECT 1 FROM friendships WHERE a = ${a} AND b = ${b} AND status = 'ok'`;
  if (!f) throw bad('not-friends', 'Sólo puedes invitar a tus amigos.');
  const [r] = await sql`SELECT 1 FROM rooms WHERE id = ${room} AND host = ${uid}`;
  if (!r) throw bad('not-host', 'Sólo el anfitrión de la sala puede invitar.');
  await sql`INSERT INTO invites (to_uid, from_uid, room) VALUES (${to}, ${uid}, ${room})
            ON CONFLICT (to_uid, from_uid) DO UPDATE SET room = excluded.room, at = now()`;
  return { ok: true };
};

/** Borra invitaciones: las que te mandó `from`, o las que mandaste tú a `to` (o todas las tuyas). */
ops.inviteDel = async (sql, uid, { from, to, all }) => {
  if (from) await sql`DELETE FROM invites WHERE to_uid = ${uid} AND from_uid = ${from}`;
  if (to) await sql`DELETE FROM invites WHERE from_uid = ${uid} AND to_uid = ${to}`;
  if (all) await sql`DELETE FROM invites WHERE from_uid = ${uid}`;
  return { ok: true };
};

// =====================================================================
//                                 SALAS
// =====================================================================

function memberInfo(info) {
  info = info || {};
  return { dex: int(info.dex), shiny: !!info.shiny };
}

ops.roomCreate = async (sql, uid, { info }) => {
  const name = await nickOf(sql, uid);
  if (!name) throw bad('no-nick', 'Primero elige tu apodo.');
  const id = rid(12), m = memberInfo(info);
  // Sólo una sala por anfitrión: las anteriores se cierran.
  await sql`DELETE FROM rooms WHERE host = ${uid}`;
  await sql`DELETE FROM room_members WHERE uid = ${uid}`;
  await sql.begin(async tx => {
    await tx`INSERT INTO rooms (id, host) VALUES (${id}, ${uid})`;
    await tx`INSERT INTO room_members (room, uid, name, dex, shiny) VALUES (${id}, ${uid}, ${name}, ${m.dex}, ${m.shiny})`;
  });
  return { id };
};

ops.roomJoin = async (sql, uid, { id, info }) => {
  id = str(id, 40) || '';
  const name = await nickOf(sql, uid);
  if (!name) throw bad('no-nick', 'Primero elige tu apodo.');
  await pruneRoom(sql, id);
  const m = memberInfo(info);
  return sql.begin(async tx => {
    const [r] = await tx`SELECT host, open FROM rooms WHERE id = ${id} FOR UPDATE`;
    if (!r) throw bad('no-room', 'Esa sala ya no existe.');
    const [already] = await tx`SELECT 1 FROM room_members WHERE room = ${id} AND uid = ${uid}`;
    if (!already) {
      if (!r.open) throw bad('started', 'La partida de esa sala ya ha empezado.');
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM room_members WHERE room = ${id}`;
      if (n >= MAX_PLAYERS) throw bad('full', 'La sala está llena (máximo ' + MAX_PLAYERS + ').');
    }
    await tx`INSERT INTO room_members (room, uid, name, dex, shiny) VALUES (${id}, ${uid}, ${name}, ${m.dex}, ${m.shiny})
             ON CONFLICT (room, uid) DO UPDATE SET dex = excluded.dex, shiny = excluded.shiny, seen = now()`;
    return { ok: true, host: r.host };
  });
};

ops.roomLeave = async (sql, uid, { id }) => {
  id = str(id, 40) || '';
  const [r] = await sql`SELECT host FROM rooms WHERE id = ${id}`;
  if (r && r.host === uid) await sql`DELETE FROM rooms WHERE id = ${id}`;
  else await sql`DELETE FROM room_members WHERE room = ${id} AND uid = ${uid}`;
  await sql`DELETE FROM invites WHERE from_uid = ${uid}`;
  return { ok: true };
};

ops.roomOpen = async (sql, uid, { id, open }) => {
  await sql`UPDATE rooms SET open = ${!!open} WHERE id = ${str(id, 40) || ''} AND host = ${uid}`;
  return { ok: true };
};

ops.roomMember = async (sql, uid, { id, info }) => {
  const m = memberInfo(info);
  await sql`UPDATE room_members SET dex = ${m.dex}, shiny = ${m.shiny}, seen = now() WHERE room = ${str(id, 40) || ''} AND uid = ${uid}`;
  return { ok: true };
};

/** Quien lleva un rato sin dar señales sale de la sala; si es el anfitrión, la sala se cierra. */
async function pruneRoom(sql, id) {
  await sql`DELETE FROM rooms r WHERE r.id = ${id} AND NOT EXISTS (
              SELECT 1 FROM room_members m WHERE m.room = r.id AND m.uid = r.host
                AND m.seen > now() - make_interval(secs => ${MEMBER_S}))`;
  await sql`DELETE FROM room_members WHERE room = ${id} AND seen < now() - make_interval(secs => ${MEMBER_S})`;
}

/**
 * Lo que pregunta cada navegador mientras está en una sala: quién hay, si
 * sigue abierta y los mensajes que le han llegado (señalización y relé).
 * `ack` = último mensaje ya recibido: se borran hasta ahí.
 */
ops.roomPoll = async (sql, uid, { id, ack }) => {
  id = str(id, 40) || '';
  ack = Number.isSafeInteger(ack) ? ack : 0;
  const seen = await sql`UPDATE room_members SET seen = now() WHERE room = ${id} AND uid = ${uid} RETURNING uid`;
  if (!seen.length) return { room: null, msgs: [] };
  await pruneRoom(sql, id);
  const [r] = await sql`SELECT host, open FROM rooms WHERE id = ${id}`;
  if (!r) return { room: null, msgs: [] };
  const members = await sql`SELECT uid, name, dex, shiny, joined FROM room_members WHERE room = ${id} ORDER BY joined`;
  if (!members.some(m => m.uid === uid)) return { room: null, msgs: [] };
  if (ack) await sql`DELETE FROM room_msgs WHERE room = ${id} AND to_uid = ${uid} AND id <= ${ack}`;
  const msgs = await sql`SELECT id, from_uid, body FROM room_msgs WHERE room = ${id} AND to_uid = ${uid} AND id > ${ack} ORDER BY id LIMIT 500`;
  return {
    room: { host: r.host, open: r.open, members: members.map(m => ({ uid: m.uid, name: m.name, dex: m.dex, shiny: m.shiny, at: +m.joined })) },
    msgs: msgs.map(m => ({ id: +m.id, f: m.from_uid, b: m.body }))
  };
};

/** Envía mensajes a otros miembros de la sala: [{ to, b }] (b = texto JSON). */
ops.roomSend = async (sql, uid, { id, msgs }) => {
  id = str(id, 40) || '';
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 200) throw bad('bad-msgs');
  const members = new Set((await sql`SELECT uid FROM room_members WHERE room = ${id}`).map(m => m.uid));
  if (!members.has(uid)) throw new ApiError(403, 'not-member');
  const rows = msgs.filter(m => m && members.has(m.to) && typeof m.b === 'string' && m.b.length < 200000)
    .map(m => ({ room: id, to_uid: m.to, from_uid: uid, body: m.b }));
  if (rows.length) await sql`INSERT INTO room_msgs ${sql(rows, 'room', 'to_uid', 'from_uid', 'body')}`;
  return { ok: true, n: rows.length };
};

// =====================================================================
//                                RANKING
// =====================================================================

ops.runStart = async (sql, uid, { mode }) => {
  await sql`INSERT INTO runs (uid, started, mode) VALUES (${uid}, now(), ${mode === 'g' ? 'g' : 's'})
            ON CONFLICT (uid) DO UPDATE SET started = now(), mode = excluded.mode`;
  return { ok: true };
};

/**
 * Sube una marca. El servidor decide las tablas (los periodos de hoy) y sólo
 * escribe donde mejora. Anti-trampas (lo que hacían las reglas de Firestore):
 *   - no puede durar más que el tiempo real desde runStart
 *   - nivel y derrotados tienen que cuadrar con el tiempo
 * → { better: ['d','w',...] }
 */
ops.rankSubmit = async (sql, uid, { mode, t, lv, kills, team }) => {
  mode = mode === 'g' ? 'g' : 's';
  t = int(t); lv = int(lv); kills = int(kills);
  if (t == null || t < 5 || t > 21600) throw bad('bad-entry');
  if (lv == null || lv < 1 || lv > 10 + t / 4) throw bad('bad-entry');
  if (kills == null || kills < 0 || kills > 100 + t * 12) throw bad('bad-entry');
  const [run] = await sql`SELECT extract(epoch FROM now() - started)::int AS s FROM runs WHERE uid = ${uid}`;
  if (!run || t > run.s + 15) throw bad('too-long', 'Marca no válida.');
  team = Array.isArray(team) ? team.slice(0, MAX_PLAYERS) : [];
  let members;
  if (mode === 's') {
    const m = team[0] || {};
    members = [{ uid, dex: int(m.dex) || 0, shiny: !!m.shiny }];
  } else {
    members = team.map(m => ({ uid: str(m && m.uid, 40), dex: int(m && m.dex) || 0, shiny: !!(m && m.shiny) })).filter(m => m.uid);
    if (members.length < 2 || !members.some(m => m.uid === uid) || new Set(members.map(m => m.uid)).size !== members.length) throw bad('bad-team');
    members.sort((a, b) => (a.uid < b.uid ? -1 : 1));
  }
  const uids = members.map(m => m.uid);
  const nicks = new Map((await sql`SELECT uid, name FROM profiles WHERE uid = ANY(${sql.array(uids, 25)})`).map(p => [p.uid, p.name]));
  if (nicks.size !== uids.length) throw bad('bad-team');
  const id = uids.join('_');
  const ids = periodIds();
  const boards = ['d', 'w', 'm', 'a'].map(p => [mode + '_' + ids[p], p]);
  for (const d of new Set(members.map(m => m.dex))) boards.push([mode + '_all_p' + d, null]);
  const row = { t, uids, names: uids.map(u => nicks.get(u)), dex: members.map(m => m.dex), shiny: members.map(m => m.shiny), lv, kills };
  const better = [];
  for (const [board, period] of boards) {
    const r = await sql`
      INSERT INTO lb (board, id, t, uids, names, dex, shiny, lv, kills)
      VALUES (${board}, ${id}, ${t}, ${sql.array(row.uids, 25)}, ${sql.array(row.names, 25)}, ${sql.array(row.dex, 23)},
              ${sql.array(row.shiny, 16)}, ${lv}, ${kills})
      ON CONFLICT (board, id) DO UPDATE SET t = excluded.t, names = excluded.names, dex = excluded.dex,
        shiny = excluded.shiny, lv = excluded.lv, kills = excluded.kills, at = now()
      WHERE lb.t < excluded.t
      RETURNING board`;
    if (r.length && period && !better.includes(period)) better.push(period);
  }
  return { better };
};

const rowOut = r => ({ id: r.id, t: r.t, uids: r.uids, names: r.names, dex: r.dex, shiny: r.shiny, lv: r.lv, kills: r.kills });

/** El top 50 de una tabla; con friends, sólo tú y tus amigos. */
ops.rankTop = async (sql, uid, { board, friends }) => {
  if (!BOARD.test(board || '')) throw bad('bad-board');
  let rows;
  if (friends) {
    const circle = [uid, ...(await sql`
      SELECT CASE WHEN a = ${uid} THEN b ELSE a END AS u FROM friendships
       WHERE (a = ${uid} OR b = ${uid}) AND status = 'ok'`).map(r => r.u)];
    rows = await sql`SELECT * FROM lb WHERE board = ${board} AND uids && ${sql.array(circle, 25)} ORDER BY t DESC LIMIT ${TOP}`;
  } else {
    rows = await sql`SELECT * FROM lb WHERE board = ${board} ORDER BY t DESC LIMIT ${TOP}`;
  }
  return { rows: rows.map(rowOut) };
};

/** Tu puesto en una tabla, aunque no salgas en el top. */
ops.rankMine = async (sql, uid, { board }) => {
  if (!BOARD.test(board || '')) throw bad('bad-board');
  const [mine] = await sql`SELECT * FROM lb WHERE board = ${board} AND ${uid} = ANY(uids) ORDER BY t DESC LIMIT 1`;
  if (!mine) return { mine: null };
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lb WHERE board = ${board} AND t > ${mine.t}`;
  return { mine: { pos: n + 1, t: mine.t, row: rowOut(mine) } };
};

// =====================================================================
//                                ENTRADA
// =====================================================================

/** Orígenes que pueden llamar a la API desde otra web (p. ej. GitHub Pages). */
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;            // Vercel ya lo ha leído
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2 * MAX_SAVE) throw bad('too-big'); }
  return raw ? JSON.parse(raw) : {};
}

async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  try {
    const body = await readBody(req).catch(() => { throw bad('bad-json'); });
    req.body = body;
    const fn = Object.prototype.hasOwnProperty.call(ops, body.op) ? ops[body.op] : null;
    if (!fn) throw bad('bad-op');
    const sql = await ready();
    const uid = open.has(body.op) ? null : await auth(sql, req);
    return send(res, 200, await fn(sql, uid, body, req));
  } catch (e) {
    if (e instanceof ApiError || e.status) return send(res, e.status || 400, { error: e.code, msg: e.message });
    console.error('[api]', req.body && req.body.op, e);
    return send(res, 500, { error: 'server', msg: 'Error del servidor.' });
  }
}

module.exports = { handler, ops, periodIds };
