# External MIDI Player

Browser-based MIDI playlist player: plays .mid files out to external MIDI hardware, and monitors that hardware's audio back into the computer. Static Vite + TypeScript app, no backend.

- Design (source of truth, requirements R1–R12): `docs/Browser MIDI Playlist Player — MVP Design.md`
- Tasks: `tasks/` — one file per milestone T1–T5, fixed schema. Read `tasks/README.md` first; build in order T1 → T5.

## Project
- Stack: TypeScript, Vite (static build), `@tonejs/midi` + `midi-file` (the two runtime dependencies), Web MIDI + Web Audio.
- Modules (one per architecture box, created in T1–T4): `src/midiDevices.ts`, `src/parser.ts`, `src/scheduler.ts`, `src/playlist.ts`, `src/audioMonitor.ts`, `src/ui.ts`.
- Tests: Vitest (unit), Playwright (e2e, Chromium + Firefox, mocked `requestMIDIAccess`/`getUserMedia`).
- Browsers: desktop Chrome/Edge and Firefox, current + previous releases. Must be served over HTTPS or `localhost` (secure context).

## Commands
- Dev server: `npm run dev` (use `localhost` — secure context for Web MIDI/getUserMedia)
- Unit tests: `npx vitest run`
- E2E: `npx playwright test`
- Full verify: `npx vitest run && npx playwright test && npx tsc --noEmit`

## Definition of Done
A task is complete when ALL pass:
1. `npx vitest run` exits 0
2. `npx playwright test` exits 0
3. `npx tsc --noEmit` exits 0
4. Every acceptance checkbox in the task's file (`tasks/T<n>-*.md`) is checked
5. Commit message: `type(scope): description`

## When Writing Code
- Scheduler: every `MIDIOutput.send()` gets a future timestamp; 25 ms tick, 200 ms look-ahead. No JS timers for note timing.
- Pause/stop: note-off every sounding note per channel plus CC64 = 0; send release messages just after the last queued event.
- Parsing: `parseMidi` from `midi-file` (the parser `@tonejs/midi` wraps — the high-level `Midi`/`Track` API loses per-event channels and channel pressure, and pairs notes in O(n²)), drop meta events other than tempo, keep original channels, duration = last event time.
- Audio monitor: starts muted; `echoCancellation`/`noiseSuppression`/`autoGainControl` all off.
- All user-visible status (device lost, file rejected) goes to the single `aria-live` region.

## Tools available for this project
- **VLM**: `http://montmartre.local:8080` — local llama.cpp server, OpenAI-compatible API. Model: `MiniCPM-o-4_5` (MiniCPM-o 4.5; vision — text + image in, text out). Use it for visual verification, e.g. judging a UI screenshot taken via the Chrome DevTools MCP:
  `curl http://montmartre.local:8080/v1/chat/completions -d '{"model":"MiniCPM-o-4_5","messages":[{"role":"user","content":[{"type":"text","text":"Describe this UI"},{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]}'`
- **Chrome DevTools MCP** (server `chrome-devtools`, global): drives a real Chrome — navigate, inspect DOM, evaluate JS, screenshots, console/network logs, performance traces. Use for browser verification of the app.

## Subagents
- Always run subagents serially — never in parallel. The coding model host bogs down under concurrent model requests; run one subagent at a time.

## Boundaries
- ✅ Always: serve over HTTPS/localhost; verify against the task's acceptance criteria; keep runtime dependencies to `@tonejs/midi` + `midi-file`
- ⚠️ Ask first: adding a runtime dependency, changing the module split, adding UI panels
- 🚫 Never: add a backend, schedule notes with JS timers, commit secrets
