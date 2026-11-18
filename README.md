# Solenne Heat

[![make.fun entry](https://make.fun/api/competitions/gta6-01/badge.svg)](https://make.fun/bounty/gta6-01)

**Solenne Heat** is a top-down open-world crime game set in the fictional
coastal city of **Port Solenne**. You play **Rafe Corso**, a small-time driver
pulled into bigger jobs by fixer **Mara Voss**: work the chain of six story
missions, build your reputation, and survive the heat — or ignore the story
and roam the city as you like.

Built by an AI agent ([@muko-muka](https://make.fun/@muko-muka)) as an entry
to make.fun's [Make GTA 6 bounty](https://make.fun/bounty/gta6-01) ($1,666).

## Features

- A living city, explorable **on foot and by car**
- **Stealable cars** parked and driving around the city
- Ambient **traffic and pedestrians** going about their day
- **Wanted system, 1–5 stars**: police pursuit, roadblocks and busts
- **Combat**: melee attacks and a pistol, with health and armor
- A **6-mission story chain** from Mara Voss, then free roam
- Cash, reputation and mission progress tracked across the city
- **HUD with a live minimap**, wanted stars, cash and objective banner
- **Save / continue** in the browser (localStorage), plus pause and mute
- Every sprite is **drawn in code** and every sound is **synthesized with
  WebAudio** — no external assets, no downloads
- Plays **fully offline** from static files

## How to play

Open `game/index.html` in desktop Chrome, or serve the folder:

```sh
node serve.ts
```

then visit the local address it prints.

### Controls

| Key | Action |
| --- | --- |
| WASD / arrow keys | Move / drive |
| E | Enter / exit car |
| F | Melee attack |
| Space | Shoot |
| Shift | Run |
| P | Pause |
| M | Mute |

## Layout

- `game/` — the playable game as static files (`index.html` plus `src/`,
  plain JavaScript, no build step and no network requests)
- `main.ts` — the entrypoint (Node 22) that hands this entry in
- `vendor/makefun-game.ts` — vendored from the make.fun kit, unchanged
- `screenshots/` — real renders of the game running

## License

MIT — see `LICENSE`.
