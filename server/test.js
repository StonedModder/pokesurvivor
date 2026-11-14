/* Pruebas de la API contra un Postgres de verdad (¡usa una base de datos de pruebas!):
 *   DATABASE_URL=postgres://ps:ps@localhost:5432/ps node server/test.js
 * Borra y recrea las tablas antes de empezar.
 */
const assert = require('assert');
const { handler } = require('./api');
const { db } = require('./db');

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) {
  console.error('Por seguridad, sólo contra un Postgres local (DATABASE_URL con localhost).');
  process.exit(1);
}

/** Llama a la API como lo haría Vercel. */
function call(op, body = {}, token) {
  return new Promise(resolve => {
    const req = { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: Object.assign({ op }, body) };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      end(b) { resolve({ status: this.statusCode, ...(b ? JSON.parse(b) : {}) }); } };
    handler(req, res);
  });
}

async function main() {
  const sql = db();
  await sql.unsafe('DROP TABLE IF EXISTS lb, runs, room_msgs, room_members, rooms, invites, presence, friendships, profiles, saves, sessions, users CASCADE');

  // ---- cuentas ----
  let r = await call('register', { name: 'Ash', pass: 'pikachu1' });
  assert.ok(r.token, 'registro'); const ash = r;
  r = await call('register', { name: 'ash', pass: 'otraclave' });
  assert.strictEqual(r.error, 'name-taken');
  r = await call('register', { name: 'Ab', pass: 'pikachu1' });
  assert.strictEqual(r.error, 'bad-name');
  r = await call('register', { name: 'Misty', pass: '123' });
  assert.strictEqual(r.error, 'weak-password');
  const misty = await call('register', { name: 'Misty', pass: 'staryu12' });
  const brock = await call('register', { name: 'Brock', pass: 'onix1234' });
  r = await call('login', { name: 'ASH', pass: 'mal' });
  assert.strictEqual(r.error, 'wrong-password');
  r = await call('login', { name: 'ASH', pass: 'pikachu1' });
  assert.strictEqual(r.uid, ash.uid); const ash2 = r.token;
  r = await call('me', {}, ash2); assert.strictEqual(r.name, 'Ash');
  r = await call('me', {}, 'falso'); assert.strictEqual(r.status, 401);
  // bloqueo tras 8 fallos
  for (let i = 0; i < 8; i++) await call('login', { name: 'brock', pass: 'x' });
  r = await call('login', { name: 'brock', pass: 'onix1234' });
  assert.strictEqual(r.error, 'too-many-requests');
  await sql`UPDATE users SET locked = NULL WHERE uid = ${brock.uid}`;

  // ---- partida (dos ordenadores) ----
  r = await call('saveGet', {}, ash.token); assert.deepStrictEqual(r, { status: 200, save: null, ver: 0 });
  r = await call('savePut', { save: { coins: 1 }, ver: 0 }, ash.token); assert.strictEqual(r.ver, 1);
  r = await call('savePut', { save: { coins: 2 }, ver: 1 }, ash.token); assert.strictEqual(r.ver, 2);
  r = await call('savePut', { save: { coins: 3 }, ver: 1 }, ash2);      // el otro ordenador iba atrasado
  assert.ok(r.conflict); assert.strictEqual(r.ver, 2); assert.strictEqual(r.save.coins, 2);
  r = await call('savePut', { save: { coins: 3 }, ver: 2 }, ash2); assert.strictEqual(r.ver, 3);
  r = await call('saveGet', {}, misty.token); assert.strictEqual(r.save, null, 'cada uno sólo ve lo suyo');

  // ---- amigos, presencia, invitaciones ----
  r = await call('friendRequest', { name: 'misty' }, ash.token); assert.ok(r.ok, r.msg);
  r = await call('friendRequest', { name: 'Misty' }, ash.token); assert.strictEqual(r.error, 'already-sent');
  r = await call('friendRequest', { name: 'Ash' }, ash.token); assert.strictEqual(r.error, 'self');
  r = await call('friendRequest', { name: 'Nadie' }, ash.token); assert.strictEqual(r.error, 'not-found');
  r = await call('poll', {}, misty.token);
  assert.strictEqual(r.friends[0].status, 'in'); assert.strictEqual(r.friends[0].name, 'Ash');
  r = await call('friendAccept', { other: ash.uid }, ash.token); assert.strictEqual(r.error, 'no-request', 'sólo acepta quien la recibe');
  r = await call('friendAccept', { other: ash.uid }, misty.token); assert.ok(r.ok);
  await call('poll', { pres: { on: true, room: '', play: false } }, misty.token);
  r = await call('poll', {}, ash.token);
  assert.deepStrictEqual([r.friends[0].status, r.friends[0].online], ['ok', true]);
  r = await call('invite', { to: brock.uid, room: 'x' }, ash.token); assert.strictEqual(r.error, 'not-friends');

  // ---- salas ----
  r = await call('roomCreate', { info: { dex: 25, shiny: true } }, ash.token); const room = r.id; assert.ok(room);
  r = await call('invite', { to: misty.uid, room }, ash.token); assert.ok(r.ok);
  r = await call('poll', {}, misty.token); assert.strictEqual(r.invites[0].room, room);
  r = await call('roomJoin', { id: room, info: { dex: 120 } }, misty.token); assert.strictEqual(r.host, ash.uid);
  r = await call('roomPoll', { id: room }, ash.token);
  assert.deepStrictEqual(r.room.members.map(m => m.name), ['Ash', 'Misty']);
  r = await call('roomSend', { id: room, msgs: [{ to: misty.uid, b: '{"x":1}' }, { to: brock.uid, b: 'no' }] }, ash.token);
  assert.strictEqual(r.n, 1, 'sólo a miembros');
  r = await call('roomSend', { id: room, msgs: [{ to: ash.uid, b: 'x' }] }, brock.token); assert.strictEqual(r.status, 403);
  r = await call('roomPoll', { id: room }, misty.token);
  assert.strictEqual(r.msgs.length, 1); assert.strictEqual(r.msgs[0].f, ash.uid);
  r = await call('roomPoll', { id: room, ack: r.msgs[0].id }, misty.token); assert.strictEqual(r.msgs.length, 0);
  await call('roomOpen', { id: room, open: false }, misty.token);           // no es anfitriona: no cambia
  r = await call('roomPoll', { id: room }, ash.token); assert.strictEqual(r.room.open, true);
  await call('roomOpen', { id: room, open: false }, ash.token);
  r = await call('roomJoin', { id: room }, brock.token); assert.strictEqual(r.error, 'started');
  // el anfitrión desaparece: la sala se cierra sola
  await sql`UPDATE room_members SET seen = now() - interval '2 minutes' WHERE uid = ${ash.uid}`;
  r = await call('roomPoll', { id: room }, misty.token); assert.strictEqual(r.room, null);

  // ---- ranking ----
  r = await call('rankSubmit', { mode: 's', t: 100, lv: 10, kills: 50, team: [{ dex: 25 }] }, ash.token);
  assert.strictEqual(r.error, 'too-long', 'sin runStart no vale');
  await call('runStart', { mode: 's' }, ash.token);
  await sql`UPDATE runs SET started = now() - interval '200 seconds'`;
  r = await call('rankSubmit', { mode: 's', t: 300, lv: 10, kills: 50, team: [{ dex: 25 }] }, ash.token);
  assert.strictEqual(r.error, 'too-long', 'más largo que el tiempo real');
  r = await call('rankSubmit', { mode: 's', t: 100, lv: 99, kills: 50, team: [{ dex: 25 }] }, ash.token);
  assert.strictEqual(r.error, 'bad-entry', 'nivel imposible');
  r = await call('rankSubmit', { mode: 's', t: 100, lv: 10, kills: 50, team: [{ dex: 25, shiny: true }] }, ash.token);
  assert.deepStrictEqual(r.better, ['d', 'w', 'm', 'a']);
  r = await call('rankSubmit', { mode: 's', t: 90, lv: 10, kills: 50, team: [{ dex: 25 }] }, ash.token);
  assert.deepStrictEqual(r.better, [], 'peor marca: no cambia nada');
  await call('runStart', { mode: 's' }, misty.token);
  await call('runStart', { mode: 'g' }, brock.token);
  await sql`UPDATE runs SET started = now() - interval '1000 seconds'`;
  await call('rankSubmit', { mode: 's', t: 150, lv: 10, kills: 50, team: [{ dex: 120 }] }, misty.token);
  await call('rankSubmit', { mode: 's', t: 50, lv: 5, kills: 10, team: [{ dex: 95 }] }, brock.token);
  const { periodIds } = require('./api');
  const day = 's_' + periodIds().d;
  r = await call('rankTop', { board: day }, brock.token);
  assert.deepStrictEqual(r.rows.map(x => x.names[0]), ['Misty', 'Ash', 'Brock']);
  r = await call('rankTop', { board: day, friends: true }, brock.token);
  assert.deepStrictEqual(r.rows.map(x => x.names[0]), ['Brock'], 'Brock no tiene amigos');
  r = await call('rankTop', { board: 's_all_p25' }, brock.token);
  assert.strictEqual(r.rows[0].shiny[0], true);
  r = await call('rankMine', { board: day }, brock.token); assert.strictEqual(r.mine.pos, 3);
  r = await call('rankTop', { board: "x'; drop table lb" }, brock.token); assert.strictEqual(r.error, 'bad-board');
  // en grupo (lo sube el anfitrión)
  r = await call('rankSubmit', { mode: 'g', t: 200, lv: 10, kills: 50, team: [{ uid: brock.uid, dex: 95 }, { uid: ash.uid, dex: 25 }] }, brock.token);
  assert.deepStrictEqual(r.better, ['d', 'w', 'm', 'a']);
  r = await call('rankMine', { board: 'g_all' }, ash.token); assert.strictEqual(r.mine.pos, 1);
  r = await call('rankSubmit', { mode: 'g', t: 200, lv: 10, kills: 50, team: [{ uid: ash.uid, dex: 25 }] }, brock.token);
  assert.strictEqual(r.error, 'bad-team', 'el que sube tiene que estar en el equipo');

  // ---- perfil ----
  r = await call('profilePut', { data: { favs: [{ dex: 25, shiny: 1 }, 1, 2, 3], title: 'Maestro', medals: ['a'], best: { solo: 100 } } }, ash.token);
  assert.ok(r.ok);
  r = await call('profileGet', { of: ash.uid }, misty.token);
  assert.strictEqual(r.profile.favs.length, 3); assert.strictEqual(r.profile.title, 'Maestro'); assert.strictEqual(r.profile.name, 'Ash');
  r = await call('nick', { name: 'Misty' }, ash.token); assert.strictEqual(r.error, 'taken');

  // ---- borrar cuenta: se lleva todo lo suyo ----
  r = await call('deleteAccount', {}, ash.token); assert.ok(r.ok);
  r = await call('me', {}, ash2); assert.strictEqual(r.status, 401, 'las sesiones caen');
  r = await call('poll', {}, misty.token); assert.strictEqual(r.friends.length, 0);
  r = await call('rankTop', { board: 'g_all' }, misty.token); assert.strictEqual(r.rows.length, 0, 'sus marcas en grupo también');
  r = await call('login', { name: 'Ash', pass: 'pikachu1' }); assert.strictEqual(r.error, 'wrong-password');

  console.log('ok: todas las pruebas de la API pasan');
  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
