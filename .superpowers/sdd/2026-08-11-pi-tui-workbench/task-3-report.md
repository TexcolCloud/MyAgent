# Task 3 Report: Pi-TUI Model Setup Dialogs

## Result

Implemented a reusable `PiTuiPrompt` and model setup screen that delegate the complete model setup lifecycle to the existing `setupModel()` service. The screen does not issue discovery, verification, Promotion, default, or Assignment requests itself.

## Changes

- Added real Pi-TUI 0.73.1 modal composition using `SelectList`, `Editor`, `Box`, `Text`, and `TUI.showOverlay()` compatible handles.
- The registered overlay root owns focus and delegates to its child, allowing Pi-TUI to restore the prior workbench focus when the overlay closes.
- Added masked Secret input. Secret text is never returned by `render()` and the editor value is cleared before the overlay is hidden on both submit and Escape.
- Added a dedicated prompt cancellation signal mapped by `setupModel()` to its existing safe cancelled result.
- Added optional rich prompt choices so Pi catalog candidates have distinct labels and unsupported credential candidates remain visible but disabled. Existing console prompts still receive plain supported identifiers.
- Added a closed, safe setup progress-label union. It contains lifecycle labels only and never includes provider, model, credential, Secret, or server response data.
- Added a structural Admin client contract and `TuiClient.adminRequest()` so the screen can reuse `setupModel()` without exposing tokens or casting to the concrete CLI client.
- Preserved existing interactive CLI prompts, JSON formatting, verification polling, request ordering, mutation checks, and explicit Promotion/Assignment decisions.

## TDD Evidence

RED:

- `npm run test:unit -- test/unit/pi-tui-prompt.test.ts` failed because `src/interfaces/tui/pi-tui-prompt.ts` did not exist.
- `npm run test:integration -- test/integration/model-cli.test.ts test/integration/tui-workbench.test.ts` targeted the absent model setup screen.
- A later Secret-Escape regression failed before cancellation scrub support was added.

GREEN:

- `npm run test:unit -- test/unit/pi-tui-prompt.test.ts`: 5 passed.
- `npm run test:integration -- test/integration/model-cli.test.ts test/integration/tui-workbench.test.ts test/integration/tui-client.test.ts`: 55 passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Full-Suite Residual

`npm test` did not produce a fully green all-repository run on Windows:

1. First completed run: 881 passed, 5 skipped, 1 failed. `fault-boundaries` cleanup hit `e2e_fixture_root_release_timeout` while renaming a shared `%TEMP%` fixture root (`EPERM`).
2. Second completed run: 881 passed, 5 skipped, 1 failed. The prior fault-boundaries suite passed, while a different composed-system e2e backup request transiently returned 500 instead of 201.

Both exact failing cases passed unchanged in isolation:

- `after_sse_write` fault boundary: 1 passed, 16 skipped, 2.228 seconds.
- composed-system managed plaintext containment: 1 passed, 11 skipped, 1.068 seconds.

Neither failure traverses the changed CLI/TUI files. No fixture or unrelated production change was made. Residual risk is the existing Windows shared-temp/e2e contention under the serialized all-suite run; Task 3 focused, static, and build gates are green.
