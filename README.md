# Letter Game

A real-time multiplayer web game inspired by *Name, Place, Animal, Thing*. One player picks a letter; everyone races to fill in eight categories starting with that letter. Unique valid answers score 10 points, duplicates score 5, and anything that doesn't actually belong to the category (or starts with the wrong letter) scores 0.

## Categories
Name · Country · Flower · Fruit · Tree · Fish · Animal · Bird

## Scoring
- **10 points** — unique, valid answer that starts with the round's letter
- **5 points**  — valid answer that another player also wrote (duplicate)
- **0 points**  — empty, wrong letter, or not recognized as a member of the category

Validation is done against curated wordlists in [`data/wordlists.js`](data/wordlists.js). Expand them if you want more lenient acceptance.

## Features
- Room-code based join (no accounts, no passwords)
- 60-second round timer (round ends early if everyone submits)
- Letter picker rotates each round; can pick from grid or hit "random"
- Configurable round count (3 / 5 / 7 / 10)
- Per-round reveal table with color coding and a running leaderboard
- Final standings + "play again"
- Handles disconnects mid-game (player stays on the board, picker rotates past them)

## Run locally
Requires Node.js 18+.

```powershell
cd F:\OneDrive\Desktop\letter-game
npm install
npm start
```

Open http://localhost:3000 — for a multiplayer test, open the URL in a second tab/window/device and use the same room code.

To play with friends on the same Wi-Fi, share `http://<your-LAN-ip>:3000`.

## Deploy to a free host

The app is a plain Node + Express + Socket.IO server. It reads `process.env.PORT`, so it works on Render, Railway, Fly.io, etc., with no changes.

### Render (simplest)
1. Push this folder to a new GitHub repo.
2. On Render: **New → Web Service**, pick the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Instance: free tier is fine.
6. Open the assigned `https://<name>.onrender.com` URL — that's your game.

### Railway / Fly.io
Same idea — they auto-detect Node, run `npm install` and `npm start`. No extra config needed.

## Tech stack
- **Backend:** Node, Express, Socket.IO
- **Frontend:** vanilla HTML / CSS / JS — no framework, no build step
- **State:** in-memory room map on the server (a restart wipes active rooms; fine for a party game)

## Project layout
```
letter-game/
  server.js              # Express + Socket.IO server, rooms, scoring
  data/wordlists.js      # Curated lists for each category + validation
  public/
    index.html           # Single-page UI
    style.css
    client.js            # Socket.IO client, renders all screens
  package.json
  .claude/launch.json    # Used by Claude Code preview only
```

## Future ideas
- Allow players to challenge/vote on borderline answers after reveal
- Add stats / persistent scoreboards (would need a real DB + accounts)
- More categories, or let the host pick which 8 to use
- Custom letter pools (vowels only, hard mode, etc.)
