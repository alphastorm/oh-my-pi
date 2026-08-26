# Local appliance quickstart

OMP's local appliance keeps the canonical coding transcript in OMP while NInfer provides private, disposable acceleration. Routing is fail-closed: an appliance failure does not switch the request to a cloud provider, another model, or an unverified endpoint.

> [!IMPORTANT]
> Both public Qwen3.8 appliance profiles are currently non-installable. The commands in the first section are useful now and report the missing release evidence truthfully. Do not bypass those blockers with an unpublished URL or checksum.

## Inspect without changing anything

```sh
omp appliance doctor --json
omp appliance plan qwen3.8 --gpu auto --json
omp appliance status --json
```

`doctor`, `plan`, and `status` do not write appliance state, receipts, secrets, or candidate resources. A blocked `doctor` or `plan` is diagnostic and exits successfully. A blocked `status` exits nonzero.

The expected current result is blocked:

- **RTX 5090 Linux:** source provenance is remediated, but the isolated image build is held; the runtime asset and checksum, public qualification receipt, and model artifact URL are not published.
- **RTX 4090 Windows beta:** K3 stopped on its first restart red. The root fix and remediated MTP0 package candidate pass local/no-service checks, but fresh live K3, MTP3/K5, and the public release artifact/receipt are absent. MTP0 remains the incumbent.
- **Durable restart:** OMP and NInfer implement the source contract and host checks pass, but the exact `sm_120a` binary and live restart proof are blocked on the held RTX 5090 lane.

See [Qualification](./qualification.md) for the release gates and evidence rules.

## Install only after the registry opens

When `plan` reports an installable, checksum-complete profile, use the same model and GPU selection for the transaction:

```sh
omp appliance install qwen3.8 --gpu auto
omp appliance status --json
omp appliance benchmark --quick --json
```

Do not run `install` against today's blocked profiles. OMP will refuse them rather than invent an artifact location or trust an unqualified binary.

Installation is transactional. OMP downloads only registry-pinned HTTPS assets, verifies size and SHA-256, starts an isolated loopback candidate, runs bounded qualification, promotes only after routed proof, and preserves the exact prior installation for rollback. Read [Appliance lifecycle](./appliance-lifecycle.md) before operating a released profile.

## Keep local failure local

The defaults protect warm sessions and reserve the RTX 5090 for foreground work:

```sh
omp config set appliance.coldLocalFallback false
omp config set appliance.foregroundReservation true
```

With `appliance.coldLocalFallback` set to `false`, a missing or changed warm owner fails explicitly. Setting it to `true` permits selection of another **local, authenticated, compatible** appliance and a full transcript replay; it never permits cloud fallback.

Use the profile-specific aliases when placement must be explicit:

- `qwen38-5090` selects the RTX 5090 profile.
- `qwen38-4090` selects the RTX 4090 profile.
- `local-max`, `local-fast`, and `local-batch` remain public aliases for the exact served model `q38-ninfer` after a validated profile is installed.

## Durable checkpoint commands

After an installed profile both declares durable checkpoints and passes D6, OMP exposes the exact NInfer checkpoint contract through the appliance CLI:

```sh
omp appliance checkpoint save --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
omp appliance checkpoint status --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
omp appliance checkpoint delete --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
```

`SESSION_SHA256` must be the 64-character lowercase digest supplied by the OMP session integration, not a raw session identifier. D6 is not yet release-qualified, so these commands are a contract reference rather than a current restart claim. See [Session continuation](./session-continuation.md).

## Roll back or collect local evidence

```sh
omp appliance rollback --json
omp appliance support-bundle
```

Rollback requires a preserved target and proves the restored route before retiring the outgoing candidate. The support bundle is a redacted JSON receipt printed locally; OMP never uploads it.

## Continue reading

- [Architecture](./architecture.md)
- [Security and privacy](./security.md)
- [RTX 5090 profile](./rtx5090.md)
- [RTX 4090 profile](./rtx4090.md)
- [Troubleshooting](./troubleshooting.md)
