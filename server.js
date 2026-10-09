// ═══════════════════════════════════════════════════════
//  TANK WAR — SERVER
//  Express + Socket.io: room codes, lobby, input relay
// ═══════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── LAN address, so the QR code works from phones even when the host
//    screen itself was opened as http://localhost ──
function lanIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) candidates.push(n.address);
    }
  }
  // prefer typical home/office ranges
  return (
    candidates.find(a => a.startsWith('192.168.')) ||
    candidates.find(a => a.startsWith('10.')) ||
    candidates.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
    candidates[0] ||
    'localhost'
  );
}

// Public address of this game, e.g. https://sharedcouch.online/mathduel
// (the Shared Couch front door sends X-Forwarded-Proto / -Host / -Prefix).
function publicPrefix(h) {
  return String(h['x-forwarded-prefix'] || '').split(',')[0].trim().replace(/\/+$/, '');
}
function publicProto(h) {
  return String(h['x-forwarded-proto'] || 'http').split(',')[0].trim();
}
function joinBase(socket) {
  const hdr = socket.handshake.headers;
  const hostHeader = String(hdr['x-forwarded-host'] || hdr.host || ('localhost:' + PORT)).split(',')[0].trim();
  const [hostname, port] = hostHeader.split(':');
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const h = isLocal ? lanIP() : hostname;
  if (isLocal) return 'http://' + h + (port ? ':' + port : '');
  return publicProto(hdr) + '://' + hostHeader + publicPrefix(hdr);
}

// ── ROOM STATE ──
// rooms[code] = { hostSocketId, players:{A,B}, ready:{A,B}, started }
const rooms = {};

function genCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms[code]);
  return code;
}

function roomPresence(room) {
  return { A: !!room.players.A, B: !!room.players.B };
}

function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  const p = roomPresence(room);
  const payload = { event: 'lobby_ready_update', data: { A: p.A, B: p.B, readyA: room.ready.A, readyB: room.ready.B } };
  if (room.hostSocketId) io.to(room.hostSocketId).emit('game_event', payload);
  if (room.players.A) io.to(room.players.A).emit('game_event', payload);
  if (room.players.B) io.to(room.players.B).emit('game_event', payload);
}

io.on('connection', (socket) => {

  // ── HOST: create a new game ──
  socket.on('create_game', async () => {
    const code = genCode();
    rooms[code] = {
      hostSocketId: socket.id,
      players: { A: null, B: null },
      ready: { A: false, B: false },
      clientIds: { A: null, B: null },   // one id per phone (stored in its browser)
      started: false
    };
    socket.data.hostCode = code;

    const joinUrl = joinBase(socket) + '/controller.html?code=' + code;
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(joinUrl, {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M',
        color: { dark: '#1b1b1a', light: '#00000000' }
      });
    } catch (e) { /* host falls back to showing the link */ }

    socket.emit('game_created', { code, joinUrl, qrSvg });
  });

  // ── CONTROLLER: join a game by code ──
  // A phone is identified by clientId (saved in its browser), so the same phone
  // opening the link twice — QR-scanner preview + Chrome, a second tab, a reload —
  // keeps ONE slot instead of taking both.
  function bindSlot(room, code, slot, cid) {
    const old = room.players[slot];
    if (old && old !== socket.id) {
      const os = io.sockets.sockets.get(old);
      if (os) { os.data.slot = null; os.data.code = null; os.leave(code); os.emit('replaced'); }
    }
    // a socket can only ever hold one slot
    for (const s of ['A', 'B']) if (s !== slot && room.players[s] === socket.id) { room.players[s] = null; room.ready[s] = false; room.clientIds[s] = null; }
    room.players[slot] = socket.id;
    if (cid) room.clientIds[slot] = cid;
    socket.data.code = code;
    socket.data.slot = slot;
    socket.join(code);
    socket.emit('joined', { slot, code });
    if (room.started) socket.emit('game_start');
    io.to(code).emit('player_joined', { slot, players: roomPresence(room) });
    if (room.hostSocketId) io.to(room.hostSocketId).emit('player_joined', { slot, players: roomPresence(room) });
    broadcastLobby(code);
  }
  const cleanId = (id) => (typeof id === 'string' && /^[\w-]{8,64}$/.test(id)) ? id : null;

  socket.on('join_game', ({ code, clientId } = {}) => {
    const room = rooms[code];
    if (!room) return socket.emit('join_error', 'Room not found');
    const cid = cleanId(clientId);
    const ua = (socket.handshake.headers['user-agent'] || '').slice(0, 90);

    // same socket asking again → same slot
    if (socket.data.code === code && socket.data.slot && room.players[socket.data.slot] === socket.id) {
      return socket.emit('joined', { slot: socket.data.slot, code });
    }
    // same phone already holds a slot → take it over
    const mine = cid && ['A', 'B'].find(s => room.clientIds[s] === cid);
    if (mine) {
      console.log(`[${code}] phone re-opened → keeps slot ${mine}  (${ua})`);
      return bindSlot(room, code, mine, cid);
    }
    if (room.started) return socket.emit('join_error', 'Game already started');
    const slot = !room.players.A ? 'A' : !room.players.B ? 'B' : null;
    if (!slot) return socket.emit('join_error', 'Room is full');
    console.log(`[${code}] new phone → slot ${slot}  (${ua})`);
    bindSlot(room, code, slot, cid);
  });

  // ── CONTROLLER: rejoin after a dropped connection ──
  socket.on('rejoin_game', ({ code, slot, clientId } = {}) => {
    const room = rooms[code];
    if (!room || (slot !== 'A' && slot !== 'B')) return;
    const cid = cleanId(clientId);
    // only take the slot back if it's free or it was ours — never steal another phone's slot
    if (room.players[slot] && room.players[slot] !== socket.id && room.clientIds[slot] !== cid) {
      return socket.emit('join_error', 'Your slot was taken');
    }
    bindSlot(room, code, slot, cid);
  });

  // ── CONTROLLER: ready up ──
  socket.on('player_ready', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const slot = socket.data.slot;
    if (!slot) return;
    room.ready[slot] = true;
    broadcastLobby(code);

    if (room.ready.A && room.ready.B && room.players.A && room.players.B && !room.started) {
      room.started = true;
      io.to(code).emit('game_start');
      if (room.hostSocketId) io.to(room.hostSocketId).emit('game_start');
    }
  });

  // ── CONTROLLER: directional input ──
  socket.on('ctrl_input', ({ code, slot, dir, pressed }) => {
    const room = rooms[code];
    if (!room || !room.hostSocketId) return;
    io.to(room.hostSocketId).emit('ctrl_input', { slot, dir, pressed });
  });

  // ── CONTROLLER: fire ──
  socket.on('ctrl_fire', ({ code, slot }) => {
    const room = rooms[code];
    if (!room || !room.hostSocketId) return;
    io.to(room.hostSocketId).emit('ctrl_fire', { slot });
  });

  // ── HOST: on-screen menu state (so phones can show "◀ ▶ choose · FIRE select") ──
  socket.on('host_ui', (ui) => {
    const code = socket.data.hostCode;
    if (!code || !rooms[code]) return;
    io.to(code).emit('host_ui', ui);
  });

  // ── HOST: leave the match and go back to the lobby (players stay connected) ──
  socket.on('host_back_to_lobby', () => {
    const code = socket.data.hostCode;
    const room = rooms[code];
    if (!room) return;
    room.started = false;
    room.ready = { A: false, B: false };
    io.to(code).emit('back_to_lobby');
    broadcastLobby(code);
  });

  // ── Latency diagnostic ──
  socket.on('ping_check', (cb) => { if (typeof cb === 'function') cb(); });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const { code, slot, hostCode } = socket.data;

    if (hostCode && rooms[hostCode]) {
      const room = rooms[hostCode];
      if (room.players.A) io.to(room.players.A).emit('host_disconnected');
      if (room.players.B) io.to(room.players.B).emit('host_disconnected');
      delete rooms[hostCode];
    }

    if (code && slot && rooms[code]) {
      const room = rooms[code];
      // only clear if this socket still owns the slot (avoids racing a reconnect)
      if (room.players[slot] === socket.id) {
        room.players[slot] = null;
        room.ready[slot] = false;
        // mid-match, remember the phone so it can come back to its tank after a reload
        if (!room.started) room.clientIds[slot] = null;
        if (room.hostSocketId) io.to(room.hostSocketId).emit('player_left', { slot });
        io.to(code).emit('player_left', { slot });
        broadcastLobby(code);
      }
    }
  });
});

server.listen(PORT, () => {
  const ip = lanIP();
  console.log(`TANK WAR server running`);
  console.log(`  Host screen:  http://localhost:${PORT}/   (or http://${ip}:${PORT}/)`);
  console.log(`  Phones join by scanning the QR code on the host screen.`);
});
