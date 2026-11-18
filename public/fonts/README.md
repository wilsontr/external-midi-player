# LCD font — Graph 35+ pix

The LCD readouts use **Graph 35+ pix**, a FontStruction by **30100flo
(Florian Contreras)**, the typeface of the graphing calculator it is named
after.

- **Title:** Graph 35+ pix
- **Author:** 30100flo / Florian Contreras
- **Homepage / source:** <http://fontstruct.com/fontstructions/show/664062>
  (downloaded from <https://www.dafont.com/graph-35-pix.font>)
- **Licence:** Creative Commons Attribution-ShareAlike 3.0
  (<https://creativecommons.org/licenses/by-sa/3.0/>)

## Files

| File | What it is |
| --- | --- |
| `graph-35-pix.ttf` | The original `Graph-35-pix.ttf` from the download, byte-for-byte |
| `graph-35-pix.woff2` | A format conversion of that TTF, produced with `fonttools ttLib.woff2 compress`; no glyphs were changed |
| `graph-35-pix-LICENSE.txt` | The `license.txt` shipped in the font archive, unchanged |
| `graph-35-pix-README.txt` | The `readme.txt` shipped in the font archive, unchanged (it asks that a redistributed font file travel with the archive's other files) |

## Licence obligations

The font files (including the WOFF2 conversion, which is an adaptation under
the licence's ShareAlike term) are **CC BY-SA 3.0**. Commercial use and
redistribution are allowed provided the licence travels with the files — that
is what `graph-35-pix-LICENSE.txt` is for — and the work is attributed. The
app shows a credit line at the end of its "Quick start" label, and the root
`README.md` records the third-party asset.

Rendering the app's text with the font does not make the app an adaptation of
the font, so the application code stays MIT (see `LICENSE`).

The licence covers the font, not any third-party trademark. The UI therefore
does not name any calculator manufacturer.

## Glyph coverage and hints

The face is drawn on an 8 px grid: render it at multiples of 8 px (16, 24,
32, 40) so pixels land on whole device pixels. One weight only — use size and
inverted cells for hierarchy, never synthetic bold (`font-synthesis: none`).

The charmap has the middle dot, ellipsis, degree sign and accented Latin
letters, but no em dash, arrows, `▶`/`❚❚`, minus sign or infinity symbol.
LCD-only strings use ASCII (`-`, `>`, `...`) and transport icons are inline
SVG rather than glyphs; the `"Courier New", monospace` fallback covers
anything else.
