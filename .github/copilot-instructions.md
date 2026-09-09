# Bot Crossing development instructions

## Boundaries

- Keep the four layers separate: `server/harnesses/` is the session reader/adapter boundary;
  `server/scan.mjs` normalises and merges threads; `src/game/` maps threads to colony state;
  `src/` renders the world and HUD; `server/api.mjs` and `server/serve.mjs` are the thin server.
- Adding a harness should normally mean one adapter file plus its entry in
  `server/harnesses/index.mjs`. Do not make the scanner, API, or renderer know a harness's file
  format.

## Harness and persistence safety

- Read harness data by default. Validate opaque ids before path joins, URLs, or process actions;
  re-check folders are absolute existing directories; keep `ref` small, serialisable, and opaque.
- Pass opener commands as argument arrays, never shell strings. If archiving is supported, verify
  the record identity, change only the archive field, write through a sibling temporary file, and
  rename atomically. Tolerate malformed/in-progress records and bound transcript reads; cache
  parsed metadata by file mtime.
- The browser is the sole writer of `data/colony.json` and writes the whole state atomically.
  The server may touch only a harness's own archive flag. Reconcile archived intent on scans because
  a harness application can rewrite its records from memory.

## World and rendering invariants

- Layout is sticky: repository plots are keyed by stable project identity, retain their cells
  across polls and reloads, grow contiguously, and give back newest cells when they shrink.
- Keep one ordered thread-state function as the source for world and UI behaviour; errored,
  running, merged/finished, unread/waiting, stale, and ordinary states must not disagree.
- Preserve the crowd path: bake skeletal clips and attachment transforms into animation textures,
  skin in the vertex shader before `instanceMatrix`, and keep the crowd instanced rather than
  creating one CPU skeleton/draw per agent. Use atlas masks/instanced attributes for per-agent
  variation.
- Use PBR materials with the sky-derived IBL when enabled. Keep bloom selective, use real
  depth-buffer tilt-shift, sync post-processing depth to the current composer buffer, and dispose
  render targets when effects are disabled.
- Keep render scale separate from device pixel ratio. Adaptive quality may scale below the chosen
  preset gradually; do not make the buffer breathe every frame. Preserve the existing five presets,
  auto-quality behaviour, and camera-following shadow/focus assumptions.

## Code conventions

- This is a Node >=20, ESM JavaScript project built with Vite and three.js. Use `.js` for browser
  modules and `.mjs` for server modules, single quotes, no semicolons, and the existing named/default
  import style. Prefer small functions, stable ids, explicit data shapes, and existing helpers.
- Keep frame-loop code allocation-light: reuse scratch vectors/matrices and avoid per-frame DOM
  layout reads. Dispose geometries, materials, textures, and post-processing targets when rebuilding.
- Keep `.claude/` unchanged as the source/backward-compatible skill; Copilot-compatible guidance
  lives under `.github/`.

## Validation

- Install dependencies only when needed: `npm install`
- Build the app and assets: `npm run build`
- Run the asset packer alone: `npm run assets`
- Run the Vite development app/API: `npm run dev`
- Build then run the static server: `npm start`
- Run the static server against an existing `dist/`: `npm run serve`
- Syntax-check a harness adapter: `node --check server/harnesses/claude-code.mjs`
- With `npm run dev` running, inspect detected adapters with
  `curl -s http://localhost:5274/api/harnesses`. Launch metadata requests `npm run dev` with
  port `5274` and auto-port behaviour; Vite may choose another free port because `strictPort` is
  disabled or `PORT` is set.
- There is currently no repository test script. For changes affecting a harness, also exercise
  `/api/threads` and inspect representative scan data as described in
  `server/harnesses/README.md`.
