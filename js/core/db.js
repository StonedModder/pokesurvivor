/* ============ db.js — base de datos: la nube (API propia) o local ============
 * TODO el acceso a datos persistentes pasa por aquí. El resto del juego sólo
 * usa G.DB.*.
 *
 * Dos modos (se decide en ready()):
 *
 *   NUBE  (la API del juego en Vercel: api/v1.js + Postgres)
 *     Si hay dirección de la API en js/core/cloud-config.js y el juego se abre
 *     desde una web (http/https, también localhost). La partida se guarda en
 *     el servidor y se puede seguir en cualquier ordenador. Las cuentas son de
 *     nombre + contraseña; el navegador guarda un token de sesión.
 *     Además se guarda una copia local para poder jugar sin conexión; al
 *     sincronizar se FUSIONA (ver merge): las colecciones se unen y nunca se
 *     pierde un Pokémon ni un shiny.
 *
 *   LOCAL (localStorage)
 *     Si no hay configuración, el servidor no responde o se abre con doble
 *     clic (file://). Cuentas y partidas sólo en este navegador.
 *       ps.accounts      { clave: { name, salt, hash, created } }
 *       ps.save.<clave>  partida de esa cuenta
 *       ps.session       última cuenta con sesión iniciada
 *
 * El modo invitado juega con una partida en memoria que no se guarda.
 */
G.DB = (() => {
  const K_ACC = 'ps.accounts', K_SES = 'ps.session', K_SAVE = 'ps.save.';
  const K_CLOUD = 'ps.cloud.', K_MIGRATED = 'ps.migrated.';
  const K_TOKEN = 'ps.token';          // { token, uid } de la sesión en la nube
  const VERSION = 3;
  const START_COINS = 500;

  let mode = 'local';       // 'cloud' | 'local'
  let localReason = '';     // por qué no hay nube: 'file' | 'config' | 'error'
  let user = null;          // nombre visible
  let key = null;           // clave local (minúsculas) o uid de la nube
  let guest = false;
  let save = null;
  let storageOk = true;

  // ---------------- almacenamiento local seguro ----------------

  function read(k) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
    catch (e) { storageOk = false; return null; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { storageOk = false; return false; }
  }
  function remove(k) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } }

  // ---------------- partida ----------------

  function newSave(name) {
    return {
      v: VERSION,
      name,
      created: Date.now(),
      updated: Date.now(),    // última modificación (para fusionar)
      coins: START_COINS,
      owned: {},              // dex -> { at, from: 'starter'|'gacha'|'wild' }
      shiny: {},              // dex -> { at, from } — variantes shiny conseguidas
      partner: null,          // dex del Pokémon con el que juegas
      partnerShiny: false,    // jugar con su versión shiny (si la tienes)
      starter: null,          // dex que te tocó en el test
      personality: null,      // { trait, scores }
      upgrades: {},           // (antiguo) mejoras de la cuenta; ahora van por Pokémon
      pupg: {},               // dex -> { id -> nivel }: mejoras de cada Pokémon
      tickets: { t1: 0, t10: 0 },   // tickets del gacha (x1 y x10)
      pity: {},               // generación del banner -> tiradas sin ★5
      legends: {},            // dex -> fecha: legendarios vencidos en grietas
      arenas: {},             // tipo -> fecha: arenas de grieta ganadas
      itemsFound: {},         // id -> fecha: objetos equipables encontrados
      evoMoves: {},           // id -> fecha: movimientos evolucionados alguna vez
      ach: {},                // id -> fecha: logros conseguidos
      missions: {},           // misiones del día / semana (systems/progress.js)
      profile: { favs: [], title: '' },   // perfil público: 3 favoritos y título
      stats: { runs: 0, bestTime: 0, bestLevel: 0, totalKills: 0, pulls: 0, coinsEarned: 0, shinies: 0,
               bossesTotal: 0, riftWins: 0, evolutions: 0, missionsDone: 0, groupRuns: 0, bestGroupTime: 0 }
    };
  }

  /** Rellena campos que falten en partidas de versiones anteriores. */
  function migrate(s, name) {
    const base = newSave(name || s.name);
    for (const k in base) if (s[k] == null) s[k] = base[k];
    for (const k in base.stats) if (s.stats[k] == null) s.stats[k] = base.stats[k];
    // v1 -> v2: había un único banner (Kanto) con el pity como número.
    if (typeof s.pity === 'number') s.pity = { 1: s.pity };
    // v2 -> v3: las mejoras eran de la cuenta; pasan al compañero de entonces.
    if (!s.pupgDone) {
      if (s.partner && Object.values(s.upgrades || {}).some(v => v > 0)) {
        s.pupg[s.partner] = Object.assign({}, s.upgrades);
      }
      s.pupgDone = true;
    }
    s.tickets = Object.assign({ t1: 0, t10: 0 }, s.tickets);
    s.v = VERSION;
    return s;
  }

  /**
   * Fusiona dos versiones de la misma partida (p. ej. una jugada sin
   * conexión y la de la nube). Nunca se pierde nada conseguido:
   *   - colecciones (owned, shiny): unión
   *   - mejoras y estadísticas: el máximo de cada una
   *   - monedas, compañero, pity...: los de la versión más reciente
   * Es idempotente: fusionar dos veces da lo mismo.
   */
  function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    const newer = (a.updated || 0) >= (b.updated || 0) ? a : b;
    const older = newer === a ? b : a;
    const r = JSON.parse(JSON.stringify(newer));
    for (const coll of ['owned', 'shiny']) {
      r[coll] = r[coll] || {};
      for (const k in older[coll] || {}) {
        if (!r[coll][k] || (older[coll][k].at || 0) < (r[coll][k].at || 0)) r[coll][k] = older[coll][k];
      }
    }
    for (const k in older.upgrades || {}) r.upgrades[k] = Math.max(r.upgrades[k] || 0, older.upgrades[k]);
    r.pupg = r.pupg || {};
    for (const d in older.pupg || {}) {
      const mine = r.pupg[d] = r.pupg[d] || {};
      for (const k in older.pupg[d]) mine[k] = Math.max(mine[k] || 0, older.pupg[d][k]);
    }
    r.pupgDone = r.pupgDone || older.pupgDone;
    // Lo conseguido nunca se pierde: unión de legendarios, arenas, objetos, logros...
    for (const coll of ['legends', 'arenas', 'itemsFound', 'evoMoves', 'ach']) {
      r[coll] = r[coll] || {};
      for (const k in older[coll] || {}) if (!r[coll][k]) r[coll][k] = older[coll][k];
    }
    // Misiones del mismo día/semana: el mayor progreso y lo ya recogido.
    const mo = older.missions || {}, mr = r.missions = r.missions || {};
    for (const [per, list] of [['day', 'daily'], ['week', 'weekly']]) {
      if (mr[per] !== mo[per] || !mr[list] || !mo[list]) continue;
      mr[list].forEach((m, i) => {
        const o = mo[list][i];
        if (!o || o.id !== m.id) return;
        m.prog = Math.max(m.prog || 0, o.prog || 0);
        m.claimed = m.claimed || o.claimed;
        m.told = m.told || o.told;
      });
    }
    for (const k in older.stats || {}) r.stats[k] = Math.max(r.stats[k] || 0, older.stats[k] || 0);
    if (r.starter == null) r.starter = older.starter;
    if (r.personality == null) r.personality = older.personality;
    if (r.partner == null || !r.owned[r.partner]) { r.partner = older.partner; r.partnerShiny = older.partnerShiny; }
    r.created = Math.min(a.created || Date.now(), b.created || Date.now());
    r.updated = Math.max(a.updated || 0, b.updated || 0);
    return r;
  }

  /** Sustituye el contenido de `save` sin cambiar el objeto (otros módulos lo tienen). */
  function applyInPlace(s) {
    for (const k of Object.keys(save)) if (!(k in s)) delete save[k];
    Object.assign(save, s);
  }

  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;

  // =====================================================================
  //                               MODO LOCAL
  // =====================================================================

  async function hash(pass, salt) {
    const text = salt + ':' + pass;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  function randomSalt() {
    const a = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.random() * 256;
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function loadLocal(k, name) {
    const s = read(K_SAVE + k);
    return s ? migrate(s, name) : newSave(name);
  }

  function beginLocal(k, name) {
    key = k; user = name; guest = false;
    save = loadLocal(k, name);
    write(K_SES, k);
  }

  async function registerLocal(name, pass) {
    const accs = read(K_ACC) || {};
    const k = name.toLowerCase();
    if (accs[k]) return { ok: false, error: 'Ese nombre ya existe.' };
    const salt = randomSalt();
    accs[k] = { name, salt, hash: await hash(pass, salt), created: Date.now() };
    if (!write(K_ACC, accs)) return { ok: false, error: 'El navegador no deja guardar datos (¿modo incógnito?).' };
    beginLocal(k, name);
    write(K_SAVE + k, save);
    return { ok: true, isNew: true };
  }

  async function loginLocal(name, pass) {
    const accs = read(K_ACC) || {};
    const acc = accs[name.toLowerCase()];
    if (!acc || acc.hash !== await hash(pass || '', acc.salt)) {
      return { ok: false, error: 'Usuario o contraseña incorrectos.' };
    }
    beginLocal(name.toLowerCase(), acc.name);
    return { ok: true, isNew: !save.partner };
  }

  function restoreLocal() {
    const k = read(K_SES);
    if (!k) return false;
    const accs = read(K_ACC) || {};
    if (!accs[k]) { remove(K_SES); return false; }
    beginLocal(k, accs[k].name);
    return true;
  }

  /** Partida de una cuenta local antigua, si el nombre y la contraseña coinciden. */
  async function legacySave(name, pass) {
    const k = (name || '').toLowerCase();
    const acc = (read(K_ACC) || {})[k];
    if (!acc || read(K_MIGRATED + k)) return null;
    if (acc.hash !== await hash(pass || '', acc.salt)) return null;
    const s = read(K_SAVE + k);
    return s ? { key: k, save: migrate(s, acc.name) } : null;
  }


  // =====================================================================
  //                               MODO NUBE
  // =====================================================================

  let apiUrl = null, token = null, uid = null, ver = 0;
  let pushT = 0, retryT = 0, pending = false, pushing = null, lastPush = 0;
  // Como mucho una subida cada 5 min; lo que cuesta algo (gacha, mejoras), a
  // los 30 s. La copia local se guarda siempre al momento (y se fusiona con la
  // nube al volver a entrar), y al ocultar o cerrar la pestaña se sube lo pendiente.
  const PUSH_GAP = 5 * 60 * 1000, PUSH_GAP_URGENT = 30 * 1000;
  let syncState = 'local';           // 'ok' | 'syncing' | 'pending' | 'offline' | 'local'
  const listeners = new Set();

  function setSync(s) { syncState = s; listeners.forEach(fn => { try { fn(s); } catch (e) { /* nada */ } }); }

  /**
   * Llama a la API: POST { op, ...body } con el token de sesión.
   * Errores: e.code = lo que dice el servidor ('wrong-password'...) o
   * 'unavailable' si no hay conexión; e.msg = el mensaje para el jugador.
   */
  async function api(op, body = {}, opts = {}) {
    if (!apiUrl) throw Object.assign(new Error('sin nube'), { code: 'unavailable' });
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), opts.timeout || 15000);
    const json = JSON.stringify(Object.assign({ op }, body));
    try {
      const r = await fetch(apiUrl, {
        method: 'POST', signal: ctl.signal,
        headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
        body: json,
        // Al cerrar la pestaña: que la petición llegue igual (sólo si es pequeña).
        keepalive: !!opts.keepalive && json.length < 60000
      });
      let j = {};
      try { j = await r.json(); } catch (e) { /* sin cuerpo */ }
      if (!r.ok || j.error) {
        throw Object.assign(new Error(j.msg || j.error || 'HTTP ' + r.status), { code: j.error || (r.status >= 500 ? 'server' : 'http'), status: r.status, msg: j.msg });
      }
      return j;
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof TypeError) throw Object.assign(new Error('sin conexión'), { code: 'unavailable' });
      throw e;
    } finally { clearTimeout(tm); }
  }

  function setSession(s) {
    token = s ? s.token : null;
    if (s) write(K_TOKEN, { token: s.token, uid: s.uid }); else remove(K_TOKEN);
  }

  async function initCloud() {
    const url = G.CLOUD_API;
    if (!/^https?:$/.test(location.protocol)) { localReason = 'file'; return false; }
    if (!url) { localReason = 'config'; return false; }
    apiUrl = url;
    const ses = read(K_TOKEN);
    if (ses && ses.token) token = ses.token;
    else {
      // Sin sesión guardada: ¿hay servidor? (p. ej. publicado en una web sin la API)
      try { await api('ping', {}, { timeout: 5000 }); }
      catch (e) { apiUrl = null; throw e; }
    }
    addEventListener('online', () => { if (pending) pushNow(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pending) pushNow(true); });
    addEventListener('pagehide', () => { if (pending) pushNow(true); });
    return true;
  }

  const plain = s => JSON.parse(JSON.stringify(s));

  /** Abre la partida de la nube de un usuario recién autenticado. */
  async function openCloud(u, opts = {}) {
    uid = u.uid;
    const cached = read(K_CLOUD + uid);
    ver = read(K_CLOUD + uid + '.ver') || 0;
    let remote = null, online = true;
    try {
      const r = await api('saveGet');
      remote = r.save; ver = r.ver;
    } catch (e) {
      if (!cached || e.code !== 'unavailable') throw e;    // sin conexión y sin copia: no hay nada que abrir
      online = false;
    }
    let s = merge(cached && migrate(cached), remote && migrate(remote));
    if (!s) s = newSave(opts.name || u.name || 'Entrenador');
    if (opts.legacy) {
      s = merge(s, opts.legacy.save);
      write(K_MIGRATED + opts.legacy.key, uid);
    }
    save = migrate(s, s.name);
    key = uid; user = save.name; guest = false;
    write(K_CLOUD + uid, save);
    if (online) await pushNow(); else { pending = true; setSync('offline'); scheduleRetry(); }
  }

  /**
   * Sube la partida. El servidor sólo la acepta si nadie ha guardado desde la
   * última versión que vimos; si no, devuelve la suya, se fusiona y se reintenta.
   * @param leaving  la pestaña se cierra: la petición tiene que salir ya
   */
  function pushNow(leaving = false) {
    if (mode !== 'cloud' || guest || !save || !uid) return Promise.resolve();
    if (pushing) { pending = true; return pushing; }
    clearTimeout(pushT); pushT = 0; pushDue = 0;
    if (navigator.onLine === false) {
      pending = true; setSync('offline'); scheduleRetry();
      return Promise.resolve();
    }
    pending = false;
    lastPush = Date.now();
    setSync('syncing');
    let merged = plain(save), conflicted = false;
    pushing = (async () => {
      let r = await api('savePut', { save: merged, ver }, { keepalive: leaving });
      for (let i = 0; r.conflict && i < 4; i++) {
        conflicted = true;
        merged = r.save ? merge(plain(save), migrate(r.save)) : plain(save);
        ver = r.ver;
        r = await api('savePut', { save: merged, ver });
      }
      if (r.conflict) throw Object.assign(new Error('conflicto'), { code: 'conflict' });
      ver = r.ver;
      write(K_CLOUD + uid + '.ver', ver);
    })().then(() => {
      // Otro ordenador había guardado: lo suyo se une a la partida (sin perder
      // lo que se haya jugado aquí mientras se subía).
      if (save && conflicted) { applyInPlace(merge(plain(save), merged)); write(K_CLOUD + uid, save); }
      setSync(pending ? 'pending' : 'ok');
      if (G.UI && G.UI.refreshCoins) G.UI.refreshCoins();
    }).catch(e => {
      console.warn('[DB] no se pudo sincronizar:', e.code || e.message);
      pending = true;
      if (e.status === 401) { setSync('offline'); return; }       // sesión caducada: al volver a entrar
      setSync(navigator.onLine === false || e.code === 'unavailable' ? 'offline' : 'pending');
      scheduleRetry();
    }).finally(() => {
      pushing = null;
      if (pending && syncState === 'pending') schedulePush(Math.max(1500, PUSH_GAP - (Date.now() - lastPush)));
    });
    return pushing;
  }

  // Si ya había una subida programada antes, se respeta (una compra no espera a la siguiente partida).
  let pushDue = 0;
  function schedulePush(ms) {
    const due = Date.now() + ms;
    if (pushT && pushDue && pushDue <= due) return;
    clearTimeout(pushT); pushDue = due;
    pushT = setTimeout(() => { pushT = 0; pushDue = 0; pushNow(); }, ms);
  }
  function scheduleRetry() { clearTimeout(retryT); retryT = setTimeout(() => { if (pending) pushNow(); }, 15000); }

  function apiError(e) {
    if (e && e.msg) return e.msg;                 // el servidor ya lo explica
    const c = (e && e.code) || '';
    if (c === 'unavailable') return 'Sin conexión con el servidor.';
    if (c === 'no-db') return 'El servidor no tiene base de datos configurada.';
    return 'Error: ' + (c || (e && e.message) || 'desconocido');
  }

  // =====================================================================
  //                           API PÚBLICA
  // =====================================================================

  let readyP = null;

  /** Arranca la base de datos y recupera la sesión anterior. → true si hay sesión. */
  function ready() {
    if (readyP) return readyP;
    readyP = (async () => {
      try { if (await initCloud()) mode = 'cloud'; }
      catch (e) { console.warn('[DB] sin nube:', e.message); localReason = 'error'; mode = 'local'; }
      if (mode === 'local') { setSync('local'); return restoreLocal(); }
      if (!token) return false;
      const ses = read(K_TOKEN) || {};
      try {
        let me;
        try { me = await api('me'); }
        catch (e) {
          // Sin conexión: se juega con la copia local y se sube al volver.
          if (e.code === 'unavailable' && ses.uid && read(K_CLOUD + ses.uid)) me = { uid: ses.uid };
          else throw e;
        }
        await openCloud(me);
        return true;
      } catch (e) {
        console.warn('[DB] no se pudo abrir la partida:', e.code || e.message);
        if (e.status === 401) setSession(null);
        return false;
      }
    })();
    return readyP;
  }

  async function register(name, pass) {
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El nombre debe tener 3-16 letras, números o _.' };
    const min = mode === 'cloud' ? 6 : 4;
    if ((pass || '').length < min) return { ok: false, error: `La contraseña debe tener al menos ${min} caracteres.` };
    if (mode === 'local') return registerLocal(name, pass);
    try {
      const legacy = await legacySave(name, pass);
      const s = await api('register', { name, pass });
      setSession(s);
      await openCloud(s, { name, legacy });
      return { ok: true, isNew: !save.partner, imported: !!legacy };
    } catch (e) { return { ok: false, error: apiError(e) }; }
  }

  async function login(name, pass) {
    name = (name || '').trim();
    if (mode === 'local') return loginLocal(name, pass);
    try {
      const legacy = await legacySave(name, pass);
      const s = await api('login', { name, pass: pass || '' });
      setSession(s);
      await openCloud(s, { name: s.name, legacy });
      return { ok: true, isNew: !save.partner, imported: !!legacy };
    } catch (e) { return { ok: false, error: apiError(e) }; }
  }

  async function loginWithGoogle() {
    return { ok: false, error: 'Entrar con Google no está disponible: crea una cuenta con nombre y contraseña.' };
  }

  /** Cambia el nombre que se ve en la partida (al elegir apodo). */
  function setName(n) {
    if (!save || guest) return;
    save.name = n; user = n;
    commit();
  }

  function playAsGuest() {
    user = 'Invitado'; key = null; guest = true; uid = null;
    save = newSave('Invitado');
    if (mode === 'local') remove(K_SES);
    return { ok: true, isNew: true };
  }

  /**
   * Guarda la partida actual (no hace nada en modo invitado).
   * @param urgent  lo que ha costado algo (tiradas del gacha, mejoras): se sube antes
   */
  function commit(urgent = false) {
    if (guest || !key || !save) return false;
    save.updated = Date.now();
    if (mode === 'local') return write(K_SAVE + key, save);
    write(K_CLOUD + uid, save);
    pending = true;
    setSync('pending');
    schedulePush(Math.max(1200, (urgent ? PUSH_GAP_URGENT : PUSH_GAP) - (Date.now() - lastPush)));
    return true;
  }

  /** Funciones que se ejecutan al cerrar sesión o borrar la cuenta (amigos, salas...). */
  const leaveHooks = [];

  async function logout() {
    for (const fn of leaveHooks) { try { await fn('logout'); } catch (e) { /* nada */ } }
    if (mode === 'cloud' && !guest && save) {
      if (pending) { try { await pushNow(); } catch (e) { /* queda la copia local */ } }
      await api('logout').catch(() => {});
      setSession(null);
    } else if (mode === 'local' && !guest) {
      commit();
      remove(K_SES);
    }
    clearTimeout(pushT); clearTimeout(retryT);
    user = key = save = uid = null; guest = false; pending = false; ver = 0;
    setSync(mode === 'cloud' ? 'ok' : 'local');
  }

  /** Borra la cuenta y la partida (en la nube o en este navegador). */
  async function deleteAccount() {
    if (guest || !key) return { ok: false, error: 'No hay cuenta que borrar.' };
    if (mode === 'local') {
      const accs = read(K_ACC) || {};
      delete accs[key];
      write(K_ACC, accs);
      remove(K_SAVE + key); remove(K_SES);
      user = key = save = null;
      return { ok: true };
    }
    try {
      clearTimeout(pushT); clearTimeout(retryT); pending = false;
      for (const fn of leaveHooks) await fn('delete');
      // El servidor borra todo lo de la cuenta: partida, apodo, amigos, salas y marcas.
      await api('deleteAccount');
      remove(K_CLOUD + uid); remove(K_CLOUD + uid + '.ver');
      setSession(null);
      user = key = save = uid = null; ver = 0;
      return { ok: true };
    } catch (e) { return { ok: false, error: apiError(e) }; }
  }

  // ---------------- helpers de partida ----------------

  function owns(dex) { return !!(save && save.owned[dex]); }

  function grant(dex, from) {
    if (!save.owned[dex]) save.owned[dex] = { at: Date.now(), from };
  }

  function ownsShiny(dex) { return !!(save && save.shiny && save.shiny[dex]); }

  /** Mejoras compradas para un Pokémon: { id -> nivel }. */
  function upgradesOf(dex) {
    if (!save) return {};
    save.pupg = save.pupg || {};
    return save.pupg[dex] || (save.pupg[dex] = {});
  }

  /** Da la versión shiny (y la normal, si no la tenía). Devuelve true si es nueva. */
  function grantShiny(dex, from) {
    grant(dex, from);
    if (save.shiny[dex]) return false;
    save.shiny[dex] = { at: Date.now(), from };
    return true;
  }

  return {
    ready, register, login, loginWithGoogle, playAsGuest, logout, commit, deleteAccount, flush: pushNow,
    owns, grant, ownsShiny, grantShiny, merge, setName, upgradesOf,
    onSync(fn) { listeners.add(fn); },
    onLeave(fn) { leaveHooks.push(fn); },
    /** Llamada a la API del servidor (para los módulos de red; sólo en modo nube). */
    api,
    /** Tu id de jugador en la nube. */
    get uid() { return mode === 'cloud' ? uid : null; },
    /** ¿Está disponible lo online (amigos, ranking, multijugador)? */
    get online() { return mode === 'cloud' && !guest && !!uid && !!save; },
    /** Las cuentas de la nube son todas de nombre y contraseña. */
    get nameAccount() { return mode === 'cloud' && !!uid; },
    /** ¿Se puede entrar con Google? (no con la API propia) */
    google: false,
    get mode() { return mode; },
    get localReason() { return localReason; },
    get syncState() { return syncState; },
    get user() { return user; },
    get guest() { return guest; },
    get save() { return save; },
    get loggedIn() { return !!save; },
    get storageOk() { return storageOk; },
    START_COINS
  };
})();
