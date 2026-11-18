# T12: First-run sample song

- **ID**: T12
- **Milestone**: After the MVP
- **Status**: pending
- **Estimate**: 0.25–0.5 day
- **Depends on**: T3, T5
- **Modules**: `src/assets/debussy-poissons-dor.mid` (new asset), `src/playlist.ts` (fresh-store detection, seed), `src/ui.ts` (startup fetch and wiring), unit and e2e tests, `README.md`
- **Requirements**: R3, R13 (no new R-ID; a seeded playlist row that is persisted like any other)

## Objective

On a browser profile whose playlist store has never been written, start with the bundled sample `Debussy - Poissons d'or` in the playlist so the transport, LCD and part map have something to play before the user has selected any files. It follows T10 because it reuses the ordinary add/persist path and must not disturb Load files, Clear playlist or M3U semantics.

## Scope

**Bundled asset**

- Copy `tmp/debussy - poissons d'or.mid` to `src/assets/debussy-poissons-dor.mid` (30,352 bytes; SMF format 1, 570 PPQ, 3 tracks, 3:19, channels 2–3, 3,151 notes, 33 tempo changes, no SysEx) and import it with Vite's `?url` suffix: `import sampleSongUrl from './assets/debussy-poissons-dor.mid?url'`. The emitted URL is base-aware and content-hashed, so it survives the relative base T6 plans for GitHub Pages. A file in `public/` plus a hard-coded `/debussy-poissons-dor.mid` would 404 under a project-page subpath. Seed it as `new File([bytes], "Debussy - Poissons d'or.mid", { type: 'audio/midi' })`, so the row reads `Debussy - Poissons d'or`; the asset file name and the seeded display name are deliberately different (URL-safe vs. readable).
- The asset is served from the app's own origin, so the T5 CSP (`connect-src 'self'`) needs no change and no new network origin is contacted. No new runtime dependency and no new module.
- Record the file in `README.md` under "Third-party assets": source (Stanford University Piano Roll Archive, <https://supra.stanford.edu/>), the roll it comes from (Welte-Mignon T-100 "red Welte", identified by the file's own `@ROLL_TYPE: welte-red` and `@DRUID: jh696my0069` text events), and its licence. The Debussy composition is public domain (d. 1918), but SUPRA's About page states that its extracted MIDI files are licensed **CC BY-NC-SA 4.0** — the NC and SA terms are not compatible with the repo's MIT claim, so the README must scope MIT to the code and name the licence of this asset. The maintainer has confirmed that trade-off (keep this file, credit it CC BY-NC-SA 4.0), so no fallback asset is needed; if the repository ever has to be fully permissive, swap only the asset.

**Fresh-store detection and seed (`playlist.ts`)**

- `restore()` must record how the store looked when the player was constructed, distinguishing three cases:
  - key absent (`getItem` returns `null`) → **fresh**;
  - key present, readable, and a valid `StoredPlaylist` with `entries: []` → **initialized and empty** — never seed (this is the Clear playlist result);
  - key present but corrupt, wrong-shaped, or `getItem` throws → treat as **fresh** (consistent with the existing "corrupt data is ignored" rule; the first write replaces it).
- Expose `needsSeed(): boolean`: true only while the store was fresh, the playlist has no entries, seeding has not been attempted, and no user action has touched the playlist. Set a `touched` flag from the public mutation methods (`add`, `load`, `clear`, `remove`, `move`, `seed`) rather than relying on emptiness alone, because `clear()` on the empty state leaves `entries: []`.
- Expose `seed(file: File): boolean`: returns `false` without side effects when `needsSeed()` is false or the name is not `.mid`/`.midi`; otherwise routes the file through the same `dispatch` path as `add()` so the entry gets a normal id/name, becomes current (first ready entry) and the debounced `persistNow` caches its base64 in `fileData` and writes the store. Mark seeding attempted so a second call is a no-op.
- `resolveStorage() === null` (private mode, sandboxed iframe): there is no marker to remember, so seed once per page load and skip persistence as that path already does. Document that the sample reappears after a reload in those contexts.

**Startup wiring (`ui.ts`)**

- After the player is constructed, fire a fire-and-forget `void seedSampleSong()` next to the initial `renderPlaylist()`. It must not delay first paint, must not block Connect devices, and must never throw.
- Inside it: `fetch(sampleSongUrl)`; require `response.ok`, a non-empty body and an `MThd` signature (`0x4d 0x54 0x68 0x64`) before building `new File([bytes], "Debussy - Poissons d'or.mid", { type: 'audio/midi' })`, so an HTML error page saved into the asset never becomes a persisted error row. Re-check `player.needsSeed()` after every `await` and skip silently if the user has added, loaded or cleared files in the meantime.
- Success is silent: the row, its highlight and the parsed duration are the feedback, and the startup status line ("Devices not connected" / the unsupported-browser notice) must not be overwritten. A failure (network error, non-ok response, empty or non-MIDI body) is non-fatal and reports one line in the single `aria-live` region, e.g. `Could not load the sample song — add files to start.`; no row is added and the app stays fully usable.
- The sample does not autoplay: playback stays stopped, and the row becomes the current entry.

**Interaction with existing behaviour**

- The seeded row behaves like any other entry: numbering, background duration parse, reorder/remove, auto-advance, T9 channel/instrument card, Save playlist (it appears in the exported M3U) and reload restore.
- Clear playlist stays sticky: it persists `{"entries":[],…}`, so a reload after clearing shows the empty state rather than the sample. Removing the sample row and reloading must also stay empty.
- Load files replaces the sample like any other rows; T10's load path and its "unmatched leaves the playlist unchanged" rule are untouched.
- No new UI panel, control, test id or copy beyond the optional failure line.

**Tests**

- Vitest (`tests/unit/playlist.test.ts`, memory storage):
  - no key → `needsSeed()` true; `seed(file)` adds exactly one ready entry, makes it current, parses its duration through the injected `parse`, writes the store and caches the bytes (a second persist must not re-read the file).
  - seeded store restored in a second player → one entry, no refetch, `needsSeed()` false.
  - `{version:1,currentId:null,entries:[]}` → `needsSeed()` false and `seed()` is a no-op (Clear stickiness).
  - a restored non-empty playlist → `needsSeed()` false.
  - corrupt JSON and a throwing `getItem` → fresh, seed succeeds, the payload is replaced.
  - `add`/`load`/`clear` before the seed lands → `seed()` no-ops and the user's list is untouched; `clear()` on the empty state also cancels the pending seed.
  - `storage === null` → seeds once, attempts no write, does not throw.
  - a non-MIDI file name is rejected with no entry and no persist.
- Playwright (Chromium and Firefox):
  - fresh context: exactly one row named `Debussy - Poissons d'or`, highlighted, duration appears as `3:19`; Play sends notes through the mocked output; the startup status line is unchanged.
  - reload: still one row, restored from storage with no second request for the asset (count requests with `page.on('request')`).
  - Clear → empty state and `"entries":[]` persisted; reload stays empty. Removing the row and reloading stays empty too.
  - asset route aborted/404 → no row, exactly one status line, and adding files afterwards still works.
  - 360 px: the longer sample name truncates with the existing row ellipsis rule instead of overflowing, and the empty state still fits.
- Existing specs: the fresh profile now starts with one row, so every spec that assumes a blank playlist must opt out. Add `blankPlaylist(page)` to `tests/e2e/mocks.ts` as an init script that writes `{version:1,currentId:null,entries:[]}` under `PLAYLIST_STORAGE_KEY` **only when the key is absent** (the app's own later writes are left alone, so reload-restore assertions stay honest), and call it before `goto('/')` in the `setup()` of `transport-playlist`, `player-refinements`, `m3u-playlist`, `instruments-card`, `t11-faceplate` and `audio-monitor`. Then re-run the suite and fix any remaining row-count, ordering or `playlist-empty` assumptions found.

**Docs**

- `README.md`: a sentence under "Behaviour notes" describing the first-run sample and Clear stickiness, plus the asset credit.
- Design doc: one bullet under Playlist → Persistence (fresh profile starts with the bundled sample; the first stored write makes the store authoritative), and an "After the MVP" bullet.
- `tasks/README.md`: T12 index row, T12 added to the R3 and R13 coverage lists, and a short paragraph beside the T10/T11 notes.

## Acceptance criteria

- [ ] On a profile where `external-midi-player.playlist` has never been written, exactly one row named `Debussy - Poissons d'or` is present and current, its duration fills in as `3:19`, and the app still starts stopped.
- [ ] A stored empty playlist (Clear playlist) and any stored playlist with entries both suppress seeding; the empty state survives a reload after Clear or after removing the sample row.
- [ ] Seeding happens at most once per store: a reload restores the row from `localStorage` and makes no second request for the sample asset (match the emitted hashed URL by its `debussy-poissons-dor` prefix).
- [ ] Seeding never overrides user input: add, load or clear before the fetch resolves leaves the user's playlist intact and does not insert the sample.
- [ ] A missing, non-ok, empty or non-`MThd` asset leaves the playlist empty, reports exactly one status line in the single `aria-live` region, and leaves Connect devices, add/load files and transport working.
- [ ] The seeded song plays, seeks, auto-advances, appears in the T9 instrument card and is included by Save playlist, with no change to Load playlist semantics; the part strip and card show channels 2 and 3, with a default-program entry for the channel that has no program change.
- [ ] No new runtime dependency, no new module, no new UI panel or control, and no request outside the app's own origin (T5 CSP unchanged); the asset URL is base-aware so the build works at a subpath.
- [ ] Seed success is silent and does not overwrite the startup status; the README records the file's origin, its Welte roll provenance and its actual licence, with the repo's MIT claim scoped to the code.
- [ ] The 360 px layout, keyboard access and existing test ids are unchanged, and the longer sample name truncates rather than overflowing.
- [ ] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass, with the pre-existing e2e specs updated to start from a deliberately blank playlist.
- [ ] The task index, requirements coverage and design doc are updated.

## Notes

- **"Fresh" means "never written", not "empty".** `restore()` already treats a stored `entries: []` as nothing to restore, so triggering on "the list has no entries" would resurrect the sample after every Clear and after every `Clear playlist` + reload. The store key itself is the only record of "has been initialized", which is why the condition is checked before the fetch rather than after it.
- **Why the UI owns the fetch.** The freshness rule is storage and belongs in `PlaylistPlayer`; the asset fetch is I/O and belongs in the composition root (`ui.ts`). That keeps the player unit-testable with an injected `File`, adds no module (the split is fixed) and keeps the seed on the same `dispatch` → debounced persist path as every other row, so the quota, revision and failure handling do not fork.
- **Cost.** 30,352 bytes become ~40 KB of base64 in the stored payload, well inside the usual 5 MB quota, and the existing persistence already rewrites the whole playlist on each save. The first seed is one same-origin request that the HTTP cache and the stored bytes then make unnecessary.
- **Why this file.** It exercises a lot of the player: format 1 with three tracks, 33 tempo changes across 3:19, 3,151 notes on channels 2 and 3 (so the part strip and T9 card prove original channels are kept, and channel 3 has no program change so the "default program" path is visible), two program changes (program 0 on channel 2), sustain and pan controllers, and no SysEx — so `requestMIDIAccess({ sysex: false })` stays as is. Its display name is 23 characters, which is why the 360 px check asserts truncation rather than mere absence of overflow. The parser drops its non-tempo text meta events, so the `@ROLL_TYPE`/`@DRUID` provenance only matters to the README credit.
- **Asset licence (decided).** The Debussy composition is public domain, but the MIDI rendition is SUPRA's extracted file, which the archive licences CC BY-NC-SA 4.0. The maintainer chose to keep it and credit it rather than substitute a generated file, so the README must state that licence explicitly and scope the MIT claim to the code; the asset ships unmodified, so no share-alike obligation reaches the source. If the repository later needs to be fully permissive, swapping this one asset is the only change required.
- **Why no autoplay.** No MIDI output is selected before Connect devices, and monitoring starts muted by policy (R10). A row the user can press Play on is a demo without changing either rule.
- **Failure visibility.** A 404 asset is a deployment bug, so it gets one status line rather than a console warning, and seeding is then never retried in that session. A recovered deployment takes effect once storage is cleared or on a fresh profile, matching the existing "corrupt stored data is ignored" behaviour.
- **Corrupt store.** Treating malformed stored data as fresh reuses the existing rule that corrupt data is ignored; the sample replaces it on the first persist. If a stored payload has entries but is only partly malformed, the valid entries are kept and no seed happens.
- **Test seam.** `blankPlaylist()` writes the empty payload only when the key is absent, which is exactly "initialized but empty". It therefore does not need a test-only flag in the app, and it keeps reload-restore tests meaningful because the app's own writes are never overwritten.
- **Out of scope:** more than one bundled song, a sample/demo picker or panel, autoplay, an IndexedDB or offline store, re-seeding after the user removes the row, cross-tab coordination, and the existing `styles.css` `/fonts/` absolute URLs (T6's concern, not this ticket's).
- **Docs:** the design doc's Playlist → Persistence bullet, the "After the MVP" bullet, the T12 index row and the R3/R13 coverage lists are part of this ticket; leave the implementation-facing decisions for a "Decisions as implemented" subsection once the task is done.
