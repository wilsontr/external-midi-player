# T23: Drop the feedback warning from the status line

- **ID**: T23
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.05 day
- **Depends on**: T11 (faceplate), T15 (pickers and notices on the front unit), T22 (one-line status)
- **Modules**: `src/ui.ts` (feedback-warning handling), `tests/e2e/audio-monitor.spec.ts`, `tests/e2e/device-access.spec.ts`, `tests/e2e/volume-knob.spec.ts`, `tests/e2e/metadata.spec.ts`
- **Requirements**: R10 (feedback safety; presentation only, no new R-ID)

## Objective

The shared input/output device used to be announced twice: once in the dedicated warning box under the audio pickers and again once in the LCD status line. The box is the intended place for it, so the status line stops repeating the warning and stays reserved for device and file status.

## Scope

- **One notice only.** `updateFeedbackWarning()` shows or hides the `feedback-warning` box and no longer writes the "same device" text into the status region; the `warningShown` latch that existed only to fire that message once is removed.
- **Status line untouched otherwise.** Connect, device-loss, file-rejection and Panic messages keep using the same single `aria-live` region.
- **Tests.** The same-device e2e test now asserts the box is visible and the status region does not carry the warning; the pre-existing tab-order expectations that the player-credit link shifted are corrected.

## Acceptance criteria

- [x] Selecting the same device as monitoring input and output shows the warning box and hides it when the routing diverges again.
- [x] The LCD status bar never shows the "monitoring input and output are the same device" warning.
- [x] No other status message changes, and the status region remains the single `aria-live` region.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass.

## Notes

- The warning box is still shown whenever `monitor.sharesDevice()` is true, including on a reload that restores a shared routing.
- The monitor still starts muted (R10), so the removed status text was never the only feedback safeguard.
