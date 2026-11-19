# External MIDI Player

Browser-based MIDI playlist player: plays `.mid` files out to external MIDI hardware and plays back that hardware's audio via your audio interface. Static Vite + TypeScript app, no backend.

![External MIDI Player with a loaded playlist, the current song playing and the live instrument card](docs/player.png)

## Features

- Plays MIDI files (GM/GS/XG) on an internal synth (SpessaSynth) or any MIDI port available on your system
- Works with soft synths or external hardware
- Routes audio back from your external synths via your audio interface for listening
- Throttled track setup timing for DIN MIDI and older hardware
- M3U playlists
- Metadata viewer
- Instrument viewer
- Skeuomorphism!

## Design

Design (source of truth): [`design.md`](docs/design.md)

## Quickstart

```bash
npm install
npm run dev        # http://localhost:5173
```

Use `localhost` (or HTTPS) — Web MIDI and `getUserMedia` require a secure
context. Open the page in a desktop Chrome/Edge or Firefox and click
**Connect devices**.

## Tests

```bash
npx vitest run          # unit tests (device logic)
npx playwright test     # e2e, Chromium + Firefox (mocked Web MIDI / getUserMedia)
npx tsc --noEmit        # typecheck
```

CI runs the same three commands on every push and pull request — see
[Deployment](docs/deployment.md).

## Third-party assets

Code is MIT (see [`LICENSE`](LICENSE)).

`public/fonts/graph-35-pix.ttf` and `public/fonts/graph-35-pix.woff2` are
**Graph 35+ pix** by 30100flo (Florian Contreras), licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The WOFF2 is
a format conversion of the original TTF. Both files, their unchanged
`license.txt` and the archive's `readme.txt` ship together in `public/fonts/`;
see [`public/fonts/README.md`](public/fonts/README.md) for the full attribution.
The licence covers the font files only, not the application code.

`src/assets/debussy-poissons-dor.mid` is the first-run sample (T12):
_Poissons d'or_ by Claude Debussy (1862–1918, public domain), as a MIDI
rendition extracted from the **Welte-Mignon T-100 "red Welte"** piano roll by
the [Stanford University Piano Roll Archive](https://supra.stanford.edu/)
(SUPRA), roll `jh696my0069`. The file keeps its own provenance text events
(`@ROLL_TYPE: welte-red`, `@DRUID: jh696my0069`). SUPRA licenses its extracted
MIDI files **CC BY-NC-SA 4.0**, which is not compatible with the repository's
MIT claim: the MIT licence covers the application code only, and this asset is
included unmodified under its own licence. It ships as a 30,352-byte SMF
(format 1, 570 PPQ, 3 tracks, 3:19) and is then stored in `localStorage` like
any other playlist row.

`src/assets/GeneralUserGS.sf3` is **GeneralUser GS 2.0.3 BETA** by S. Christian
Collins, licensed under the author's
[GeneralUser GS Licence v2.0](https://github.com/mrbumpy409/GeneralUser-GS/blob/main/documentation/LICENSE.txt)
(free to use and modify in software projects; redistribution of a local copy
with attribution is permitted — the same licence text is embedded in the
bank's `ICMT` chunk). It is the SF3 (Vorbis-compressed) build published with
SpessaSynth's demo, 8,423,728 bytes, `sha256 e2ed326f…97bc66c`. The author's
licence notes that the provenance of some samples is not fully documented; it
covers the SoundFont asset only, not the application code.

The built-in synth engine is [`spessasynth_lib`](https://github.com/spessasus/spessasynth_lib)
4.4.8 and `spessasynth_core` 4.4.10 (both Apache-2.0, with `fflate` MIT and
`stb-vorbis` Apache-2.0), loaded only when the built-in synth is selected.
The production CSP allows `'wasm-unsafe-eval'` for its SF3 decoder; it does not
allow JavaScript `eval`.
