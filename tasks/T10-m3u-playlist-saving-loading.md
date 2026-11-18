# T10: M3U playlist saving and loading

- **ID**: T10
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5–1 day
- **Depends on**: T3, T8
- **Modules**: `playlist.ts` (M3U serialize/parse/match), `ui.ts`, `styles.css`, unit and e2e tests
- **Requirements**: R1, R2, R3, R13 (no new R-ID; M3U is an import/export format over the existing playlist)

## Objective

Let the user save the current playlist as a standard M3U/M3U8 file and load one back, preserving the order the file defines. It follows T8 because it reuses the Load/Clear playlist actions, row numbering and `localStorage` persistence instead of adding a second playlist model.

## Scope

**M3U format (`playlist.ts`)**

- Export `buildM3u(entries: PlaylistEntry[]): string`: UTF-8 text with a `#EXTM3U` header, then for every entry a `#EXTINF:<seconds>,<name>` line followed by the file reference, in playlist order. `<seconds>` is `Math.round(durationSec)`, or `-1` when the duration is unknown; `<name>` is the entry name with CR/LF stripped; the reference is `entry.file.name` (the only name a browser keeps). Error entries are written with their name and `-1`.
- Export `parseM3u(text: string): { tracks: M3uTrack[]; unsupported: string[] }` where `M3uTrack` is `{ reference: string; title?: string; durationSec?: number }`. Tolerate a UTF-8 BOM, CRLF/LF, blank lines, `#EXTM3U` and other comments, an `#EXTINF` with or without a title, `-1`/non-integer durations, quoted references, and POSIX, Windows, absolute and `./` relative paths. Ignore `#EXT-X-*` HLS tags. Report URL references (`http:`, `https:`, `rtsp:`, `mms:`) and references that are not `.mid`/`.midi` in `unsupported` rather than trying to fetch them.
- Export `matchM3u(tracks, files): { files: File[]; missing: string[]; extra: File[]; ambiguous: string[] }`. Match each track to a selected file by `webkitRelativePath` when both sides expose one, otherwise by base name, case-insensitively and Unicode-NFC-normalised; `\` and `/` are equivalent, a leading `./` and any `file://` prefix are ignored. Preserve M3U order; repeated references produce repeated rows. When two selected files share a base name, assign them in selection order and report the base name in `ambiguous`. Selected files not referenced by the M3U are returned in `extra`.

**Playlist integration**

- Loading reuses `PlaylistPlayer.load(matchedFiles)`: it stops playback, replaces the playlist with the matched files in M3U order, clears the old parse queue/file cache, makes the first ready entry current, and persists through the existing `localStorage` path. Imported bytes are copied into storage, so a reload does not need the M3U again.
- Each reference resolves against the files selected with the playlist first, then against the files already in the current playlist. Re-loading a playlist exported in this session therefore works when only the `.m3u8` is selected; genuinely new files still have to be selected with the playlist.
- A playlist whose references all fail to match leaves the existing playlist unchanged and reports why. A partial match replaces the playlist with the matched subset and lists what was missing.
- Saving reads `player.playlist.entries` and downloads the text as `midi-playlist.m3u8` (`audio/x-mpegurl`) with a temporary object URL that is revoked after the click. No network request and no new runtime dependency.
- Guard the parser with a 1 MB / 10,000-line cap; larger playlist files are rejected with a status instead of parsed.

**UI (`ui.ts`, `styles.css`)**

- Add **Save playlist** and **Load playlist** buttons to the Playlist panel's existing action group, with the same compact styling and accessible names. Save is disabled while the playlist is empty.
- Load uses one hidden multi-select input accepting `.m3u,.m3u8,.mid,.midi`: the user may pick the playlist alone when its files are already loaded, or the playlist together with the MIDI files it references. Exactly one playlist is required; zero or several produce a status explaining what to select.
- Report unmatched references, unsupported entries, ambiguous base names and ignored extras in the single `aria-live` region, for example `Loaded 8 of 10 entries from playlist.m3u; not found: a.mid, b.mid.`
- Extend the drop zone: dropping an `.m3u`/`.m3u8` together with `.mid` files runs the load-playlist path; dropping a playlist alone reports the missing files and leaves the playlist unchanged; dropping only MIDI files keeps the current append behavior.
- Keep the existing panel and DOM order; the new buttons wrap at 360 px without horizontal overflow, and the file input is reachable through its labelled button by keyboard.

**Tests**

- Vitest: `buildM3u` header, order, rounded/`-1` durations, names with commas/spaces/non-ASCII, error rows, empty list, trailing newline, CR/LF stripped; `parseM3u` BOM, CRLF, blank/comment lines, optional header, EXTINF with/without title, malformed EXTINF, quoted/Windows/absolute/relative paths, URL and non-MIDI rejection, non-ASCII; `matchM3u` base-name and full-path matching, case/NFC normalisation, missing, extra, ambiguous duplicates, order, repeated references and current-playlist fallback; player integration for replace order, stop-first, persisted save/restore, reloading from the existing playlist and the unmatched-keeps-playlist rule.
- Playwright (Chromium and Firefox): Save is disabled when empty and downloads the exact expected text; Load with a playlist plus files replaces order/names/numbers, highlights the first entry and survives a reload; selecting the playlist alone reuses the files already loaded; a missing reference is reported and only matched entries load; an unmatched playlist leaves the existing rows; dropping a playlist plus files works while dropping MIDI files still appends; 360 px layout and keyboard access still pass.
- The project Definition of Done passes.

## Acceptance criteria

- [x] Save is disabled on an empty playlist and otherwise downloads `midi-playlist.m3u8` containing `#EXTM3U`, one `#EXTINF` plus file-reference line per row in playlist order, with rounded durations and `-1` for unknown ones.
- [x] Loading a single `.m3u`/`.m3u8` selection plus the MIDI files it references replaces the playlist in M3U order, stops playback, makes the first ready entry current and persists the result; a reload restores the same order without the playlist file.
- [x] Re-loading a playlist while its files are still in the playlist works when only the `.m3u8` is selected, using those files; the status reports how many came from the playlist and does not ask for the MIDI files again.
- [x] References match by relative path when available, otherwise case-insensitive base name; missing references, unsupported entries (URLs, non-MIDI) and ignored extra selections are all named in the single `aria-live` region.
- [x] When no reference matches, the existing playlist, current entry and persisted data are unchanged, and the status says why.
- [x] The parser tolerates BOM, CRLF/LF, blank lines, comments, quoted and Windows paths, absolute and relative paths, and non-ASCII names; a malformed `#EXTINF` does not reject the whole file, and a playlist over the 1 MB / 10,000-line cap is rejected with a status.
- [x] Dropping an `.m3u`/`.m3u8` with `.mid` files loads it; dropping a playlist alone reports the missing files without changing the playlist; dropping only MIDI files still appends them as before.
- [x] No upload, backend, network fetch or new runtime dependency is introduced, and M3U text is only ever inserted as text, never as HTML.
- [x] The controls are keyboard-accessible with accessible names, the Playlist panel has no horizontal overflow at 360 px, and all load/save feedback uses the single status region.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass, and the task index, requirements coverage and design doc are updated.

## Notes

- **Browser path constraint.** A `File` exposes `name` and `webkitRelativePath`, never the original absolute path. An exported M3U can therefore only reference base file names, and loading must be handed the MIDI files themselves; the app immediately copies their bytes into `localStorage`, so a reload afterward is self-contained. M3U is a reference list, not a container — that is the main difference from a desktop player.
- **Format decisions:** save as `.m3u8` (UTF-8, no BOM, LF line endings, `#EXTM3U` first) because `.m3u` is historically Latin-1 and a UTF-8 `.m3u` is mangled by some players; accept both extensions on load. UTF-8 decode is the app's existing assumption, so a legacy Latin-1 `.m3u` with accented names may mis-decode — acceptable, and reported as a missing match rather than silently loading the wrong file. Open question: also offer a `.m3u` download for older players.
- **Durations are written but not trusted.** `#EXTINF` seconds come from the app's own parse on export but are ignored on import: the background duration parse is authoritative. Do not prefill `PlaylistEntry.durationSec` from `#EXTINF`, or `pumpParseQueue` will skip the file (it skips entries that already have a duration) and the displayed time stays wrong if the M3U was stale.
- **Titles are ignored for the entry model.** `PlaylistEntry.name` is file-derived and persisted; honouring `#EXTINF` titles would add a second display name and touch the stored schema, R3 and T9. `title` is retained by `parseM3u` only for diagnostics. Matching always uses the reference, not the title.
- **Duplicate base names** are the unavoidable consequence of name-only export: the matcher assigns the nth selected file with that base name to the nth reference and reports the name, so the user can see why the pairing may be wrong.
- **One-step selection, not a directory picker.** The picker accepts the playlist and its MIDI files together, which works in both target browsers without new permissions. `input.webkitdirectory` or `showDirectoryPicker()` could resolve relative paths in one step but would force a folder choice and are out of scope; note them as a possible later improvement.
- **Reuse, don't fork.** The load path must call `PlaylistPlayer.load()` rather than dispatching its own `replace`, so stop-first, queue clearing, current-entry selection and debounced persistence stay identical to T8. A new player method is only justified if duplicate references or a MIME-typed playlist need special handling.
- **Out of scope:** HLS playback and `#EXT-X-*` semantics (ignored), URL/stream playback, `.pls`/`.wpl`/`.xspf`, absolute-path rewriting, auto-locating missing files on disk, and storing the M3U file itself.
- **Security:** the playlist is untrusted text. Never fetch its references, never inject a line as markup, and enforce the size/line cap before building entries.
- **Test fixtures:** extend `tests/unit/playlist.test.ts` and add cases to the Playwright playlist spec; the existing e2e file-picker helper already drives the hidden inputs, and Playwright's download event supplies the saved text for assertion.
- **Docs:** the design doc's "After the MVP" bullet, the T10 index row and the requirements coverage line are already in place; while implementing, add a paragraph to the design doc's Playlist section and update the ticket status and any decisions in `tasks/README.md`.

### Decisions as implemented

- **Format:** Save writes UTF-8 `.m3u8` with LF endings and no BOM (`#EXTM3U`, `#EXTINF:<rounded seconds>,<name>`, `#EXTINF:-1` when the duration is unknown, then the original file name). Load accepts `.m3u`/`.m3u8`, tolerates BOM/CRLF/comments/quoted and Windows paths, ignores `#EXT-X-*` HLS tags, and reports URLs and non-MIDI references as unsupported without fetching them. A legacy Latin-1 playlist is decoded as UTF-8; a mangled name simply fails to match.
- **One picker:** Load playlist uses one hidden multi-select accepting the playlist and, optionally, its MIDI files; exactly one playlist per selection. Dropping a playlist with files takes the same path; dropping a playlist alone reports the missing files; dropping only MIDI files still appends. No directory picker, so no new permission and no browser-specific path lookup.
- **Matching:** an exact `webkitRelativePath` match wins; otherwise case-insensitive, NFC-normalised base names are used. Selected files are tried before files already in the playlist, so a deliberate selection wins over a same-named existing entry. Duplicate base names are assigned in selection order and reported, repeated references reuse the same `File`, and selected files the playlist never mentions are reported as ignored rather than silently dropped; existing playlist files are never reported as extras.
- **Replace semantics:** a partial match replaces the playlist with the matched subset through `PlaylistPlayer.load()` (stop first, first ready entry current, debounced persistence); a zero-match selection leaves the playlist, highlight and stored data untouched. Imported bytes are persisted, so a reload does not need the M3U again.
- **Load-alone follow-up:** the first implementation required the MIDI files to be selected with the playlist, so re-loading an exported playlist failed when only the `.m3u8` was selected even though every file was still in the playlist. References now resolve against the selection first and the current playlist second; the status reports `Used N files already in the playlist`, and only references found in neither place are missing and still need selecting.
- **Durations and titles:** `#EXTINF` durations are written from the app's own `durationSec` but ignored on import; pre-filling `durationSec` would make `pumpParseQueue` skip the file and keep a stale M3U duration. `#EXTINF` titles are parsed for diagnostics only; entry names remain file-derived, so the stored schema, R3 and T9 are unchanged.
- **Limits and safety:** `parseM3u` refuses text over 1 MB or 10,000 lines, and the UI also checks `File.size`; the text is never fetched or inserted as markup.
- **Testing and scope:** 21 new Vitest cases cover serialization, parsing, matching (including current-playlist fallback), caps and the `PlaylistPlayer` integration; 8 Playwright cases per browser cover the disabled Save state, the downloaded text, order/replace/reload, loading with only the playlist selected, missing/unsupported/extra reporting, unchanged-on-no-match, drop behavior and 360 px keyboard reach. No new runtime dependency and no new module: the format lives in `playlist.ts` next to the entry model.
