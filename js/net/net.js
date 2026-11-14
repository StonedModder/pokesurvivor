/* ============ net.js — conexión entre los jugadores de una sala ============
 * Topología en estrella: el ANFITRIÓN habla con cada invitado; los invitados
 * sólo hablan con el anfitrión (él reenvía lo que haga falta).
 *
 * Dos caminos, a la vez:
 *   directo  WebRTC (canal de datos entre navegadores, sin pasar por ningún
 *            servidor). La negociación (señalización) va por el servidor.
 *   relé     Si la red no deja conectar directo (algunos routers y datos
 *            móviles), los mensajes van por el servidor (roomSend / roomPoll
 *            de server/api.js): se juntan y se mandan cada 150 ms, y se
 *            recogen cuando G.Social pregunta por la sala. Más lento, pero funciona.
 *
 * Se envía por el canal directo si está abierto; si no, por el relé. El que
 * recibe escucha los dos, así que no hace falta ponerse de acuerdo.
 *
 * API:  open(roomId, isHost, hostUid) · close() · send(to, msg) · toHost(msg)
 *       broadcast(msg) · on(fn(from, msg)) · onPeer(fn(uid, state))
 *       peers() · mode(uid) -> 'connecting' | 'direct' | 'relay' | 'closed'
 */
G.Net = (() => {
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
               { urls: 'stun:stun.cloudflare.com:3478' }];
  const DIRECT_TIMEOUT = 9000;     // ms para conseguir canal directo antes de usar el relé

  const FLUSH = 150;               // ms: los mensajes por el relé se mandan juntos
  let uid = null, roomId = null, isHost = false, hostUid = null;
  let outbox = [], flushT = 0;
  const peers = new Map();         // uid -> { pc, dc, mode, timer }
  const handlers = new Set(), peerHandlers = new Set();
  let stats = { sent: 0, recv: 0, relaySent: 0 };

  function emitPeer(u) {
    const p = peers.get(u);
    peerHandlers.forEach(fn => { try { fn(u, p ? p.mode : 'closed'); } catch (e) { console.warn(e); } });
  }

  // ---------------- apertura ----------------

  function open(id, host, hostId) {
    if (roomId === id) return;
    close();
    uid = G.DB.uid;
    roomId = id; isHost = host; hostUid = hostId;
    // Invitado: hueco para el anfitrión desde ya (se sustituye al llegar su
    // oferta). Así, si no llega nunca, se sigue por el relé y se sabe cuándo se va.
    if (!isHost) {
      const p = { pc: null, dc: null, mode: 'connecting', timer: 0 };
      p.timer = setTimeout(() => { if (p.mode === 'connecting') { p.mode = 'relay'; emitPeer(hostId); } }, DIRECT_TIMEOUT + 3000);
      peers.set(hostId, p);
    }
  }

  function close() {
    for (const u of [...peers.keys()]) drop(u);
    clearTimeout(flushT); flushT = 0; outbox = [];
    roomId = null; isHost = false; hostUid = null;
  }

  /**
   * Mensajes que trae G.Social al preguntar por la sala ([{ id, f, b }]).
   * → false si no son de esta sala (no se dan por recibidos).
   */
  function receive(id, msgs) {
    if (!roomId || id !== roomId) return false;
    for (const raw of msgs) {
      let m;
      try { m = JSON.parse(raw.b); } catch (e) { continue; }
      if (!m) continue;
      if (m.sig) onSignal(raw.f, m.sig);
      else deliver(raw.f, m.d);
    }
    return true;
  }

  /** ¿Hace falta preguntar a menudo? (conectando o algún compañero por el relé) */
  function wantsFast() {
    for (const p of peers.values()) if (p.mode === 'connecting' || p.mode === 'relay') return true;
    return false;
  }

  /** El anfitrión llama a esto cuando cambian los miembros de la sala. */
  function syncMembers(uids) {
    if (!roomId) return;
    if (isHost) {
      for (const u of uids) if (u !== uid && !peers.has(u)) connect(u);
      for (const u of [...peers.keys()]) if (!uids.includes(u)) drop(u);
    } else if (!uids.includes(hostUid)) {
      drop(hostUid);
    }
  }

  // ---------------- WebRTC ----------------

  function newPeer(u) {
    const p = { pc: null, dc: null, mode: 'connecting', timer: 0 };
    peers.set(u, p);
    // Sin WebRTC (navegador antiguo o bloqueado): directamente por el relé.
    let pc;
    try { pc = p.pc = new RTCPeerConnection({ iceServers: ICE }); }
    catch (e) { p.mode = 'relay'; emitPeer(u); return p; }
    pc.onicecandidate = e => { if (e.candidate) signal(u, { c: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && p.mode !== 'closed') useRelay(u);
    };
    // Si en unos segundos no hay canal directo, se sigue por el relé.
    p.timer = setTimeout(() => { if (p.mode === 'connecting') useRelay(u); }, DIRECT_TIMEOUT);
    emitPeer(u);
    return p;
  }

  function wireChannel(u, p, dc) {
    p.dc = dc;
    dc.onopen = () => { clearTimeout(p.timer); p.mode = 'direct'; emitPeer(u); };
    dc.onclose = () => { if (p.mode === 'direct') { p.mode = 'relay'; emitPeer(u); } };
    dc.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      deliver(u, m);
    };
  }

  function useRelay(u) {
    const p = peers.get(u);
    if (!p || p.mode === 'direct' || p.mode === 'closed') return;
    p.mode = 'relay';
    emitPeer(u);
  }

  /** Anfitrión: abre conexión con un invitado. */
  async function connect(u) {
    const p = newPeer(u);
    if (!p.pc) return;
    wireChannel(u, p, p.pc.createDataChannel('g', { ordered: true }));
    try {
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      signal(u, { sdp: p.pc.localDescription.toJSON() });
    } catch (e) { useRelay(u); }
  }

  const pendingIce = new Map();     // candidatos que llegan antes que la oferta

  async function onSignal(from, sig) {
    let p = peers.get(from);
    try {
      if (sig.sdp && sig.sdp.type === 'offer') {
        if (isHost) return;
        if (p) drop(from, true);
        p = newPeer(from);
        if (!p.pc) return;
        p.pc.ondatachannel = e => wireChannel(from, p, e.channel);
        await p.pc.setRemoteDescription(sig.sdp);
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        signal(from, { sdp: p.pc.localDescription.toJSON() });
        for (const c of pendingIce.get(from) || []) await p.pc.addIceCandidate(c).catch(() => {});
        pendingIce.delete(from);
      } else if (sig.sdp && sig.sdp.type === 'answer') {
        if (p && p.pc) await p.pc.setRemoteDescription(sig.sdp);
      } else if (sig.c) {
        if (p && p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(sig.c).catch(() => {});
        else { if (!pendingIce.has(from)) pendingIce.set(from, []); pendingIce.get(from).push(sig.c); }
      }
    } catch (e) {
      console.warn('[Net] señalización:', e.message);
      useRelay(from);
    }
  }

  function signal(to, sig) {
    relayPush(to, { sig });
    if (G.Social.roomNudge) G.Social.roomNudge();       // la respuesta llega antes
  }

  function drop(u, silent) {
    const p = peers.get(u);
    if (!p) return;
    clearTimeout(p.timer);
    p.mode = 'closed';
    try { if (p.dc) p.dc.close(); } catch (e) { /* nada */ }
    try { if (p.pc) p.pc.close(); } catch (e) { /* nada */ }
    peers.delete(u);
    if (!silent) emitPeer(u);
  }

  // ---------------- envío / recepción ----------------

  function relayPush(to, env) {
    if (!roomId) return;
    outbox.push({ to, b: JSON.stringify(env) });
    if (!flushT) flushT = setTimeout(flush, FLUSH);
  }

  function flush() {
    flushT = 0;
    if (!roomId || !outbox.length) return;
    const msgs = outbox.splice(0, 200);
    G.DB.api('roomSend', { id: roomId, msgs }).catch(e => console.warn('[Net] relé:', e.code || e.message));
    if (outbox.length) flushT = setTimeout(flush, FLUSH);
  }

  function send(to, msg) {
    if (!roomId) return;
    const p = peers.get(to);
    stats.sent++;
    if (p && p.dc && p.dc.readyState === 'open') {
      try { p.dc.send(JSON.stringify(msg)); return; } catch (e) { /* cae al relé */ }
    }
    stats.relaySent++;
    relayPush(to, { d: msg });
  }

  function toHost(msg) { if (!isHost && hostUid) send(hostUid, msg); }
  function broadcast(msg, except) { for (const u of peers.keys()) if (u !== except) send(u, msg); }

  function deliver(from, msg) {
    stats.recv++;
    handlers.forEach(fn => { try { fn(from, msg); } catch (e) { console.error('[Net] mensaje:', e); } });
  }

  return {
    open, close, syncMembers, send, toHost, broadcast, receive, wantsFast,
    on(fn) { handlers.add(fn); }, off(fn) { handlers.delete(fn); },
    onPeer(fn) { peerHandlers.add(fn); },
    mode(u) { const p = peers.get(u); return p ? p.mode : 'closed'; },
    /** ¿Va por el relé? Entonces se manda menos a menudo. */
    slow(u) { const p = peers.get(u); return !p || p.mode !== 'direct'; },
    peers() { return [...peers.keys()]; },
    get open_() { return !!roomId; },
    get isHost() { return isHost; },
    get uid() { return uid; },
    get hostUid() { return hostUid; },
    stats
  };
})();
