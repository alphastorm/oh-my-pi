# Appliance lifecycle

`omp appliance` uses one guarded lifecycle state machine for checksum-pinned NInfer runtimes, private OMP routes, durable predecessor/candidate state, receipts, and exact rollback. A closed adapter set owns only platform operations: `darwin-remote-ssh`, `windows-docker-local`, and `linux-docker-local`.

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

# Managed profiles consume one exact omp-ninfer compatibility authority
omp appliance doctor --profile windows-docker-local \
  --compatibility /path/to/compatibility.json \
  --compatibility-sha256 "$COMPATIBILITY_SHA256" --json

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

`--gpu` accepts `auto`, `rtx5090`, or `rtx4090`. Managed profiles instead require a profile id plus byte-exact `compatibility.json` path and SHA-256. Candidate ports must be between 1 and 65535 and bind to loopback. `benchmark` accepts only `--quick`. Checkpoint operations accept only a 64-character lowercase session SHA-256.

Without `--json`, each command except `support-bundle` prints a short status followed by the same JSON receipt. With `--json`, stdout contains only the receipt. `support-bundle` is always JSON-only. Blocked `doctor` and `plan` results are diagnostic and exit successfully. A blocked or failed install, status, benchmark, checkpoint, or rollback exits nonzero.

`doctor`, `plan`, and `status` do not write appliance state, receipts, secrets, or candidate resources.

## Exact remote lifecycle delegation

Native macOS OMP can delegate the lifecycle to an already-installed exact OMP `18.0.9` client on an SSH host. Profileless `doctor` and `status` remain available for inspection:

```sh
omp appliance doctor --remote windows-gpu-host --remote-wsl Ubuntu-24.04 --port 18089 --json
omp appliance status --remote windows-gpu-host --remote-wsl Ubuntu-24.04 --json
```

Managed actions require the `darwin-remote-ssh` profile and the same byte-pinned compatibility authority used by the remote local profile:

```sh
omp appliance plan qwen3.8 --profile darwin-remote-ssh --remote windows-gpu-host \
  --remote-wsl Ubuntu-24.04 --compatibility /path/to/compatibility.json \
  --compatibility-sha256 "$COMPATIBILITY_SHA256" --json
omp appliance install qwen3.8 --profile darwin-remote-ssh --remote windows-gpu-host \
  --remote-wsl Ubuntu-24.04 --compatibility /path/to/compatibility.json \
  --compatibility-sha256 "$COMPATIBILITY_SHA256" --json
omp appliance benchmark --quick --profile darwin-remote-ssh --remote windows-gpu-host \
  --remote-wsl Ubuntu-24.04 --compatibility /path/to/compatibility.json \
  --compatibility-sha256 "$COMPATIBILITY_SHA256" --json
omp appliance checkpoint save --session-sha256 "$SESSION_SHA256" \
  --profile darwin-remote-ssh --remote windows-gpu-host --remote-wsl Ubuntu-24.04 \
  --compatibility /path/to/compatibility.json --compatibility-sha256 "$COMPATIBILITY_SHA256" --json
omp appliance rollback --profile darwin-remote-ssh --remote windows-gpu-host \
  --remote-wsl Ubuntu-24.04 --compatibility /path/to/compatibility.json \
  --compatibility-sha256 "$COMPATIBILITY_SHA256" --json
omp appliance support-bundle --profile darwin-remote-ssh --remote windows-gpu-host \
  --remote-wsl Ubuntu-24.04 --compatibility /path/to/compatibility.json \
  --compatibility-sha256 "$COMPATIBILITY_SHA256" --json
```

`--remote` accepts one SSH hostname or configured alias. Delegated action channels use non-interactive OpenSSH with agent, X11, and port forwarding explicitly disabled; the separate authenticated loopback adapter retains only its requested `-L` forward while also disabling agent and X11 forwarding. `--remote-wsl` selects one validated WSL distribution; Linux SSH hosts omit it. Before every action, the caller verifies the remote client's exact version, immutable appliance build identity, and delegation protocol. The action then crosses as one bounded base64url-encoded canonical argv document, while the bounded compatibility bytes stream separately on stdin. The caller's private compatibility path never crosses: only the verified, non-secret authority bytes and SHA-256 are sent.

The exact-client manifest is a self-report from the remote OS account. It detects accidental client version or build drift; it is not attestation and does not defend against hostile same-user replacement of the remote `omp` executable. The local authority caller and the selected remote OS account are therefore trusted principals with same-user code-execution authority.

The remote client verifies the authority digest again, writes those bytes with private permissions under a unique temporary operation root, selects the matching `linux-docker-local` or `windows-docker-local` authority profile, and invokes its ordinary local-loopback `ApplianceLifecycle` without `--remote`. That remote local state machine remains the sole owner of artifact download, API-secret creation, candidate/predecessor state, process restart, receipts, interrupted-transaction recovery, and rollback. Temporary bootstrap bytes are removed before the receipt is returned; cleanup failure is a named failed receipt with the underlying effect marked confirmed or uncertain.

Only one bounded JSON receipt is accepted. API keys, secret references, private paths, raw logs, prompts, and model output are rejected at the transport boundary. `support-bundle` returns the lifecycle's sanitized JSON receipt and does not automatically copy an archive; any future archive transfer must be separately requested, bounded, hash-verified, and contain only that secret-free public projection.

Unavailable clients, wrong versions, wrong build identities, authority hash drift, malformed or oversized receipts, timeouts, and cleanup failures are distinct failures. If an action and bootstrap cleanup both fail, the action's failure remains primary while `cleanup: failed` remains visible. A timeout or transport loss after a mutating invocation is reported as an uncertain effect. Do not retry `install`, `rollback`, or checkpoint `save`/`delete` blindly; inspect remote status and let the remote lifecycle recover its durable transaction first. Whether terminating a live SSH action also terminates its remote process remains a required real-SSH acceptance check.

The exact OMP client must already be installed on the trusted remote OS account and available on its non-interactive `PATH`. Installing or upgrading OMP itself over SSH is not owned by this boundary. The compatibility authority must declare each delegated action for both `darwin-remote-ssh` and the selected local-loopback profile; otherwise delegation fails before the lifecycle runs.

## Compatibility authority

The versioned compatibility authority and generated public support matrix belong to `alphastorm/omp-ninfer`. OMP consumes only an artifact deliberately selected and pinned by the trusted local caller and fails on unknown schema versions, profiles, statuses, adapters, transports, commands, capabilities, or runtime identities. Callers and wrappers must never auto-discover, download, or ingest authority bytes or paths from an untrusted remote response, configuration source, or receipt. The supplied SHA-256 proves integrity of the caller-selected bytes, not provenance. The authority binds each profile to its support owner, limitations, lifecycle commands, complete client acceptance receipt, and separate GPU/runtime qualification receipt. OMP does not maintain a second support table.

`qualified`, `preview`, `blocked`, and `unsupported` are distinct. A preview profile requires its complete client acceptance receipt independently of a qualified GPU/runtime receipt; neither substitutes for the other. The existing macOS manual SSH topology remains separate until managed lifecycle acceptance passes.

The closed adapters are independent of GPU identity: native Windows and Linux use local Docker Linux containers over authenticated localhost; macOS uses bounded SSH and authenticated loopback forwarding. Local adapters start no SSH or WSL process. Remote adapters never fall back to local or cloud.

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
2. Persist the exact pending transaction and predecessor before any artifact or process effect.
3. Ask the NInfer-owned lifecycle entrypoint to acquire immutable image/model inputs.
4. Verify byte count and SHA-256 before admitting the immutable refs.
5. Create a private bearer secret under adapter-owned ACL/mode enforcement, never argv or receipts.
6. Prepare a loopback candidate, stop only the exact owned predecessor, and durably record that boundary.
7. Require candidate process health and authenticated NInfer status identity.
8. Run bounded quick qualification against the candidate.
9. Persist a prepared receipt, atomically promote the appliance route, and prove a routed request.
10. Preserve the exact prior installation as the rollback target.

A pre-stop failure retains a resumable transaction and leaves the incumbent untouched. A post-stop failure restores and proves the predecessor before resetting the transaction to its pre-stop boundary; failed restoration stays explicit and blocks another transition. A post-promotion failure restores and proves the prior route before stopping the candidate. OMP preserves the first failure receipt and never destroys the only known runnable service.

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
