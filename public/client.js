const socket = io();

const $ = (sel) => document.querySelector(sel);
const screens = {
  entry: $("#screen-entry"),
  lobby: $("#screen-lobby"),
  picking: $("#screen-picking"),
  playing: $("#screen-playing"),
  reveal: $("#screen-reveal"),
  over: $("#screen-over"),
};

let state = null;
let myId = null;
let lastResults = null;
let timerInterval = null;
let liveAnswers = {}; // playerId -> { category: entry } for the current round

function show(name) {
  for (const k of Object.keys(screens)) {
    screens[k].classList.toggle("hidden", k !== name);
  }
}

function setError(msg) {
  $("#entry-err").textContent = msg || "";
}

function renderRoomPill() {
  const pill = $("#room-pill");
  if (!state) { pill.classList.add("hidden"); return; }
  pill.classList.remove("hidden");
  pill.textContent = `Room ${state.code} · Round ${state.roundNumber || 0}/${state.totalRounds}`;
}

function renderPlayers(targetEl, players, opts = {}) {
  targetEl.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot" + (p.connected ? "" : " off");
    li.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = p.name + (p.id === myId ? " (you)" : "");
    li.appendChild(name);
    if (p.isHost) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "HOST";
      li.appendChild(b);
    }
    if (opts.showScore) {
      const s = document.createElement("span");
      s.className = "muted";
      s.textContent = `· ${p.score} pts`;
      li.appendChild(s);
    }
    if (opts.showSubmitted && p.submitted) {
      const b = document.createElement("span");
      b.className = "badge";
      b.style.background = "var(--good)";
      b.textContent = "✓";
      li.appendChild(b);
    }
    targetEl.appendChild(li);
  }
}

function renderLobby() {
  $("#lobby-code").textContent = state.code;
  renderPlayers($("#lobby-players"), state.players);
  const isHost = state.hostId === myId;
  $("#btn-start").classList.toggle("hidden", !isHost);
  $("#lobby-info").textContent = isHost
    ? "When everyone is in, click Start. The first player picks the first letter."
    : "Waiting for host to start the game…";
}

function renderPicking() {
  $("#pick-round").textContent = state.roundNumber;
  $("#pick-total").textContent = state.totalRounds;
  const picker = state.players.find(p => p.id === state.pickerId);
  const isPicker = state.pickerId === myId;
  $("#pick-info").textContent = isPicker
    ? "Your turn — pick a letter."
    : `Waiting for ${picker?.name || "picker"} to choose a letter…`;
  const grid = $("#letter-grid");
  const randBtn = $("#btn-random");
  grid.classList.toggle("hidden", !isPicker);
  randBtn.classList.toggle("hidden", !isPicker);
  if (isPicker) {
    grid.innerHTML = "";
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(L => {
      const b = document.createElement("button");
      b.textContent = L;
      const used = state.usedLetters.includes(L);
      if (used) b.classList.add("used");
      b.disabled = used;
      b.addEventListener("click", () => pickLetter(L));
      grid.appendChild(b);
    });
  }
}

function renderPlaying() {
  $("#play-round").textContent = state.roundNumber;
  $("#play-total").textContent = state.totalRounds;
  $("#play-letter").textContent = state.currentLetter;
  const form = $("#play-form");
  if (!form.dataset.builtFor || form.dataset.builtFor !== `${state.code}-${state.roundNumber}`) {
    form.innerHTML = "";
    for (const cat of state.categories) {
      const label = document.createElement("label");
      label.textContent = cat;
      const input = document.createElement("input");
      input.name = cat;
      input.autocomplete = "off";
      input.placeholder = `${cat} starting with ${state.currentLetter}`;
      label.appendChild(input);
      form.appendChild(label);
    }
    form.dataset.builtFor = `${state.code}-${state.roundNumber}`;
    form.querySelector("input")?.focus();
  }
  // Submission status
  const me = state.players.find(p => p.id === myId);
  $("#btn-submit").disabled = !!me?.submitted;
  $("#play-status").textContent = me?.submitted
    ? "Submitted. Waiting for other players…"
    : "";
  renderLiveAnswers();
  // Timer
  if (state.timerEndsAt) startTimer(state.timerEndsAt);
}

function renderLiveAnswers() {
  const wrap = $("#live-answers");
  const submittedIds = state.players
    .filter(p => p.submitted)
    .map(p => p.id);
  if (submittedIds.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const table = $("#live-answers-table");
  table.innerHTML = "";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.appendChild(th("Category"));
  for (const pid of submittedIds) {
    const p = state.players.find(x => x.id === pid);
    if (!p) continue;
    hr.appendChild(th(p.name + (p.id === myId ? " (you)" : "")));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const cat of state.categories) {
    const tr = document.createElement("tr");
    tr.appendChild(td(cat, ""));
    for (const pid of submittedIds) {
      const entry = liveAnswers[pid]?.[cat];
      if (entry && entry.trim()) {
        tr.appendChild(td(entry, ""));
      } else {
        tr.appendChild(td("—", "pending"));
      }
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function startTimer(endsAt) {
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const el = $("#play-timer");
    el.textContent = remaining;
    el.classList.toggle("danger", remaining <= 10);
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function renderReveal() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  $("#reveal-letter").textContent = state.currentLetter;
  const table = $("#reveal-table");
  table.innerHTML = "";
  if (!lastResults) return;
  // Header
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.appendChild(th("Category"));
  for (const p of state.players) hr.appendChild(th(p.name + (p.id === myId ? " (you)" : "")));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const cat of state.categories) {
    const tr = document.createElement("tr");
    tr.appendChild(td(cat, ""));
    for (const p of state.players) {
      const cell = lastResults.byPlayer[p.id]?.[cat];
      const klass = cellClass(cell);
      const text = cellText(cell);
      const t = td(text, klass);
      if (cell && cell.points > 0) {
        const pts = document.createElement("span");
        pts.className = "pts";
        pts.textContent = `+${cell.points}`;
        t.appendChild(pts);
      }
      tr.appendChild(t);
    }
    tbody.appendChild(tr);
  }
  // Round total row
  const totalRow = document.createElement("tr");
  totalRow.appendChild(td("Round total", ""));
  for (const p of state.players) {
    totalRow.appendChild(td(String(lastResults.roundTotals[p.id] || 0), ""));
  }
  totalRow.style.fontWeight = "700";
  tbody.appendChild(totalRow);
  table.appendChild(tbody);

  // Standings
  const standings = [...state.players].sort((a, b) => b.score - a.score);
  const list = $("#reveal-standings");
  list.innerHTML = "";
  for (const p of standings) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${p.name}${p.id === myId ? " (you)" : ""}</span><span>${p.score} pts</span>`;
    list.appendChild(li);
  }
  const isHost = state.hostId === myId;
  $("#btn-next").classList.toggle("hidden", !isHost);
  $("#reveal-info").textContent = isHost
    ? "Click Next round when ready."
    : "Waiting for host to start the next round…";
}

function cellClass(cell) {
  if (!cell) return "cell-empty";
  if (cell.status === "empty") return "cell-empty";
  if (cell.status === "invalid" || cell.status === "wrong-letter") return "cell-bad";
  if (cell.duplicate) return "cell-dup";
  return "cell-valid";
}
function cellText(cell) {
  if (!cell || cell.status === "empty") return "—";
  if (cell.status === "wrong-letter") return `${cell.entry} (wrong letter)`;
  if (cell.status === "invalid") return `${cell.entry} (rejected)`;
  return cell.entry;
}
function th(text) { const e = document.createElement("th"); e.textContent = text; return e; }
function td(text, klass) {
  const e = document.createElement("td");
  e.textContent = text;
  if (klass) e.className = klass;
  return e;
}

function renderOver(standings) {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const ol = $("#over-standings");
  ol.innerHTML = "";
  standings.forEach((p, idx) => {
    const li = document.createElement("li");
    const medal = ["🥇", "🥈", "🥉"][idx] || `${idx + 1}.`;
    li.innerHTML = `<span>${medal} ${p.name}${p.id === myId ? " (you)" : ""}</span><span>${p.score} pts</span>`;
    ol.appendChild(li);
  });
  $("#btn-again").classList.toggle("hidden", state.hostId !== myId);
}

function render() {
  renderRoomPill();
  if (!state) { show("entry"); return; }
  switch (state.phase) {
    case "lobby": renderLobby(); show("lobby"); break;
    case "picking": renderPicking(); show("picking"); break;
    case "playing": renderPlaying(); show("playing"); break;
    case "reveal": renderReveal(); show("reveal"); break;
    case "finished": show("over"); break;
  }
}

// ---------- Actions ----------

function pickLetter(L) {
  socket.emit("round:pickLetter", { letter: L }, (resp) => {
    if (!resp?.ok) alert(resp?.error || "Could not pick letter");
  });
}

$("#btn-create").addEventListener("click", () => {
  setError("");
  const name = $("#entry-name").value.trim();
  if (!name) return setError("Enter your name.");
  const rounds = parseInt($("#entry-rounds").value, 10);
  socket.emit("room:create", { name, rounds }, (resp) => {
    if (!resp?.ok) return setError(resp?.error || "Failed to create");
    myId = resp.you;
  });
});

$("#btn-join").addEventListener("click", () => {
  setError("");
  const name = $("#entry-name").value.trim();
  const code = $("#entry-code").value.trim().toUpperCase();
  if (!name) return setError("Enter your name.");
  if (!code) return setError("Enter a room code.");
  socket.emit("room:join", { name, code }, (resp) => {
    if (!resp?.ok) return setError(resp?.error || "Failed to join");
    myId = resp.you;
  });
});

$("#btn-start").addEventListener("click", () => {
  socket.emit("room:startGame", {}, (resp) => {
    if (!resp?.ok) alert(resp?.error || "Could not start");
  });
});

$("#btn-random").addEventListener("click", () => {
  socket.emit("round:randomLetter", {}, (resp) => {
    if (!resp?.ok) alert(resp?.error || "Could not pick letter");
  });
});

$("#btn-submit").addEventListener("click", () => {
  const form = $("#play-form");
  const answers = {};
  form.querySelectorAll("input").forEach(i => { answers[i.name] = i.value; });
  socket.emit("round:submit", { answers }, (resp) => {
    if (!resp?.ok) alert(resp?.error || "Could not submit");
  });
});

$("#btn-next").addEventListener("click", () => {
  socket.emit("round:next", {}, (resp) => {
    if (!resp?.ok) alert(resp?.error || "Could not advance");
  });
});

$("#btn-again").addEventListener("click", () => {
  socket.emit("game:playAgain", {}, (resp) => {
    if (!resp?.ok) alert(resp?.error || "Could not restart");
  });
});

// ---------- Socket events ----------

socket.on("room:state", (s) => {
  state = s;
  render();
});

socket.on("room:roundStart", () => {
  // Force form rebuild for new round
  $("#play-form").dataset.builtFor = "";
  liveAnswers = {};
});

socket.on("round:peerSubmission", ({ playerId, answers }) => {
  liveAnswers[playerId] = answers;
  if (state && state.phase === "playing") renderLiveAnswers();
});

socket.on("room:reveal", ({ results }) => {
  lastResults = results;
  // state will be updated by room:state event that follows
});

socket.on("room:gameOver", ({ standings }) => {
  renderOver(standings);
});

socket.on("disconnect", () => {
  // Just show the entry screen if connection lost
});
