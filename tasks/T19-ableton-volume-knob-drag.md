# T19: Ableton-style volume knob drag

- **ID**: T19
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: T11, T15
- **Modules**: `src/ui.ts`, `src/styles.css`, `tests/e2e/volume-knob.spec.ts`, `tests/e2e/t11-faceplate.spec.ts`, `README.md`
- **Requirements**: R10

## Objective

Make the monitor volume knob behave like a DAW knob: press anywhere on it and drag **up to increase, down to decrease**, with the change taken from the pointer delta rather than the horizontal range input's thumb position. The control should feel like the hardware it represents instead of a slider rotated under a round cap.

## Scope

- **Relative vertical drag.** On `pointerdown` record the value and the pointer's `clientY`; on `pointermove` set the volume from `startValue + (startY − clientY) × sensitivity`. A press without movement changes nothing (no click-jump to the pointer position). Horizontal movement alone does not change the value.
- **Travel and fine mode.** Pick one documented sensitivity constant (suggested: the full 0–100 range over ~120 px, roughly the knob's visual height) and clamp at both ends. Shift-drag uses a finer multiplier (about ¼ speed) for trimming.
- **Pointer plumbing.** `setPointerCapture` so a drag keeps working outside the knob; end on `pointerup`/`pointercancel`; ignore secondary pointers; no text selection or page scroll while dragging (`touch-action: none` on the grab area, `user-select: none` for the duration); restore the grab cursor afterwards.
- **Keep the range input.** `#monitor-volume` stays the accessible control and the single source of truth. It keeps focus, the arrow/Home/End/Page keys, its label and `aria-valuetext`, and its focus ring; only the native pointer behaviour is replaced. The knob's `--turn` rotation and the stored volume continue to follow the input's value.
- **Tests.** A Playwright spec that drags up/down with `page.mouse` and asserts the delta, no change on a press/release without movement, no change on horizontal drag, fine mode with Shift, clamping at 0 and 100, pointer capture past the knob, and no scroll at 360 px. Keep the keyboard/SR assertions in the faceplate spec and add the new interaction there only if it fits its theme.
- Update `README.md` behaviour notes and the task index.

## Acceptance criteria

- [x] Dragging up increases the volume and dragging down decreases it; the change is relative to the value at press, so a click never jumps the volume to the pointer position.
- [x] A full-height drag covers the whole 0–100 range and the value clamps at both ends.
- [x] Shift-drag moves in finer steps.
- [x] Horizontal movement alone leaves the value unchanged.
- [x] A drag that leaves the knob keeps tracking (pointer capture) and ends cleanly on release or `pointercancel`.
- [x] Dragging causes no page scroll and no text selection, including at a 360 px touch width.
- [x] Keyboard and assistive technology are unchanged: the range input takes focus, the arrow/Home/End keys still adjust the value, `aria-valuetext` updates and the focus ring remains visible.
- [x] The knob rotation, the volume readout and the stored volume follow the new interaction; mute, level metering and audio routing are untouched.
- [x] Playwright covers the new gestures; `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- **Why.** A round knob that responds to horizontal motion (the transparent range input's native drag) is the one control on the faceplate that does not match either the hardware or the DAW idiom. A vertical relative drag is what Ableton Live, Logic and most plug-ins use, and it removes the click-jump where pressing the knob snapped the level to the press point.
- **Approach.** Keep `input[type=range]` for keyboard, screen readers and persisted state; disable only its pointer handling (e.g. `pointer-events: none` on the input while the knob surface owns `pointerdown`, or `preventDefault` on the native pointer sequence) and drive the input's `value` from the vertical delta through the existing `input` listener. Do not replace the input with a `div`: the keyboard path and the accessible name are part of R10.
- **Sensitivity is a judgement call.** ~120 px for the full range and Shift for fine adjustment are starting points; if the knob feels too fast in review, tune the constant rather than adding acceleration.
- **Touch.** `touch-action: none` must be scoped to the knob so the rest of the page still scrolls; a tap (no movement) must stay inert. Pointer capture covers a finger that slides off the knob.
- **Out of scope.** Double-click/tap to reset to the default level (Ableton's own behaviour differs by device), mouse-wheel adjustment, and mapped MIDI control of the monitor level. Wheel over the rack is page scroll today and stays that way.
- **No data changes.** Volume is already persisted by name/origin; this ticket changes only how the value is produced, not what is stored or how it is restored.

### Decisions as implemented

- **Pointer ownership.** The range input is `pointer-events: none` and `.knob-wrap` owns the gesture, because a native range drag cannot be reliably suppressed across engines by `preventDefault` alone. To keep click-to-focus, `pointerdown` on the wrap calls `volumeSlider.focus()`; the keyboard, the accessible name (`Volume`, from the `<label for>`) and the focus ring (`.knob-input:focus-visible + .knob`) are unchanged.
- **Accumulation, not read-back.** The drag keeps its own continuous value and only writes the rounded percentage into the input. Reading the input back each move would dead-zone slow drags: at 120 px for 0–100, one pixel is 0.83 points, which rounds back to the same integer.
- **Sensitivity.** `KNOB_TRAVEL_PX = 120` (about 1.3 knob heights on the rendered faceplate) and `KNOB_FINE_SCALE = 0.25`, both module constants in `ui.ts` so review feedback tunes one number.
- **Clamping is immediate.** The accumulated value clamps at 0/100, so reversing a drag at either end responds at once instead of unwinding the overshoot.
- **Gesture end.** `pointerup`, `pointercancel` and `lostpointercapture` all end the drag; `pointerdown` ignores non-primary buttons and a second pointer, and a release without movement leaves the level untouched.
- **No selection or scroll.** `touch-action: none` is scoped to `.knob-wrap`, `pointerdown` is `preventDefault`ed, and `body.knob-dragging` (set for the duration) carries `user-select: none` so a drag across the page selects nothing.
- **Tests.** `tests/e2e/volume-knob.spec.ts` (10 cases, Chromium and Firefox) covers the relative delta and no press-jump, full travel and both clamps, Shift trim, horizontal-only drags, capture past the knob, the secondary button, click-to-focus plus keys and the tab stop, knob rotation/gain/stored volume, and no scroll or selection at 360 px. The T11 faceplate spec keeps the range-input and arrow-key assertions unchanged.
