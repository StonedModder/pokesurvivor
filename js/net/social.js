/* ============ social.js — apodo, amigos, en línea, invitaciones y salas ============
 * Sólo funciona con cuenta en la nube (G.DB.online). Todo va por la API del
 * servidor (G.DB.api, ver server/api.js):
 *
 *   poll          amigos (con su "en línea") e invitaciones, de una vez. Se
 *                 pregunta cada 30 s con la pestaña visible, y al momento al
 *                 abrir Amigos o la sala. Cada pregunta apunta también tu
 *                 "en línea".
 *   room*         la sala: { host, open, members }. Mientras estás en una, se
 *                 pregunta cada 1-4 s (más a menudo mientras se conecta la
 *                 partida o si va por el relé). Si alguien deja de preguntar
 *                 un rato, el servidor lo saca; si es el anfitrión, la sala
 *                 se cierra.
 *
 * El resto del juego escucha los cambios con G.Social.on(fn).
 */
G.Social = (() => {
  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
  const MAX_PLAYERS = 4;
  const INVITE_TTL = 3 * 60 * 1000;
  const POLL = 30 * 1000;               // amigos e invitaciones
  const PRES_TTL = 10 * 1000;           // al abrir Amigos, lo leído hace menos de esto vale
  const ROOM_LOBBY = 1500, ROOM_GAME = 4000, ROOM_FAST = 250;

  const api = (op, body, opts) => G.DB.api(op, body, opts);
  let uid = null;
  let me = null;                    // { uid, name }
  let friends = new Map();          // otherUid -> { uid, name, status: 'ok'|'in'|'out', online, play, room, seen }
  let pollT = 0, polledAt = 0, polling = null;
  let room = null;                  // { id, host, isHost, members: [{ uid, name, dex, shiny }], open }
  let roomT = 0, roomAck = 0, roomBusy = false;
  const invites = new Map();        // fromUid -> { from, name, room, at }
  const listeners = new Set();
  let started = false;
  let playing = false;

  function emit(what) { listeners.forEach(fn => { try { fn(what); } catch (e) { console.warn(e); } }); }
  const errOf = (e, what) => (e && e.msg) || ('No se pudo ' + what + ' (' + ((e && e.code) || 'error') + ').');

  // ---------------- arranque ----------------

  /** Tras iniciar sesión. → 'ok' | 'need-nick' | 'off' (sin nube) */
  async function start() {
    if (!G.DB.online) return 'off';
    if (started) return me ? 'ok' : 'need-nick';
    uid = G.DB.uid;
    started = true;
    const prof = await api('profileGet').then(r => r.profile).catch(() => null);
    if (prof) { me = { uid, name: prof.name }; if (G.DB.user !== prof.name) G.DB.setName(prof.name); }
    else {
      // El nombre de la cuenta ya es único: se usa de apodo (si nadie lo ha cogido).
      const r = await claimNick(G.DB.save.name);
      if (!r.ok) return 'need-nick';
    }
    online();
    return 'ok';
  }

  /** Reserva un apodo único y crea el perfil público. */
  async function claimNick(name) {
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El apodo debe tener 3-16 letras, números o _.' };
    try { await api('nick', { name }); }
    catch (e) { return { ok: false, error: errOf(e, 'guardar el apodo') }; }
    me = { uid, name };
    G.DB.setName(name);
    if (started && !pollT) online();
    publishProfile(true);
    return { ok: true };
  }

  /** Empieza a preguntar por amigos e invitaciones. */
  function online() {
    if (pollT) return;
    pollT = setInterval(() => { if (document.visibilityState === 'visible') pollNow(); }, POLL);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onHide);
    pollNow();
  }

  const presence = (on = true) => ({ on, room: room ? room.id : '', play: playing });

  /** Amigos (con su "en línea") e invitaciones, y apunta tu "en línea". */
  function pollNow() {
    if (!started || !me) return Promise.resolve();
    if (polling) return polling;
    polling = api('poll', { pres: presence() }).then(r => {
      polledAt = Date.now();
      const next = new Map();
      for (const f of r.friends) next.set(f.uid, f);
      const changed = JSON.stringify([...friends.values()]) !== JSON.stringify([...next.values()]);
      friends = next;
      if (changed) { emit('friends'); emit('presence'); }
      // Invitaciones: las nuevas se añaden, las retiradas se quitan.
      const seen = new Set();
      let invChanged = false;
      for (const v of r.invites) {
        seen.add(v.from);
        if (Date.now() - v.at > INVITE_TTL) continue;
        if (!invites.has(v.from)) { invites.set(v.from, v); invChanged = true; }
      }
      for (const k of [...invites.keys()]) if (!seen.has(k)) { invites.delete(k); invChanged = true; }
      if (invChanged) emit('invites');
    }).catch(e => console.warn('[Social] amigos:', e.code || e.message))
      .finally(() => { polling = null; });
    return polling;
  }

  function setPlaying(p) {
    if (playing === !!p) return;
    playing = !!p;
    if (me) api('presence', presence()).catch(() => {});
  }
  // Al volver a la pestaña, se pregunta enseguida; al cerrarla, "desconectado".
  function onVisible() { if (document.visibilityState === 'visible' && Date.now() - polledAt > POLL) pollNow(); }
  function onHide() {
    if (!me) return;
    api('presence', presence(false), { keepalive: true }).catch(() => {});
    if (room) api('roomLeave', { id: room.id }, { keepalive: true }).catch(() => {});
  }

  async function stop(why) {
    if (!started) return;
    await leaveRoom().catch(() => {});
    clearInterval(pollT); pollT = 0;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', onHide);
    // Al borrar la cuenta, el servidor borra todo; al salir, "desconectado".
    if (me && why !== 'delete') await api('presence', presence(false)).catch(() => {});
    friends.clear(); invites.clear();
    me = null; started = false; uid = null; playing = false; polledAt = 0;
    emit('stop');
  }

  // ---------------- amigos ----------------

  /** Al abrir Amigos o la sala: se pregunta si lo último tiene más de unos segundos. */
  async function refreshPresence(force = false) {
    if (!started || (!force && Date.now() - polledAt < PRES_TTL)) return;
    await pollNow();
    emit('presence');
  }

  /** Envía una solicitud de amistad (o acepta la que ya te había mandado). */
  async function request(name) {
    name = (name || '').trim();
    if (!me) return { ok: false, error: 'Primero elige tu apodo.' };
    if (!VALID.test(name)) return { ok: false, error: 'Escribe el apodo exacto de tu amigo.' };
    try {
      const r = await api('friendRequest', { name });
      await pollNow();
      return { ok: true, msg: r.msg };
    } catch (e) { return { ok: false, error: errOf(e, 'enviar') }; }
  }

  async function accept(other) {
    const f = friends.get(other);
    if (!f || f.status !== 'in') return { ok: false, error: 'No hay solicitud.' };
    try {
      const r = await api('friendAccept', { other });
      await pollNow();
      return { ok: true, msg: r.msg };
    } catch (e) { return { ok: false, error: errOf(e, 'aceptar') }; }
  }

  async function remove(other) {
    if (!friends.get(other)) return { ok: false };
    try { await api('friendRemove', { other }); await pollNow(); return { ok: true }; }
    catch (e) { return { ok: false, error: errOf(e, 'borrar') }; }
  }

  // ---------------- salas ----------------

  function memberInfo() {
    const s = G.DB.save;
    return { dex: s.partner, shiny: !!s.partnerShiny && G.DB.ownsShiny(s.partner) };
  }

  async function createRoom() {
    if (room) return room;
    const r = await api('roomCreate', { info: memberInfo() });
    enterRoom(r.id, uid, [Object.assign({ uid, name: me.name, at: Date.now() }, memberInfo())]);
    return room;
  }

  async function joinRoom(id) {
    if (room && room.id === id) return { ok: true };
    if (room) await leaveRoom();
    let r;
    try { r = await api('roomJoin', { id, info: memberInfo() }); }
    catch (e) { return { ok: false, error: errOf(e, 'entrar en la sala') }; }
    enterRoom(id, r.host, []);
    await roomPoll();
    return { ok: true };
  }

  function enterRoom(id, host, members) {
    room = { id, host, isHost: host === uid, members, open: true };
    roomAck = 0;
    scheduleRoom(0);
    api('presence', presence()).catch(() => {});
    emit('room');
  }

  /** Cada cuánto se pregunta por la sala: rápido mientras se conecta la partida o va por el relé. */
  function roomInterval() {
    if (G.Net && G.Net.open_ && G.Net.wantsFast()) return ROOM_FAST;
    return G.Game && G.Game.state !== 'ui' ? ROOM_GAME : ROOM_LOBBY;
  }

  function scheduleRoom(ms) {
    clearTimeout(roomT);
    roomT = setTimeout(() => { roomPoll().finally(() => { if (room) scheduleRoom(roomInterval()); }); }, ms);
  }

  /** Pregunta por la sala: miembros, si sigue abierta y mensajes de la partida. */
  async function roomPoll() {
    if (!room || roomBusy) return;
    roomBusy = true;
    const id = room.id;
    try {
      const r = await api('roomPoll', { id, ack: roomAck });
      if (!room || room.id !== id) return;
      if (!r.room) { closedRoom(); return; }
      // El anfitrión siempre primero; el resto por orden de llegada.
      const members = r.room.members.slice()
        .sort((a, b) => (a.uid === r.room.host ? -1 : b.uid === r.room.host ? 1 : (a.at || 0) - (b.at || 0)));
      const changed = JSON.stringify(members) !== JSON.stringify(room.members) || room.open !== r.room.open;
      room.members = members; room.open = r.room.open;
      if (changed) emit('room');
      // Los mensajes se dan por recibidos sólo si la conexión de la partida está abierta.
      if (r.msgs.length && G.Net && G.Net.receive(id, r.msgs)) roomAck = r.msgs[r.msgs.length - 1].id;
    } catch (e) {
      if (e.status === 401) closedRoom();
      else console.warn('[Social] sala:', e.code || e.message);
    } finally { roomBusy = false; }
  }

  /** La conexión de la partida tiene algo urgente (señalización): se pregunta ya. */
  function roomNudge() { if (room) scheduleRoom(ROOM_FAST); }

  function closedRoom() {
    if (!room) return;
    clearTimeout(roomT);
    room = null;
    api('presence', presence()).catch(() => {});
    emit('room-closed');
  }

  async function leaveRoom() {
    if (!room) return;
    const r = room;
    clearTimeout(roomT);
    room = null;
    await api('roomLeave', { id: r.id }).catch(() => {});      // también retira tus invitaciones
    api('presence', presence()).catch(() => {});
    emit('room');
  }

  /** El anfitrión cierra la sala a nuevos jugadores al empezar la partida. */
  function setOpen(open) {
    if (room && room.isHost) { room.open = !!open; api('roomOpen', { id: room.id, open: !!open }).catch(() => {}); }
  }

  /** Actualiza tu Pokémon en la sala (si cambias de compañero). */
  function refreshMember() {
    if (room && me) api('roomMember', { id: room.id, info: memberInfo() }).catch(() => {});
  }

  // ---------------- invitaciones ----------------

  async function invite(other) {
    const f = friends.get(other);
    if (!f || f.status !== 'ok') return { ok: false, error: 'Sólo puedes invitar a tus amigos.' };
    if (room && room.members.length >= MAX_PLAYERS) return { ok: false, error: 'La sala está llena.' };
    if (room && !room.isHost) return { ok: false, error: 'Sólo el anfitrión de la sala puede invitar.' };
    try {
      if (!room) await createRoom();
      await api('invite', { to: other, room: room.id });
    } catch (e) { return { ok: false, error: errOf(e, 'invitar') }; }
    return { ok: true, msg: 'Invitación enviada a ' + f.name };
  }

  async function acceptInvite(from) {
    const inv = invites.get(from);
    if (!inv || Date.now() - inv.at > INVITE_TTL) { invites.delete(from); emit('invites'); return { ok: false, error: 'La invitación ha caducado.' }; }
    invites.delete(from);
    api('inviteDel', { from }).catch(() => {});
    emit('invites');
    return joinRoom(inv.room);
  }

  function declineInvite(from) {
    invites.delete(from);
    api('inviteDel', { from }).catch(() => {});
    emit('invites');
  }

  // ---------------- perfil público ----------------

  /** Lo que se enseña de ti (también para tu vista previa, sin subirlo). */
  function profileData() {
    const s = G.DB.save, st = s.stats, prof = s.profile || {};
    const unlocked = G.AchDefs.LIST.filter(a => s.ach && s.ach[a.id]);
    const medals = unlocked.slice().sort((a, b) => (b.tier - a.tier) || (s.ach[b.id] - s.ach[a.id])).slice(0, 8).map(a => a.id);
    return {
      name: me ? me.name : G.DB.user,
      favs: (prof.favs || []).slice(0, 3).map(f => ({ dex: f.dex | 0, shiny: !!f.shiny })),
      title: prof.title || '',
      best: { solo: st.bestTime | 0, group: st.bestGroupTime | 0, level: st.bestLevel | 0, bosses: st.bossesTotal | 0,
              legends: Object.keys(s.legends || {}).length, kills: st.totalKills | 0, medals: unlocked.length },
      medals
    };
  }

  let pubT = 0, pubAt = 0, pubLast = '';
  /**
   * Sube tu perfil (con un poco de espera, por si cambias varias cosas
   * seguidas). Tras cada partida, como mucho una vez cada 10 min; si cambias
   * favoritos o título (force), al momento. Si no ha cambiado nada, no se sube.
   */
  function publishProfile(force = false) {
    if (!me) return;
    if (!force && Date.now() - pubAt < 10 * 60 * 1000) return;
    clearTimeout(pubT);
    pubT = setTimeout(() => {
      if (!me) return;
      const d = profileData();
      const key = JSON.stringify(d);
      if (key === pubLast) return;
      pubLast = key; pubAt = Date.now();
      api('profilePut', { data: d }).catch(e => { pubLast = ''; console.warn('[Social] perfil:', e.code || e.message); });
    }, 800);
  }

  /** El perfil público de otro jugador. */
  const profCache = new Map();
  async function getProfile(other) {
    if (!started) return null;
    // El tuyo sale de tu partida (sin preguntar y siempre al día).
    if (other === uid && me) return Object.assign(profileData(), { name: me.name });
    const c = profCache.get(other);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.v;     // lo leído vale 10 min
    const v = await api('profileGet', { of: other }).then(r => r.profile).catch(() => null);
    profCache.set(other, { at: Date.now(), v });
    return v;
  }

  // Al cerrar sesión o borrar la cuenta.
  G.DB.onLeave(why => stop(why));

  return {
    start, stop, claimNick, request, accept, remove, publishProfile, getProfile, profileData,
    createRoom, joinRoom, leaveRoom, setOpen, refreshMember, setPlaying, refreshPresence, roomNudge,
    invite, acceptInvite, declineInvite,
    on(fn) { listeners.add(fn); }, off(fn) { listeners.delete(fn); },
    get me() { return me; },
    get started() { return started; },
    get friends() { return [...friends.values()]; },
    get invites() { return [...invites.values()]; },
    get room() { return room; },
    get uid() { return uid; },
    VALID, MAX_PLAYERS
  };
})();
