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

function joinBase(socket) {
  const hostHeader = socket.handshake.headers.host || ('localhost:' + PORT);
  const [hostname, port] = hostHeader.split(':');
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const h = isLocal ? lanIP() : hostname;
  return 'http://' + h + (port ? ':' + port : '');
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
  socket.on('join_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('join_error', 'Room not found');
    if (room.started) return socket.emit('join_error', 'Game already started');
    let slot = null;
    if (!room.players.A) slot = 'A';
    else if (!room.players.B) slot = 'B';
    else return socket.emit('join_error', 'Room is full');

    room.players[slot] = socket.id;
    socket.data.code = code;
    socket.data.slot = slot;
    socket.join(code);
    socket.emit('joined', { slot, code });

    io.to(code).emit('player_joined', { slot, players: roomPresence(room) });
    if (room.hostSocketId) io.to(room.hostSocketId).emit('player_joined', { slot, players: roomPresence(room) });
    broadcastLobby(code);
  });

  // ── CONTROLLER: rejoin after reconnect ──
  socket.on('rejoin_game', ({ code, slot }) => {
    const room = rooms[code];
    if (!room || (slot !== 'A' && slot !== 'B')) return;
    room.players[slot] = socket.id;
    socket.data.code = code;
    socket.data.slot = slot;
    socket.join(code);
    socket.emit('joined', { slot, code });
    broadcastLobby(code);
    if (room.started) socket.emit('game_start');
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
