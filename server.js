const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { CATEGORIES, isValidForCategory, startsWithLetter, normalize } = require("./data/wordlists");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---------- Game state ----------

const ROUND_SECONDS = 60;
const DEFAULT_ROUNDS = 5;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
// Letters that are workable across all 8 categories. Avoids dead letters like X, Z.
const PLAYABLE_LETTERS = "ABCDEFGHIJKLMNOPRSTW".split("");

/** rooms: code -> Room */
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  return {
    code,
    players: [], // { id, name, score, connected }
    hostId: null,
    phase: "lobby", // lobby | picking | playing | reveal | finished
    roundNumber: 0,
    totalRounds: DEFAULT_ROUNDS,
    pickerIndex: 0,
    currentLetter: null,
    usedLetters: new Set(),
    submissions: {}, // playerId -> { category: entry }
    roundResults: null, // built during reveal
    timer: null,
    timerEndsAt: null,
  };
}

function publicRoomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      isHost: p.id === room.hostId,
      submitted: !!room.submissions[p.id],
    })),
    hostId: room.hostId,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    currentLetter: room.currentLetter,
    pickerId: room.players[room.pickerIndex]?.id || null,
    usedLetters: Array.from(room.usedLetters),
    timerEndsAt: room.timerEndsAt,
    categories: CATEGORIES,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:state", publicRoomState(room));
}

function scoreRound(room) {
  // For each category, find all entries across players, normalize, then:
  // - Empty / invalid (wrong category OR wrong letter) -> 0
  // - Otherwise compare normalized strings; duplicates -> 5, unique -> 10
  const results = {}; // playerId -> { category: {entry, points, status} }
  for (const p of room.players) results[p.id] = {};

  for (const category of CATEGORIES) {
    const entries = room.players.map(p => {
      const raw = room.submissions[p.id]?.[category] || "";
      const norm = normalize(raw);
      let status = "valid";
      if (!norm) status = "empty";
      else if (!startsWithLetter(norm, room.currentLetter)) status = "wrong-letter";
      else if (!isValidForCategory(norm, category)) status = "invalid";
      return { playerId: p.id, raw, norm, status };
    });

    // count how many times each normalized valid entry appears
    const counts = {};
    for (const e of entries) {
      if (e.status === "valid") counts[e.norm] = (counts[e.norm] || 0) + 1;
    }

    for (const e of entries) {
      let points = 0;
      if (e.status === "valid") points = counts[e.norm] > 1 ? 5 : 10;
      results[e.playerId][category] = {
        entry: e.raw,
        points,
        status: e.status,
        duplicate: e.status === "valid" && counts[e.norm] > 1,
      };
    }
  }

  // Apply to scores
  let perPlayerTotals = {};
  for (const p of room.players) {
    let total = 0;
    for (const c of CATEGORIES) total += results[p.id][c].points;
    perPlayerTotals[p.id] = total;
    p.score += total;
  }

  return { byPlayer: results, roundTotals: perPlayerTotals };
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.timerEndsAt = null;
}

function endRound(room) {
  if (room.phase !== "playing") return;
  clearTimer(room);
  room.roundResults = scoreRound(room);
  room.phase = "reveal";
  io.to(room.code).emit("room:reveal", {
    letter: room.currentLetter,
    results: room.roundResults,
    state: publicRoomState(room),
  });
  broadcastRoom(room);
}

function startRound(room, letter) {
  room.currentLetter = letter.toUpperCase();
  room.usedLetters.add(room.currentLetter);
  room.submissions = {};
  room.phase = "playing";
  room.timerEndsAt = Date.now() + ROUND_SECONDS * 1000;
  clearTimer(room);
  room.timer = setTimeout(() => endRound(room), ROUND_SECONDS * 1000);
  io.to(room.code).emit("room:roundStart", {
    letter: room.currentLetter,
    endsAt: room.timerEndsAt,
    roundNumber: room.roundNumber,
  });
  broadcastRoom(room);
}

function nextRound(room) {
  if (room.roundNumber >= room.totalRounds) {
    finishGame(room);
    return;
  }
  room.roundNumber += 1;
  room.phase = "picking";
  room.currentLetter = null;
  room.submissions = {};
  // Advance picker (rotating)
  if (room.players.length > 0) {
    room.pickerIndex = (room.pickerIndex + 1) % room.players.length;
  }
  broadcastRoom(room);
}

function finishGame(room) {
  room.phase = "finished";
  clearTimer(room);
  io.to(room.code).emit("room:gameOver", {
    standings: [...room.players].sort((a, b) => b.score - a.score).map(p => ({
      id: p.id, name: p.name, score: p.score,
    })),
  });
  broadcastRoom(room);
}

function resetRoomForNewGame(room) {
  for (const p of room.players) p.score = 0;
  room.phase = "lobby";
  room.roundNumber = 0;
  room.currentLetter = null;
  room.usedLetters = new Set();
  room.submissions = {};
  room.roundResults = null;
  room.pickerIndex = 0;
  clearTimer(room);
}

// ---------- Socket handlers ----------

io.on("connection", (socket) => {
  let currentRoomCode = null;

  socket.on("room:create", ({ name, rounds }, cb) => {
    const playerName = (name || "Player").toString().slice(0, 20).trim() || "Player";
    const code = makeRoomCode();
    const room = createRoom(code);
    const totalRounds = Math.max(1, Math.min(20, parseInt(rounds, 10) || DEFAULT_ROUNDS));
    room.totalRounds = totalRounds;
    room.players.push({ id: socket.id, name: playerName, score: 0, connected: true });
    room.hostId = socket.id;
    rooms.set(code, room);
    socket.join(code);
    currentRoomCode = code;
    cb && cb({ ok: true, code, you: socket.id });
    broadcastRoom(room);
  });

  socket.on("room:join", ({ name, code }, cb) => {
    const playerName = (name || "Player").toString().slice(0, 20).trim() || "Player";
    const roomCode = (code || "").toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return cb && cb({ ok: false, error: "Room not found" });
    if (room.phase !== "lobby") return cb && cb({ ok: false, error: "Game already in progress" });
    if (room.players.length >= 12) return cb && cb({ ok: false, error: "Room is full" });
    room.players.push({ id: socket.id, name: playerName, score: 0, connected: true });
    socket.join(roomCode);
    currentRoomCode = roomCode;
    cb && cb({ ok: true, code: roomCode, you: socket.id });
    broadcastRoom(room);
  });

  socket.on("room:startGame", (_, cb) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return cb && cb({ ok: false, error: "No room" });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, error: "Only host can start" });
    if (room.players.length < 1) return cb && cb({ ok: false, error: "Need at least 1 player" });
    resetRoomForNewGame(room);
    room.roundNumber = 1;
    room.phase = "picking";
    room.pickerIndex = 0;
    broadcastRoom(room);
    cb && cb({ ok: true });
  });

  socket.on("round:pickLetter", ({ letter }, cb) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return cb && cb({ ok: false, error: "No room" });
    if (room.phase !== "picking") return cb && cb({ ok: false, error: "Not picking phase" });
    const pickerId = room.players[room.pickerIndex]?.id;
    if (socket.id !== pickerId) return cb && cb({ ok: false, error: "Not your turn to pick" });
    const L = (letter || "").toString().toUpperCase();
    if (!ALPHABET.includes(L)) return cb && cb({ ok: false, error: "Invalid letter" });
    if (room.usedLetters.has(L)) return cb && cb({ ok: false, error: "Letter already used" });
    startRound(room, L);
    cb && cb({ ok: true });
  });

  socket.on("round:randomLetter", (_, cb) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return cb && cb({ ok: false, error: "No room" });
    if (room.phase !== "picking") return cb && cb({ ok: false, error: "Not picking phase" });
    const pickerId = room.players[room.pickerIndex]?.id;
    if (socket.id !== pickerId) return cb && cb({ ok: false, error: "Not your turn to pick" });
    const remaining = PLAYABLE_LETTERS.filter(l => !room.usedLetters.has(l));
    const pool = remaining.length ? remaining : ALPHABET.filter(l => !room.usedLetters.has(l));
    if (!pool.length) return cb && cb({ ok: false, error: "No letters left" });
    const L = pool[Math.floor(Math.random() * pool.length)];
    startRound(room, L);
    cb && cb({ ok: true, letter: L });
  });

  socket.on("round:submit", ({ answers }, cb) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return cb && cb({ ok: false, error: "No room" });
    if (room.phase !== "playing") return cb && cb({ ok: false, error: "Not playing phase" });
    const clean = {};
    for (const c of CATEGORIES) {
      clean[c] = (answers?.[c] || "").toString().slice(0, 40);
    }
    room.submissions[socket.id] = clean;
    // Broadcast this player's raw answers to everyone in the room so they can
    // see them live as soon as a player submits.
    io.to(room.code).emit("round:peerSubmission", {
      playerId: socket.id,
      answers: clean,
    });
    broadcastRoom(room);
    // If all connected players submitted, end early
    const connected = room.players.filter(p => p.connected);
    const allIn = connected.every(p => room.submissions[p.id]);
    if (allIn) endRound(room);
    cb && cb({ ok: true });
  });

  socket.on("round:next", (_, cb) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return cb && cb({ ok: false, error: "No room" });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, error: "Only host can advance" });
    if (room.phase !== "reveal") return cb && cb({ ok: false, error: "Not reveal phase" });
    nextRound(room);
    cb && cb({ ok: true });
  });

  socket.on("game:playAgain", (_, cb) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return cb && cb({ ok: false, error: "No room" });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, error: "Only host" });
    if (room.phase !== "finished") return cb && cb({ ok: false, error: "Game not finished" });
    resetRoomForNewGame(room);
    broadcastRoom(room);
    cb && cb({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    // If still in lobby, remove them entirely; otherwise mark disconnected so scores stay.
    if (room.phase === "lobby") {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.hostId === socket.id) {
        room.hostId = room.players[0]?.id || null;
      }
      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }
    } else {
      player.connected = false;
      // If host left mid-game, hand host to first connected player
      if (room.hostId === socket.id) {
        const next = room.players.find(p => p.connected);
        room.hostId = next ? next.id : room.players[0].id;
      }
      // If picker left, advance picker
      if (room.players[room.pickerIndex]?.id === socket.id && room.phase === "picking") {
        let attempts = 0;
        do {
          room.pickerIndex = (room.pickerIndex + 1) % room.players.length;
          attempts++;
        } while (!room.players[room.pickerIndex].connected && attempts < room.players.length);
      }
      // If everyone connected has submitted, end the round
      if (room.phase === "playing") {
        const connected = room.players.filter(p => p.connected);
        if (connected.length && connected.every(p => room.submissions[p.id])) {
          endRound(room);
        }
      }
    }
    broadcastRoom(room);
  });
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Letter Game server listening on ${HOST}:${PORT}`);
});
