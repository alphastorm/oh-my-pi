# Appliance troubleshooting

Start with read-only evidence. Do not insert an unpublished artifact URL, relax a checksum, start or stop a production service, or change a live route to make a blocker disappear.

```sh
omp appliance doctor --json
omp appliance plan qwen3.8 --gpu auto --json
omp appliance status --json
omp appliance support-bundle
```

The support bundle prints redacted JSON locally and never uploads it.

## Plan says the profile is not installable

This is the expected current result for both public profiles.

- RTX 5090 source provenance is remediated, but the image build/live candidate is held; runtime/model release fields and the public receipt are absent.
- RTX 4090 K3 stopped at the first restart red; the corrected MTP0 package candidate is locally verified but fresh live K3, MTP3/K5, and the public release asset/receipt are absent.
- D6 source/host contracts pass; the exact `sm_120a` binary/live restart proof is blocked on the held RTX 5090 lane.

A blocked `doctor` or `plan` exits successfully because it is diagnostic. Do not manufacture a URL, checksum, or qualification receipt. Wait for the exact public registry entry to become checksum-complete and installable.

## `status` exits nonzero on an uninstalled host

`status` is read-only but a blocked result exits nonzero. Inspect the JSON `status` and `details` fields. If there is no active installation, use `plan`; do not treat the exit code as evidence that a service should be started manually.

## Host does not match the selected profile

Check the blocker emitted by `doctor` or `plan`:

- `rtx5090-linux` requires Linux, an RTX 5090 with at least 32 GiB VRAM, compute capability 12.0 when reported, Docker, NVIDIA Container Toolkit, and secure secret storage.
- `rtx4090-windows` requires Windows, an RTX 4090 with at least 24 GiB VRAM, compute capability 8.9 when reported, the Windows runtime prerequisites, and secure secret storage.

`--gpu auto` selects only a detected supported GPU. Selecting a profile flag cannot make an incompatible host valid.

## Authenticated status fails

OMP requires a successful bearer-authenticated `/v1/ninfer/status` response whose strict schema and identities match the persisted installation. Common causes are:

- candidate process unavailable;
- missing or unreadable private bearer secret;
- served model mismatch;
- binary, artifact, config, profile, or request-shape drift;
- a route that is not loopback `/v1` or whose port does not match.

Do not bypass status or register the route manually. Preserve private candidate logs for diagnosis. Ordinary receipts intentionally omit endpoint URLs, secrets, hostnames, and private paths.

## Warm session owner is unavailable or changed

The default is to fail explicitly:

```sh
omp config set appliance.coldLocalFallback false
```

This protects warm affinity and makes topology failure visible. If policy permits losing warmth while remaining local, enable:

```sh
omp config set appliance.coldLocalFallback true
```

OMP may then choose another authenticated, compatible **local** endpoint, record `warm_owner_unavailable`, and replay the full transcript. This setting never enables cloud fallback, a different model, or an unverified endpoint. Set it back to `false` when the exception is no longer wanted.

## A previous response is stale or missing

OMP recognizes the bounded stale-chain error, clears the previous response ID, and retries exactly once with the full authoritative transcript. The replay has no `previous_response_id`, so another chained replay cannot loop.

If the full replay also fails, diagnose that direct error. Do not suppress it and do not switch provider implicitly. The provider snapshot is disposable; the OMP transcript remains authoritative.

## Checkpoint save returns HTTP 409

HTTP 409 `checkpoint_unavailable` means the session has no complete checkpointable response. Complete and publish the turn before saving. Do not checkpoint a partial or failed response.

The save operation must be:

```text
POST /v1/ninfer/checkpoints
{"session_sha256":"<64 lowercase hex>"}
```

Status is `GET /v1/ninfer/checkpoints/<digest>/status`; delete is `DELETE /v1/ninfer/checkpoints/<digest>`. Status/delete carry no request body. If a client uses a digest path for save or omits the JSON body, it is using the wrong contract.

## Checkpoint is missing, corrupt, incompatible, disabled, or deleted

Use full replay from the OMP transcript. Do not treat checkpoint state as the conversation and do not switch to cloud. Confirm that the runtime, model artifact, config, deployment profile, and authenticated endpoint identity match before interpreting a checkpoint as restorable.

D6 live NInfer restart proof is blocked on the held Linux/RTX 5090 build and service lane. Passing source, CLI, API, and host-side tests do not establish runtime restart durability.

## Benchmark refuses to run

The only supported appliance benchmark mode is:

```sh
omp appliance benchmark --quick --json
```

It requires a validated active installation and writes a receipt. Use the three-fixture budget in [Qualification](./qualification.md); do not expand a blocked release into a broad model or kernel campaign.

## Install failed before promotion

OMP should stop the isolated candidate, remove its secret, and leave the incumbent route unchanged. Review the failed receipt and private candidate logs. Do not delete retained diagnostics before identifying whether acquisition, digest verification, launch, status, qualification, or route proof failed.

## Install failed after promotion

OMP attempts to restore and prove the prior route before stopping the candidate. If proof is ambiguous, it preserves runnable candidates and secrets rather than deleting the only working service. Do not manually tear down either candidate until route and rollback state are understood.

## Rollback is blocked or fails proof

Rollback requires a preserved target. It must prove direct health, restore the route atomically, and prove a routed request. A failed proof is not a successful rollback. Preserve both runtimes and diagnostics; never substitute a cloud route as rollback.

## Support output seems too sparse

That is deliberate. Public-safe receipts omit prompts, generated text, raw IDs, secrets, hostnames, usernames, endpoint URLs, argv, environment, and private paths. Missing evidence is `null` or blocked rather than inferred.

Private service logs may contain additional implementation diagnostics. Review and redact them manually before sharing; `support-bundle` does not upload or automatically publish those logs.

See [Security and privacy](./security.md), [Appliance lifecycle](./appliance-lifecycle.md), and [Session continuation](./session-continuation.md).
