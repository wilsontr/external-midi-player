# T19: Ableton-style volume knob drag

- **ID**: T19
- **Milestone**: After the MVP
- **Status**: pending
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

- [ ] Dragging up increases the volume and dragging down decreases it; the change is relative to the value at press, so a click never jumps the volume to the pointer position.
- [ ] A full-height drag covers the whole 0–100 range and the value clamps at both ends.
- [ ] Shift-drag moves in finer steps.
- [ ] Horizontal movement alone leaves the value unchanged.
- [ ] A drag that leaves the knob keeps tracking (pointer capture) and ends cleanly on release or `pointercancel`.
- [ ] Dragging causes no page scroll and no text selection, including at a 360 px touch width.
- [ ] Keyboard and assistive technology are unchanged: the range input takes focus, the arrow/Home/End keys still adjust the value, `aria-valuetext` updates and the focus ring remains visible.
- [ ] The knob rotation, the volume readout and the stored volume follow the new interaction; mute, level metering and audio routing are untouched.
- [ ] Playwright covers the new gestures; `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- **Why.** A round knob that responds to horizontal motion (the transparent range input's native drag) is the one control on the faceplate that does not match either the hardware or the DAW idiom. A vertical relative drag is what Ableton Live, Logic and most plug-ins use, and it removes the click-jump where pressing the knob snapped the level to the press point.
- **Approach.** Keep `input[type=range]` for keyboard, screen readers and persisted state; disable only its pointer handling (e.g. `pointer-events: none` on the input while the knob surface owns `pointerdown`, or `preventDefault` on the native pointer sequence) and drive the input's `value` from the vertical delta through the existing `input` listener. Do not replace the input with a `div`: the keyboard path and the accessible name are part of R10.
- **Sensitivity is a judgement call.** ~120 px for the full range and Shift for fine adjustment are starting points; if the knob feels too fast in review, tune the constant rather than adding acceleration.
- **Touch.** `touch-action: none` must be scoped to the knob so the rest of the page still scrolls; a tap (no movement) must stay inert. Pointer capture covers a finger that slides off the knob.
- **Out of scope.** Double-click/tap to reset to the default level (Ableton's own behaviour differs by device), mouse-wheel adjustment, and mapped MIDI control of the monitor level. Wheel over the rack is page scroll today and stays that way.
- **No data changes.** Volume is already persisted by name/origin; this ticket changes only how the value is produced, not what is stored or how it is restored.
