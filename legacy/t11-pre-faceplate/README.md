# Legacy UI — the pre-T11 layout (kept for a possible swap back)

This folder is a verbatim copy of the two files that made up the UI before
T11 replaced them with the half-rack faceplate:

| File | Copy of |
| --- | --- |
| `ui.ts` | `src/ui.ts` as of commit `df47904` (before T11) |
| `styles.css` | `src/styles.css` as of commit `df47904` (before T11) |

Nothing imports these files. They are not part of the TypeScript project
(`tsconfig.json` only includes `src`, `tests` and the config files), so they
are never type-checked or bundled. They are here so the light two-column
layout can be restored without digging through git history.

## Swapping back

```bash
cp legacy/t11-pre-faceplate/ui.ts src/ui.ts
cp legacy/t11-pre-faceplate/styles.css src/styles.css
npx tsc --noEmit && npx vitest run && npx playwright test
```

The legacy `styles.css` has no `@font-face`, so the Graph 35+ pix assets in
`public/fonts/` are simply unused after a swap back; `public/fonts/` can stay
in place (the licence files must stay with the font files if they do).

The e2e layout assertions were updated for the rack layout in T11. If you swap
back, also revert those assertions (`device-access.spec.ts`,
`instruments-card.spec.ts`, `player-refinements.spec.ts`,
`t11-faceplate.spec.ts`) to the pre-T11 expectations.
