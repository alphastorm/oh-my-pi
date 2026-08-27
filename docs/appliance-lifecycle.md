# Appliance lifecycle

`omp appliance` manages a checksum-pinned local NInfer runtime, its private OMP route, fleet membership, durable checkpoint requests, and rollback evidence. Every mutating step is fail-closed and receipt-backed.

> [!IMPORTANT]
> The public RTX 5090 and RTX 4090 profiles are currently non-installable. Read-only inspection works, but installation must remain blocked until each exact release artifact, checksum, launch descriptor, and qualification receipt is published. See [Qualification](./qualification.md).

## Command contract

```sh
# Read-only inspection
omp appliance doctor
omp appliance doctor --json
omp appliance plan qwen3.8 --gpu auto
omp appliance plan qwen3.8 --gpu rtx5090 --json
omp appliance status --json

# Transactional lifecycle, after a profile becomes installable
omp appliance install qwen3.8 --gpu auto
omp appliance benchmark --quick --json
omp appliance rollback --json

# Durable checkpoint contract, after D6 qualification
omp appliance checkpoint save --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
omp appliance checkpoint status --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
omp appliance checkpoint delete --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json

# Redacted local support receipt; never uploads
omp appliance support-bundle
```

`--gpu` accepts `auto`, `rtx5090`, or `rtx4090`. Candidate ports must be between 1 and 65535 and bind to loopback. `benchmark` accepts only `--quick`. Checkpoint operations accept only a 64-character lowercase session SHA-256; `--profile` may be `rtx5090-linux` or `rtx4090-windows`.

Without `--json`, each command except `support-bundle` prints a short status followed by the same JSON receipt. With `--json`, stdout contains only the receipt. `support-bundle` is always JSON-only. Blocked `doctor` and `plan` results are diagnostic and exit successfully. A blocked or failed install, status, benchmark, checkpoint, or rollback exits nonzero.

`doctor`, `plan`, and `status` do not write appliance state, receipts, secrets, or candidate resources.

## Public profile state

| Profile | Registry target | Current release state |
| --- | --- | --- |
| `rtx5090-linux` | Linux, `sm_120a`, at least 32 GiB, BF16 KV, MTP3, 131,072 context, vision, stateful Responses | Source provenance remediated; image build/live receipt held; asset URL/checksum, model URL, and public receipt absent; non-installable |
| `rtx4090-windows` | Windows, `sm_89`, at least 24 GiB, `rk2v4-e8` KV, MTP0, 131,072 context, stateful Responses, durable-checkpoint capability | K3 restart red closed locally in a remediated package candidate; fresh MTP0 live qualification, MTP3/K5, public release asset/receipt, and D6 binary/live proof remain absent; non-installable beta |

Both expose the exact served model `q38-ninfer` only after an installation passes validation. See [RTX 5090](./rtx5090.md) and [RTX 4090](./rtx4090.md) for profile details.

## Planning

`doctor` records content-safe host facts and profile blockers. `plan` combines those facts with the public registry and chosen GPU, but it does not resolve an unpublished artifact or create resources.

A plan can proceed to install only when:

- the host OS, GPU architecture, VRAM, runtime prerequisites, and secure secret storage match;
- the profile is marked installable;
- runtime and model assets have HTTPS locations, sizes, and SHA-256 digests;
- the launch descriptor and public qualification receipt are present;
- all release facts agree.

Today's expected plan is blocked. That is the intended safety result, not an invitation to fill the missing fields locally.

## Install transaction

`install` holds one appliance transaction lock and performs these steps in order:

1. Re-inspect the host and requested loopback port.
2. Download every released asset to a temporary file over HTTPS.
3. Verify byte count and SHA-256 before placing the bytes in the content-addressed store.
4. Create a private bearer secret and pass it through the child environment, never argv or receipts.
5. Create and start an isolated loopback candidate while leaving the incumbent running.
6. Require candidate process health and authenticated NInfer status identity.
7. Run bounded quick qualification against the candidate.
8. Persist a prepared receipt, atomically promote the appliance route, and prove a routed request.
9. Preserve the exact prior installation as the rollback target.

A failure before promotion stops the candidate, removes its secret, and leaves the incumbent route unchanged. A post-promotion failure restores and proves the prior route before stopping the candidate. If the prior route cannot be proven, OMP preserves the candidate and its secret rather than destroying the only known runnable service.

Installing an already-active exact registry match is idempotent: OMP proves health and does not redownload assets, create another candidate, or rewrite route state.

## Active route and fleet

An exact active installation registers the private `ninfer-appliance` provider ahead of model selection. Public aliases map to the wire model `q38-ninfer` over OpenAI Responses. Persisted installations are accepted only if release, runtime digest, model digest, served model, aliases, loopback route, secret, and public profile all match.

The fleet selector authenticates each compatible endpoint's status before use. A warm endpoint fingerprint wins. Fresh foreground work prefers RTX 5090; background work prefers RTX 4090, with RTX 5090 reservation enabled by default. Saturation, explicit profile alias, vision capability, and context capacity are evaluated before load selection.

Corrupt, future-version, non-loopback, incomplete-release, or registry-drifted state fails closed for explicit local and endpoint-affined sessions. An unbound session already selecting a hosted model logs unavailable appliance state and continues on that selected provider. A warm-owner failure does not fall through to cloud. Optional cold-local fallback selects only a different healthy compatible local appliance and requires full replay.

## Status

`status` reads the persisted active/fleet/rollback state and performs authenticated endpoint observation. A healthy result is tied to the exact promoted profile, served model, endpoint fingerprint, and artifact. Scheduler/cache counters are observations, not qualification claims.

Status output and receipts exclude endpoint URLs, API keys, hostnames, private paths, prompts, and generated text. Missing observation is a blocker or `null`, never an inferred success.

## Checkpoint lifecycle

OMP exposes three operations for a checkpoint-capable installed profile:

| Operation | NInfer request |
| --- | --- |
| Save | `POST /v1/ninfer/checkpoints` with JSON `{"session_sha256":"<digest>"}` |
| Status | `GET /v1/ninfer/checkpoints/<digest>/status` |
| Delete | `DELETE /v1/ninfer/checkpoints/<digest>` |

All requests use the installation bearer token. Save uses `Content-Type: application/json`; status and delete have no body. The client validates `artifact_type: ninfer_session_checkpoint_status`, typed fields, a valid state, and an operation-appropriate state. HTTP 409 on save is reported as `checkpoint_unavailable` when the session has no complete checkpointable response.

Checkpoint state remains disposable. Missing, incompatible, corrupt, disabled, or deleted state never supersedes the OMP transcript. D6 requires a matching NInfer build plus live process restart evidence before this lifecycle is a release claim. See [Session continuation](./session-continuation.md).

## Rollback

`rollback` requires a preserved rollback target. It starts the prior runtime if necessary, proves direct health, atomically restores its route, and proves a routed request before stopping the outgoing candidate.

If routed proof fails, OMP restores and re-proves the outgoing route when possible. Both runtimes and diagnostic files remain available on an unproven recovery. Rollback never switches to cloud or relaxes checksum/profile validation.

## State and receipts

The default root is `~/.omp/agent/appliance`; `PI_CODING_AGENT_DIR` changes the parent agent directory.

- `state.json` — versioned active, fleet, and rollback installations, written atomically with revision checks.
- `receipts/<action>-<receipt-id>.json` — machine-readable lifecycle receipts.
- `secrets/<installation-id>.key` — private bearer secrets; mode `0600` on POSIX.
- `artifacts/<kind>/<sha256>` — content-addressed verified assets.
- `candidates/<candidate-id>/service.json` — private launch manifest without the bearer secret.
- `candidates/<candidate-id>/service.log` — retained runtime diagnostics.

Receipt schema version 1 includes `receiptId`, `action`, `status`, `timestamp`, and content-safe `details`. Status is `ok`, `blocked`, `failed`, or `rolled-back`. A support receipt never uploads and must not be confused with private service logs.

Start with the [Quickstart](./quickstart.md), then use [Troubleshooting](./troubleshooting.md) for blocked or failed operations.
