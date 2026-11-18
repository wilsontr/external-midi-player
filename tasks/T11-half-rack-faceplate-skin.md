# T11: Half-rack faceplate skin

- **ID**: T11
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 2–3 days
- **Depends on**: T8, T9
- **Modules**: `ui.ts`, `styles.css`, `index.html`, `vite.config.ts` (CSP), `public/fonts/`, `README.md`, e2e tests (`tests/e2e/*.spec.ts`)
- **Requirements**: R1, R2, R3, R4, R6, R7, R9, R10, R12 (presentation only; no new R-ID)

## Objective

Restyle the player as a 90s half-rack tone module (concept A from the faceplate study): charcoal chassis, amber dot-matrix LCDs, grey rubber keys with LEDs, and Helvetica Neue silkscreen labels. Every control keeps its current behaviour. This is a skin and layout change on the existing DOM, with no new playback features.

## Scope

**Design tokens and type**

- Replace the current light/dark panel palette with one committed dark faceplate theme defined as CSS custom properties on `:root`: `--chassis`, `--chassis-hi`, `--silk`, `--silk-dim`, `--lcd-bg`, `--lcd-bg-hi`, `--lcd-ink`, `--lcd-ghost`, `--key`, `--key-ink`, `--key-panic`, `--led-red`, `--led-green`, `--led-amber`, `--focus`. Set `color-scheme: dark` and an explicit `body` background.
- Panel and label type: `"Helvetica Neue", Helvetica, Arial, sans-serif` everywhere outside the LCDs. Silkscreen labels are uppercase, regular weight (`font-weight: 400`), untracked (`letter-spacing: 0`) and at least 11 px. No web fonts for panel text.
- LCD type: **Graph 35+ pix** (Florian Contreras; one weight) self-hosted for every LCD readout, with a `"Courier New", monospace` fallback. Sizes are multiples of 8 px (16, 24, 32, 40), with smoothing off (`-webkit-font-smoothing: none`, `font-smooth: never`), `font-synthesis: none` (no faux bold), and `font-variant-numeric: tabular-nums`. Hierarchy on the LCD comes from size and inversion, not weight.
- All textures (chassis grain, rack screws, bevels, unlit-pixel grid, glass glare) are CSS gradients and shadows. No image assets.

**Unit 1: front panel (left column, replaces the header and audio monitor cards)**

- Left strip: monitor volume as a rotary **knob** drawn over the existing `#monitor-volume` range input (the input stays focusable, labelled and keyboard-operable; the knob rotates −135°…+135°). The volume percentage text stays available to assistive tech.
- **MUTE** as a latching rubber key with a red LED, keeping `aria-pressed` and the `mute-button` test ID.
- Input meter as two vertical **LED ladders** (L/R, 12 segments: green, amber for the top three, and red for the clip light). The red top LED replaces the CLIP text, and the `role="meter"` element keeps its `aria-valuetext`.
- Main amber **LCD**: song number, current title, state (PLAY / PAUSE / STOP), elapsed time, length, the seek bar (the existing `timeline` slider restyled as a segmented bar) and, on its bottom line, the single `aria-live` status region.
- **16-part strip** inside the LCD, static: channels 1–16 with the channels used by the playing song marked, derived from `player.instrumentsState()`. No per-note activity (see Notes).
- Right strip: MIDI output picker as an LCD-styled `select`; transport keypad (Prev, Play/Pause, Next, Stop, and Panic in red-orange) with silkscreen captions under each key and a green or amber LED on Play for playing or paused; **Connect devices** / **Retry** keys with a red/green LED that shows whether MIDI access and an output are present. While they are not, the LCD status line reads "Devices not connected".
- Header and how-to: the app name becomes the unit's silkscreen brand line. The how-to list, unsupported-browser notice and Firefox onboarding text render as a printed "Quick start" label above the rack, with a show/hide toggle, still visible and in DOM order.

**Unit 2: expansion unit (right column, replaces the playback-adjacent playlist and instruments cards)**

- **Song list** LCD: the existing playlist `<ol>` with numbered rows, the current song as an inverted row, rejected files dimmed and struck through, duration right-aligned. Reorder (drag and the move buttons), remove and select keep working, with their accessible names unchanged.
- Key row above it: `+` (Add files), Load, Clear. Leave space for T10's playlist Save/Load keys.
- The drop zone becomes a dashed "Drop .mid files on this unit" strip; dropping anywhere on unit 2 still works.
- **Part map** LCD: the Instruments list (`ch · instrument · program`), same text content as T9.
- Audio input and output pickers and the latency readout as LCD-styled `select`s and a silkscreen readout. The feedback warning, the output-grant button and the unsupported notes render as amber-LED notices.

**Layout**

- At ≥ 960 px: unit 1 above unit 2, each spanning the full app width, max width ≈ 1200 px. Inside unit 1: knob strip | LCD | keypad. Inside unit 2: song list (≈ 60%) | part map + monitor routing (≈ 40%).
- Below 960 px: unit internals stack (strip, LCD, keypad; song list above part map). At 360 px there is no horizontal overflow.
- DOM order and tab order follow: quick start (toggle, credit links), unit 1 (volume, mute, LCD seek, output, transport, connect), unit 2 (playlist keys, song list, part map, audio routing).

**States and accessibility**

- Focus: a visible 2 px `--focus` ring on keys, knob and selects, and a dashed LCD-ink cursor on focused song-list rows. Never colour alone: latched and playing states use an LED plus `aria-pressed` or text.
- Disabled keys (no output, no songs) look unlit and flat, not just greyed.
- LCD ink on LCD background meets a 4.5:1 contrast ratio, and the unlit-pixel grid stays at or below 12% opacity.
- `prefers-reduced-motion`: no blinking status cursor; meters still update (they are data, not decoration).

**Tests**

- Keep every existing `data-testid`, accessible name and keyboard shortcut. Update the e2e layout assertions (`device-access`, `instruments-card` and `player-refinements` bounding-box checks) for the rack layout.
- Add e2e checks: the knob turns with the range input and with arrow keys; the mute LED follows `aria-pressed`; the clip LED lights where the CLIP text used to; the part strip marks exactly the channels in the Instruments list and clears on stop; no horizontal overflow at 360 px; computed `font-family` of a silkscreen label starts with Helvetica Neue.
- Use the VLM (`montmartre.local:8080`) on Chrome DevTools screenshots at 1280 px and 360 px as a visual sanity check against the mockup. It is not a pass/fail gate.

## Acceptance criteria

- [x] The faceplate theme is defined entirely by `:root` tokens; no component rule uses a literal colour.
- [x] Panel text and labels use the Helvetica Neue / Helvetica / Arial stack with no web font.
- [x] LCD readouts use self-hosted Graph 35+ pix from `public/fonts/` at 8 px multiples with smoothing off and no synthetic bold. The font loads under the production CSP.
- [x] CC BY-SA 3.0 obligations are met: `license.txt` ships beside the font, `public/fonts/README.md` gives the title, author, source, licence link and the WOFF2 conversion, and the app shows a visible credit line. The root README says the font is CC BY-SA 3.0 and the code MIT.
- [x] Unit 1 shows the volume knob, mute key with LED, L/R LED ladders with a clip LED, the amber LCD (title, state, time, length, seek bar, 16-part strip, status line) and the transport keypad, and every control works as before.
- [x] Unit 2 shows the song list, playlist keys, drop strip, part map and audio routing, and add, load, clear, drop, reorder, remove and select all work as before.
- [x] The status region is still the single `aria-live` region and sits on the main LCD's bottom line.
- [x] The 16-part strip marks the playing song's channels from `instrumentsState()`, is empty when stopped, and does not animate per note.
- [x] Focus is visible on every interactive element; latched and playing states are shown by LED plus text or ARIA, not colour alone; LCD text meets 4.5:1 contrast.
- [x] At ≥ 960 px unit 1 sits above unit 2; below it the units stack internally; 360 px has no horizontal overflow; tab order follows the documented order.
- [x] No image assets and no new runtime dependency; the LCD font, if bundled, is a static asset under `public/`.
- [x] Vitest, Playwright and `tsc --noEmit` pass; the design doc's UI layout section and the task index are updated.

## Notes

- **Reference:** concept A in the faceplate study artifact (https://claude.ai/artifact/LZUoP3d4PKsWppG7h6ZZQ4). It is a mockup, not a pixel spec; match the materials, hierarchy and control mapping.
- **LCD font: Graph 35+ pix (decided; replaces PixelMix, whose free terms are personal-use only).** Source: https://www.dafont.com/graph-35-pix.font by Florian Contreras, the typeface of the Casio Graph 35+ graphing calculator. The download (9 KB) is a single `Graph-35-pix.ttf`, 398 glyphs, listed under "Bitmap (8 px)". It is a static asset, not an npm runtime dependency, so it stays within the two-dependency rule.
  - **Licence: CC BY-SA 3.0** (from `license.txt` in the font zip, which overrides dafont's "100% Free" tag). It covers the FontStruction "Graph 35+ pix" (http://fontstruct.com/fontstructions/show/664062) by "30100flo", the FontStruct handle of Florian Contreras. Commercial use and redistribution are allowed with these obligations:
    - **Keep the licence with the file:** commit the zip's `license.txt` unchanged as `public/fonts/graph-35-pix-LICENSE.txt` beside the TTF and WOFF2, so it is deployed with them.
    - **Attribution:** `public/fonts/README.md` names the title, author (30100flo / Florian Contreras), source URL, licence (CC BY-SA 3.0, https://creativecommons.org/licenses/by-sa/3.0/), and states that the WOFF2 file is a format conversion of the original TTF. Because every visitor downloads the font, the app also shows a small silkscreen credit line at the end of the "Quick start" label: "LCD font: Graph 35+ pix by 30100flo, CC BY-SA 3.0", with the source and licence as links.
    - **ShareAlike:** applies to the font file and any adapted font (the WOFF2 conversion, a subset, or a glyph edit). These stay CC BY-SA 3.0. Using the font to render the app's text does not make the app an adaptation of the font, so `ui.ts` and `styles.css` stay MIT.
    - **Mixed licensing in the repo:** add a short "Third-party assets" section to the root `README.md`: code is MIT (`LICENSE`), and `public/fonts/graph-35-pix.*` is CC BY-SA 3.0. Do not add the font to `LICENSE` itself.
    - The licence names the original font only. It gives no right to use Casio's trademarks, so do not mention "Casio" anywhere in the UI.
  - **Format:** commit the TTF and a WOFF2 conversion (for example `fonttools ttLib.woff2 compress`), and declare `@font-face { font-family: "Graph 35 Pix"; src: url("fonts/graph-35-pix.woff2") format("woff2"), url("fonts/graph-35-pix.ttf") format("truetype"); font-display: swap; }`. Use paths that respect Vite's `base` for GitHub Pages.
  - **One weight only:** the mockup's heavy LCD numerals (800/900) become larger sizes or inverted cells. `font-synthesis: none` stops browsers from smearing a faux bold across the pixel grid.
  - **Keep it in `public/`, not imported from `src/`.** Vite inlines imported assets under 4 KB as `data:` URIs, and the production CSP (`default-src 'self'`, no `font-src`) would block a `data:` font. Files served from `public/` are same-origin, so the existing CSP allows them. Add an explicit `font-src 'self'` to the policy in `vite.config.ts` for clarity.
  - **Rendering:** the font is drawn on an 8 px grid. Size LCD text at 16/24/32/40 px so pixels land on whole device pixels; the smallest LCD captions (the mockup's 10 px labels) move to 16 px or become Helvetica silkscreen outside the glass. That makes the LCDs physically larger than in the mockup, so check that the 16-part strip and the song list still fit at 360 px. Expect slight blur on Windows/Linux, where smoothing cannot be disabled; check it in the e2e screenshot pass.
  - **Glyph coverage:** check the charmap for the em dash, middle dot (·), arrow (→), ellipsis (…), ▶/❚❚ and accented filenames. Use ASCII (`-`, `>`, `...`) in LCD-only strings where they are missing, and draw transport icons as SVG rather than glyphs. The fallback stack covers anything else.
- **Helvetica availability:** Helvetica Neue ships on macOS and iOS; Windows and Linux fall back to Arial, which is metrically close. There is no condensed Helvetica that all platforms have, so labels get their narrow look from size and uppercase casing, not from a condensed cut or tracking.
- **Module split:** no new modules. All changes are in `ui.ts` markup and `styles.css`. The knob is CSS rotation driven by the existing volume input's value, with no custom drag code. Vertical-drag knob behaviour is out of scope.
- **Panels:** this rearranges existing panels into two units and adds no new panel. The 16-part strip is a new view of existing T9 data inside the playback LCD.
- **Out of scope, follow-up ticket:** live per-channel note activity in the 16-part strip. It needs a lightweight activity feed from the scheduler (note-on velocity per channel, decayed in the UI's rAF loop) and goes beyond T9's "static card" decision.
- **Out of scope:** concepts B (tabletop deck, VU needles) and C (paged workstation). VU needles could come back later as an alternative meter style on the same tokens.
- **Coordination with T10:** if T10 lands first, its Save/Load playlist keys go in unit 2's key row. If this lands first, T10 adds them there.
- **Light theme:** dropped on purpose. The faceplate is a single dark look, as on the hardware. If a light skin is wanted later, it is a token swap.
