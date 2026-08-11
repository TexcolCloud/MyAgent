# Final Review Fix Report

## Scope

This fix wave closes the final review findings for Pi provider admission and
manual OpenAI-compatible Model Profile runtime persistence.

## Changes

- Native Pi catalog Drivers now advertise bearer credentials only for OpenAI
  and DeepSeek. Every other catalog provider remains visible but is marked
  `unsupported`, so the bearer-only controlled gateway never admits a provider
  whose required header or SDK authentication semantics are not explicitly
  supported.
- New manual `pi/openai-compatible` Profiles persist a complete, server-derived
  Pi runtime contract. The selected protocol maps to `openai-completions` or
  `openai-responses`; the context window comes from the resolved Profile
  context. Manual runtime contracts do not project a synthetic catalog
  candidate ID.
- Pi Responses tool-call item metadata is removed at the adapter boundary so
  the durable tool-call record and continuation retain the provider's original
  `call_id`.
- The fake Responses provider now emits the Responses item lifecycle required
  by Pi, allowing the existing Chat/Responses isolation and restart coverage to
  exercise the Pi path faithfully.

Historical snapshots without `piRuntime` were not changed and continue to use
the legacy runtime router branch.

## TDD Evidence

- RED: catalog allowlist, Anthropic Driver admission, manual Profile runtime,
  manual gateway routing, and Responses provider call-ID cases all failed
  against the pre-fix behavior.
- GREEN focused coverage passed for catalog/control-plane tests, Pi adapter and
  gateway contracts, Responses restart recovery, and the multi-provider E2E
  suite.

## Final Verification

`npm run check` passed on 2026-08-12:

- ESLint passed.
- TypeScript typecheck passed.
- Vitest passed: 83 files / 850 tests; 1 live-provider file and 5 tests were
  skipped by their existing opt-in conditions.
- TypeScript build and migration-copy postbuild step passed.
