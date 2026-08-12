# DeepSeek Responses Compatibility Design

**Status:** Approved by the Operator on 2026-08-13

## Goal

Make DeepSeek `deepseek-v4-flash` a supported Pi-AI Responses tool-calling
path without weakening the Model Registry, Provider Egress Gateway, Tool
Policy, Approval, immutable revision, or secret-handling boundaries.

## Problem

The Model Verification tool probe requires `toolChoice: "required"` and an
exactly-one `capability_probe` Tool Call. Pi-AI `0.73.1` uses
`openai-responses` for compatible Responses requests, but its serializer does
not emit `tool_choice: "required"`. It also produces fields that are not the
minimal documented DeepSeek Responses request form. The project must own this
compatibility behavior instead of relying on undocumented tolerance or an
upstream release.

## Scope

- Add a versioned Provider Compatibility Contract to Pi runtime contracts.
- Publish an explicit native DeepSeek Responses Compatibility Variant.
- Transform only that variant's Pi-generated Responses payload into the
  documented DeepSeek request shape.
- Keep the existing single Tool Call, Tool Policy, and Approval lifecycle.
- Preserve legacy revisions and Run snapshots without migration or rewrite.
- Prove serializer, gateway, continuation, stream-boundary, and privacy
  behavior through deterministic tests; add an opt-in live smoke check.

## Non-Goals

- Do not modify `node_modules` or fork Pi-AI.
- Do not infer compatibility from a Base URL, host name, or model ID.
- Do not add automatic fallback to Chat Completions, another protocol, model,
  or provider.
- Do not change existing Chat Completions candidates or historical Run
  semantics.
- Do not execute a real Tool in the live-provider smoke test.

## Runtime Contract

`invocationProtocol` remains `pi_ai`. The nested Pi API form is part of an
immutable `PiRuntimeContract`, which captures the exact API and a strong,
versioned `providerCompatibilityContract` value:

```ts
type ProviderCompatibilityContract = "none" | "deepseek-responses-v1";
```

New native candidate-based Profile Revisions and the Run snapshots derived
from them persist this value. A stored Pi runtime contract without the field
is a legacy contract and reads as `"none"`; it is not written back. Any
unknown value is invalid persisted configuration and fails closed as the
existing redacted `invalid_model_profile` path. A Run must use its captured
contract and must never consult mutable catalog metadata to decide
compatibility behavior.

## Catalog Identity

The existing Pi catalog entry remains available:

| Candidate ID | Display name | Provider model ID | Pi API | Compatibility contract |
| --- | --- | --- | --- | --- |
| `pi/deepseek:deepseek-v4-flash` | Existing Pi catalog display name | `deepseek-v4-flash` | `openai-completions` | `none` |
| `pi/deepseek:deepseek-v4-flash-responses` | `DeepSeek V4 Flash (Responses)` | `deepseek-v4-flash` | `openai-responses` | `deepseek-responses-v1` |

The two candidates intentionally share a provider model ID. Catalog candidate
resolution and Profile response projection therefore use an exact candidate
identity or all immutable invocation fields, not only `driverId + modelId`.
An old runtime contract without a compatibility field resolves only to the
legacy Pi catalog candidate where an unambiguous exact match exists.

## Request Translation

For `deepseek-responses-v1` only, the Pi-AI payload hook emits the DeepSeek
Responses minimum request form before the request leaves the loopback Provider
Egress Gateway:

- Retain `model`, `input`, and `stream`.
- Retain `tools` only when the Model Request contains tools.
- Remove `store`.
- Remove `parallel_tool_calls`.
- Remove `strict` from every tool definition.
- Add `tool_choice: "required"` only when the request purpose is
  `verification_tool` and the request contains tools.
- Do not add `tool_choice` to normal Runs or Tool-result continuation
  requests.

The compatibility transform applies to the outgoing Pi request only; it does
not alter the local canonical Model Request, tool schema, Model Chunk, or
Provider Egress Gateway credential policy. Other Pi catalog candidates and
manual OpenAI-compatible Profiles retain their current request behavior.

## Discovery and Upgrade Lifecycle

The Compatibility Variant is catalog metadata, not proof of a live endpoint.
An Operator may use the official DeepSeek URL or an Operator-owned compatible
proxy URL, but must still discover `deepseek-v4-flash`, create or revise a
Profile with the explicit Responses Variant, complete Model Verification,
explicitly promote the verified Revision, and explicitly assign it to an
Agent. Existing Chat Completions Profile Revisions, verified Revisions,
Assignments, and captured Runs remain unchanged.

## Tool Call Boundary

Model Verification succeeds for tool capability only when the attempt produces
exactly one valid `capability_probe` Tool Call. A completed probe without that
call is `tool_call_unsupported`. A malformed Tool Call, malformed stream, or
more than one distinct Tool Call is a `model_protocol_error`. Multiple calls
are rejected before the system can create a Tool Proposal, Approval, or Tool
execution request. A valid single Tool Call continues through the existing
Tool Policy and exact-arguments Approval mechanism.

## Failure and Privacy Rules

- Unknown compatibility contracts and malformed persisted contracts fail
  closed; they cannot fall back to generic Pi behavior.
- Request-shape and stream-shape incompatibilities use the existing redacted
  `model_protocol_error` result.
- No raw provider request body, response body, authorization header, route
  capability, or Secret may be included in HTTP, SSE, TUI, verification,
  audit, test snapshots, or logs.
- The Provider Egress Gateway remains the only provider network route. Pi-AI
  receives a loopback route and opaque route capability, never a real provider
  Base URL or Secret.

## Verification

Deterministic tests use a local loopback server and cover:

1. Pi-AI's real HTTP serializer followed by the compatibility transformation.
2. Provider Egress Gateway routing and no direct-provider bypass.
3. Exact catalog candidate selection and Profile response projection for the
   shared DeepSeek model ID.
4. Legacy contracts without the new field, unknown-contract rejection, and
   immutable revision/snapshot recovery.
5. Tool-result continuation, malformed stream rejection, multiple-Tool-Call
   rejection before Approval, and no raw payload leakage.

An opt-in DeepSeek smoke test uses the existing environment-only credential
chain. It pins the explicit Responses Variant and `deepseek-v4-flash`, runs
full verification including the Tool probe, then performs one no-Tool Run. It
does not execute a real Tool and is excluded from normal CI.

## Decisions Recorded Elsewhere

- [ADR 0023](../../adr/0023-enforce-pi-ai-egress-through-a-loopback-gateway.md)
  defines the egress boundary.
- [ADR 0024](../../adr/0024-stabilize-pi-provider-drivers-and-runtime-versions.md)
  defines stable Driver identities and Pi version discipline.
- [ADR 0025](../../adr/0025-version-provider-specific-responses-compatibility.md)
  records this Provider-specific compatibility decision.
