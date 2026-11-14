/* ============ ranking.js — clasificación de tiempo aguantado ============
 * Todo va por la API del servidor (server/api.js), que guarda las marcas en
 * Postgres y las valida contra trampas (ninguna marca puede durar más que el
 * tiempo real desde runStart; nivel y derrotados tienen que cuadrar).
 *
 *   tabla = modo + periodo:
 *     s_d20261008   solitario, hoy            g_...   en grupo
 *     s_w2026-41    semana ISO                s_m202610  mes
 *     s_all         histórico
 *     s_all_p25     histórico sólo con Pikachu (el filtro por Pokémon sólo
 *                   existe en el histórico)
 *   id = tu uid (solitario) o los uid del equipo ordenados y unidos con "_".
 *
 * El servidor decide en qué tablas se apunta cada partida (las de hoy), así
 * que el navegador sólo manda la marca. Lo leído se guarda 2 min en el
 * navegador (cambiar de pestaña y volver no pregunta otra vez).
 *
 * Los periodos se cuentan en hora de España (Europe/Madrid).
 */
G.Ranking = (() => {
  const TZ = 'Europe/Madrid';
  const PERIODS = [['d', 'Diario'], ['w', 'Semanal'], ['m', 'Mensual'], ['a', 'Histórico']];
  const TOP = 50;
  const TTL = 2 * 60 * 1000;            // caché de lo leído

  const on = () => G.DB.online;
  const api = (op, body) => G.DB.api(op, body);

  // ---------------- periodos ----------------

  function madridDate(date) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day };
  }

  /** Semana ISO (lunes a domingo) de una fecha y-m-d. */
  function isoWeek(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
  }

  function periodIds(date = new Date()) {
    const { y, m, d } = madridDate(date);
    const w = isoWeek(y, m, d);
    const p2 = n => String(n).padStart(2, '0');
    return { d: 'd' + y + p2(m) + p2(d), w: 'w' + w.year + '-' + p2(w.week), m: 'm' + y + p2(m), y: 'y' + y, a: 'all' };
  }

  /** El filtro por Pokémon sólo existe en el histórico. */
  function board(mode, period, dex) {
    return mode + '_' + periodIds()[period] + (dex && period === 'a' ? '_p' + dex : '');
  }

  // ---------------- caché en el navegador ----------------

  const mem = new Map();                 // clave -> { at, v }
  function cacheGet(k) {
    const c = mem.get(k);
    return c && Date.now() - c.at < TTL ? c.v : undefined;
  }
  function cacheSet(k, v) { mem.set(k, { at: Date.now(), v }); }

  /** Lo leído de una tabla (y de su versión de amigos) se tira al mejorar tu marca. */
  const inflight = new Map();
  function cached(k, fn) {
    const c = cacheGet(k);
    if (c !== undefined) return Promise.resolve(c);
    if (!inflight.has(k)) inflight.set(k, fn().then(v => { cacheSet(k, v); return v; }).finally(() => inflight.delete(k)));
    return inflight.get(k);
  }

  // ---------------- guardar ----------------

  /**
   * Al empezar una partida: el servidor apunta la hora (anti-trampas: ninguna
   * marca puede durar más que el tiempo real desde entonces).
   */
  function runStarted(mode) {
    if (!on()) return;
    api('runStart', { mode }).catch(e => console.warn('[Ranking] inicio:', e.code || e.message));
  }

  function announce(better) {
    if (!better.length) return;
    const names = { d: 'de hoy', w: 'de la semana', m: 'del mes', a: 'histórico' };
    const best = PERIODS.map(p => p[0]).filter(p => better.includes(p)).pop();
    G.UI.toast('¡Nueva mejor marca ' + names[best] + ' en el ranking!', 3400);
  }

  async function submit(mode, r, team) {
    try {
      const { better } = await api('rankSubmit', { mode, t: r.t | 0, lv: r.lv | 0, kills: r.kills | 0, team });
      if (better.length) mem.clear();
      announce(better);
      return better;
    } catch (e) {
      console.warn('[Ranking] no se pudo guardar:', e.code || e.message);
      return [];
    }
  }

  async function submitSolo(r) {
    if (!on() || !G.Social.me || r.t < 5) return [];
    return submit('s', r, [{ dex: r.dex, shiny: !!r.shiny }]);
  }

  /** La sube el anfitrión, con todo el equipo. */
  async function submitGroup(r) {
    if (!on() || r.t < 5 || !r.members || r.members.length < 2) return [];
    return submit('g', r, r.members.map(m => ({ uid: m.uid, dex: m.dex, shiny: !!m.shiny })));
  }

  // ---------------- leer ----------------

  /**
   * Mejores marcas de una tabla.
   * @param friendsOnly  sólo tú y tus amigos
   */
  async function top(mode, period, dex, friendsOnly) {
    if (!on()) return [];
    const b = board(mode, period, dex);
    return cached((friendsOnly ? 'f:' : 't:') + b, () => api('rankTop', { board: b, friends: !!friendsOnly }).then(r => r.rows.slice(0, TOP)));
  }

  /** Tu puesto en la tabla (aunque no salgas en el top). → { pos, t, row } | null */
  async function myRank(mode, period, dex) {
    if (!on()) return null;
    const b = board(mode, period, dex);
    return cached('r:' + b, () => api('rankMine', { board: b }).then(r => r.mine));
  }

  /** Al borrar la cuenta el servidor ya quita tus marcas. */
  async function removeMine() { mem.clear(); }

  return { PERIODS, periodIds, board, runStarted, submitSolo, submitGroup, top, myRank, removeMine };
})();
