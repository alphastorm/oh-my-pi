# Local model appliance

`omp appliance` manages a checksum-pinned local NInfer model service and the OMP route that selects it. The appliance surface is fail-closed: a registry profile is installable only when its runtime and model assets, SHA-256 digests, launch descriptor, and public qualification receipt are all present.

## Commands

```sh
# Read-only host and artifact inspection
omp appliance doctor
omp appliance doctor --json

# Read-only transaction plan
omp appliance plan qwen3.8 --gpu auto
omp appliance plan qwen3.8 --gpu rtx5090 --port 8000 --json

# Transactional operations
omp appliance install qwen3.8 --gpu auto
omp appliance status --json
omp appliance benchmark --quick --json
omp appliance rollback --json
```

`doctor`, `plan`, and `status` do not write appliance state, receipts, secrets, or candidate resources. `benchmark` accepts only `--quick`; it runs the bounded qualification cases and writes a receipt. `--gpu` accepts `auto`, `rtx5090`, or `rtx4090`. Candidate ports must be between 1 and 65535 and bind to loopback.

Without `--json`, each command prints a short status followed by the same JSON receipt. With `--json`, stdout contains only the receipt. A blocked `doctor` or `plan` exits successfully because the result is diagnostic. Blocked mutating operations and failed operations exit nonzero.

## Registry profiles

### RTX 5090 Linux

| Field | Value |
| --- | --- |
| Model | `qwen3.8-27b` |
| Profile | `rtx5090-linux` |
| Runtime | `ninfer` |
| Architecture | `sm_120a` |
| Minimum VRAM | 32 GiB |
| Model SHA-256 | `eec39564993d6e9c7d5e383382a760f093465c9d163ec9a1bd6b80199514bf3e` |
| Context / max output | 131072 / 32768 tokens |
| KV dtype / speculation | `bf16` / `mtp3` |
| Concurrency | 1 |
| Protocol | OpenAI Responses |
| Capabilities | tools, reasoning, thinking history, stateful Responses, vision |
| Release identity | `v0.1.0-qwen38-5090` |
| Served model | `q38-ninfer` |
| Aliases | `local-max`, `local-fast`, `local-batch`, `qwen38-5090` |

The registry identity is present, but installation remains blocked until the NInfer runtime URL and checksum, Qwen3.8 artifact URL, and public NInfer qualification receipt are published. `doctor` and `plan` report those blockers without changing local state.

### RTX 4090 Windows beta

The `rtx4090-windows` profile is unavailable until its release artifact and Workstream K public qualification receipt are published. OMP does not infer RTX 5090-only vision, MTP, or stateful-Responses capabilities for this profile.

## Install transaction

`install` holds a single appliance transaction lock and performs these steps in order:

1. Re-inspect the host and candidate port.
2. Download each released asset over HTTPS to a temporary file and verify its byte count and SHA-256 digest.
3. Create a private bearer secret; the secret is passed through the child environment, never argv or receipts.
4. Create and start an isolated loopback candidate while leaving the incumbent running.
5. Require candidate health, protocol, and bounded quick-qualification success.
6. Persist a prepared receipt, atomically promote the appliance route, and prove a routed request.
7. Preserve the exact prior installation as the rollback target.

A failure before promotion stops the candidate, removes its secret, and leaves the incumbent route unchanged. A post-promotion failure restores and proves the prior route before stopping the candidate. If the prior route cannot be proven, OMP preserves the candidate and its secret rather than destroying the only known runnable service.

Installing an already-active, exact registry match is idempotent: OMP proves its health and does not download assets, create another candidate, or rewrite route state.

## Rollback

`rollback` requires a preserved rollback target. It starts the prior runtime if necessary, proves direct health, atomically restores its route, and proves a routed request before stopping the outgoing candidate. If routed proof fails, OMP restores and re-proves the outgoing route when possible; both runtimes and diagnostic files remain available on an unproven recovery.

Candidate directories and service logs are retained for diagnosis. Receipt and status output exclude bearer secrets, secret paths, and resolved private launch paths.

## Active model routing

An active installation registers the `ninfer-appliance` provider before model selection. The public aliases continue to send the exact wire model `q38-ninfer` over OpenAI Responses. Stateful continuation is enabled only for a published profile that declares `stateful-responses` and whose release, runtime digest, model digest, served model, aliases, loopback URL, and authentication secret exactly match persisted state.

Corrupt, future-version, non-loopback, incomplete-release, or registry-drifted state is rejected instead of silently falling back to another endpoint or model. The validation error is surfaced before model selection.

## State and receipts

The default root is `~/.omp/agent/appliance`; `PI_CODING_AGENT_DIR` changes the parent agent directory.

- `state.json` — versioned active and rollback installations, written atomically with revision checks.
- `receipts/<action>-<receipt-id>.json` — machine-readable transaction receipts.
- `secrets/<installation-id>.key` — private bearer secrets, mode `0600` on POSIX.
- `artifacts/<kind>/<sha256>` — content-addressed verified assets.
- `candidates/<candidate-id>/service.json` — private launch manifest without the bearer secret.
- `candidates/<candidate-id>/service.log` — retained runtime diagnostics.

Receipt schema version 1 includes `receiptId`, `action`, `status`, `timestamp`, and content-safe `details`. Status is one of `ok`, `blocked`, `failed`, or `rolled-back`.
