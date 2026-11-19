# T22: Faceplate and Info panel polish

- **ID**: T22
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.25 day
- **Depends on**: T7 (built-in synth output), T11 (faceplate and Quick start), T20 (metadata viewer)
- **Modules**: `src/synthOutput.ts` (output name), `src/ui.ts` (labels, status lines, Info key, Info panel), `src/styles.css` (one-line status, transport block, Info panel footer), `tests/unit/synthOutput.test.ts`, `tests/e2e/*.spec.ts` (labels, tab order, new Info key and status checks), `README.md`
- **Requirements**: R3, R13 (presentation only; no new R-ID)

## Objective

A batch of small presentation changes: clearer naming for the built-in synth, a one-line LCD status line, a front-panel Info key that opens the playing song's metadata, and a renamed, credited Info panel (formerly Quick start) with a link to the repository.

## Scope

- **Output name.** The MIDI output picker lists the built-in synth as "SpessaSynth (built-in)" (`SYNTH_OUTPUT_NAME`); its ready line reads "SpessaSynth ready."
- **One-line status.** The LCD status line never wraps: `white-space: nowrap`, hidden overflow and a text ellipsis, with the full message kept in the element's `title` so a truncated line can still be read on hover. The Connect devices result is shortened to fit one line, for example "Connected. Microphone access granted." The status region stays the single `aria-live` region and still receives the full text.
- **Info key.** A rubber key labelled "Info" sits right of Connect devices; its right edge lines up with the Panic key's right edge (the keypad and the connect row share one shrink-to-fit transport block). It opens the T20 metadata dialog for the current song while one is playing or paused, and does nothing otherwise.
- **Info panel.** The Quick start heading becomes "Info" (toggle "Hide info" / "Show info"; test IDs and the stored show/hide key are unchanged). The shortcuts line uses the panel's 14 px body size. A "Player by Trevor Wilson" line sits above the LCD font credit. A GitHub icon link to https://github.com/wilsontr/external-midi-player sits in the panel's lower-right corner, with an accessible name and a new tab target.
- **Tests and docs.** Update label, tab-order and status assertions; add e2e coverage for the Info key, the GitHub link and the one-line status. Update README notes.

## Acceptance criteria

- [x] The MIDI output picker shows "SpessaSynth (built-in)" and selecting it still loads and plays through the built-in synth.
- [x] The LCD status line stays on one line and ellipsizes a long message; the full message is in its `title`; Connect devices reports "Connected. Microphone access granted." when both are granted.
- [x] An "Info" key sits to the right of Connect devices with its right edge aligned to Panic's right edge.
- [x] Info opens the metadata dialog for the playing (or paused) song and does nothing when nothing is playing.
- [x] The panel heading reads "Info", its toggle reads "Hide info"/"Show info", and the shortcuts line is the same size as the rest of the panel text.
- [x] "Player by Trevor Wilson" appears above the LCD font credit.
- [x] A GitHub icon in the panel's lower-right corner links to https://github.com/wilsontr/external-midi-player.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- The Info key is a no-op rather than disabled when nothing is playing, as requested; it stays reachable by keyboard after Connect devices.
- The GitHub link adds one tab stop to the Info panel, after the font-credit links.
