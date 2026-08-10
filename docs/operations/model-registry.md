# Model Registry Operations

## Prerequisites

Run the service on loopback and configure separate Run and Admin Token Secret references. Registry and Secret lifecycle commands require the Admin Token. Run creation continues to use the Run Token. The CLI calls the HTTP API only; it does not open SQLite or edit configuration files.

Use configuration version 2. It contains `server.bearerToken`, `server.adminToken`, `database`, Agent and Skill roots, and `modelControl` limits. Version 2 does not accept legacy `models:` entries or Agent `model:` fields.

## Initial Setup

Run `myagent model setup` for the guided flow, or use the individual `providers`, `models`, and `agents` commands for automation. The lifecycle order is fixed:

1. Create a Provider Connection and discover its models.
2. Create a Model Profile from a discovered model. If discovery is unsupported, acknowledge manual eligibility and supply the model ID and context-window source explicitly.
3. Start Verification and wait for both the streaming-text and single-Tool-call probes to pass. Verification proposes a Tool Call but never executes it. If endpoint-absence evidence creates an automatic fallback candidate, the CLI follows only the returned fallback operation ID and reports that candidate's fixed protocol and exact revision.
4. Promote the Connection Revision, then promote the terminal passing Profile Revision shown by the CLI. Never promote the earlier failed preferred-protocol candidate.
5. Set the default Profile or assign the exact active Profile Revision to an Agent.

Promotion never moves an existing Agent Assignment. Use `myagent agents set-model` for each deliberate rebind.

## Provider API Key Rotation

Update the Provider Connection with the replacement credential. This creates a new managed Secret Version and a draft Connection Revision. Discover and verify a Profile against the draft, then promote and reassign explicitly. A failed discovery or Verification leaves the active Connection, Profile, Assignment, and old referenced Secret Version unchanged.

Retain the old Secret Version while any revision references it. Destruction is a separate confirmed operation and is rejected while references remain.

## Master-Key Rotation

Use this four-step two-key procedure:

1. Record the current Keyring record revision, retain the old 32-byte key material, and generate a new 32-byte key outside MyAgent.
2. Set `MYAGENT_MASTER_KEY` to the new Base64 key material and `MYAGENT_PREVIOUS_MASTER_KEY` to the old Base64 key material, then restart. Existing Secrets remain readable through the previous key while new managed-Secret writes use the new current key until transactional rotation completes.
3. Run `myagent secrets rotate-master-key --expected-revision <keyring-revision>`. A successful response reports only the re-encrypted row count, the derived current Key ID, and the next Keyring record revision.
4. Remove `MYAGENT_PREVIOUS_MASTER_KEY` and restart. Confirm readiness, access to managed-Secret-backed resources, and creation of a new managed Secret before retiring the old key material.

Never pass master-key material through CLI flags, HTTP payloads, logs, or the database. Supply key material only through the two environment variables. The rotation endpoint accepts only the expected Keyring record revision; use `0` before the first rotation and the `recordRevision` returned by each successful rotation thereafter.

## Backup And Restore

Create an online backup through the authenticated Run API or `myagent backup`. The backup contains SQLite, configuration, and active catalog sources. Managed Secret rows remain encrypted; master keys are not included.

Restore the files to a closed service, configure the matching current and, when needed during rotation, previous key generation, then start the service. A restored database without the matching key remains locally ready but its managed-Secret-backed Provider resources are Locked.

## Locked Providers

`/readyz` reports local service, SQLite, migrations, and worker readiness. It can remain ready while a Provider Connection or Agent model is Locked or unhealthy.

For `model_provider_locked` or `secret_locked`:

1. Read the Provider and Agent resource views with the Admin Token.
2. Confirm the required key generation is configured for the referenced managed Secret Version.
3. During a master-key transition, confirm both current and previous keys are available.
4. Restart after correcting key configuration and retry the resource operation.

Do not diagnose Locked resources by printing ciphertext, key material, provider response bodies, or Authorization headers.

## Retirement And Destruction

Retirement is a reversible lifecycle boundary for new use. Existing exact Assignments retain their referenced revision and continue according to normal availability rules. Retirement does not delete history or Secrets.

Purge removes an unreferenced Connection or Profile after explicit confirmation. Secret destruction is separate, also requires explicit confirmation, and zeroes ciphertext metadata only after no revision references the Secret Version. Use purge and destruction only after retention and recovery requirements have been satisfied.

## Opt-In DeepSeek Smoke

The live smoke is disabled unless both `MYAGENT_DEEPSEEK_BASE_URL` and `MYAGENT_DEEPSEEK_API_KEY` are present. `MYAGENT_DEEPSEEK_MODEL` is optional and defaults to `deepseek-v4-flash`.

Run `npm run test:smoke:live`. The smoke discovers models, creates and verifies a Responses Profile, promotes and assigns it, and completes one no-Tool Run. It checks protocol completion and containment only; it does not assert response prose. Normal tests and CI do not require or request these variables.
