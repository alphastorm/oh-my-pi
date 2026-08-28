# Local appliance security and privacy

The appliance is a local execution boundary, not a silent fallback tier. Its security contract is: authenticated loopback transport, checksum-bound releases, hashed routing identity, content-safe receipts, and explicit failure when the verified local path is unavailable.

## No-cloud-fallback contract

Appliance routing never converts a local failure into a cloud request. It does not switch provider, model, endpoint class, or artifact to make a request succeed.

- A missing healthy local endpoint fails.
- A changed or unavailable warm owner fails by default.
- `appliance.coldLocalFallback=true` permits only another authenticated, registry-compatible local appliance and forces full transcript replay.
- A stale provider chain receives one full replay against the selected local endpoint; it does not retry on cloud infrastructure.

This contract applies to requests being resolved through appliance routing. Selecting a separate cloud model explicitly remains an independent user action.

## Network and authentication boundary

Persisted appliance routes must:

- use HTTP or HTTPS;
- target the `/v1` API root;
- resolve to `127.0.0.1`, `::1`, or `localhost`;
- use the exact persisted port;
- contain no URL username, password, query, or fragment.

OMP authenticates status, Responses, and checkpoint requests with the installation's bearer secret. On POSIX, secret files are private (`0600`). The secret is passed to a launched runtime through the child environment, not argv, route receipts, service manifests, or support output.

The current NInfer stored-response boundary is a **single configured API key**. Treat that key as the tenant boundary for stored response state. This contract does not claim multi-tenant isolation behind one key.

`ninfer_session` scopes continuation and private cache state within that authenticated tenant. It is a lowercase SHA-256 derived by OMP, never the raw OMP session identifier. The checkpoint API likewise accepts only the digest. The API does not depend on a raw identity carrier in GET or DELETE requests.

## Release and supply-chain boundary

A registry profile is installable only when all of these bind to one release:

1. HTTPS runtime and model asset locations;
2. expected byte sizes and SHA-256 digests;
3. an exact launch descriptor;
4. a public, content-safe qualification receipt;
5. the declared served model and capabilities.

Downloads land in temporary files and are verified before entering the content-addressed artifact store. Runtime, model, source, patch-stack, config, and deployment identities are checked again through authenticated status before promotion. A registry entry without every required release field remains non-installable.

Never work around a blocker by inserting an unpublished URL, accepting a mutable tag as a digest, or rebinding old benchmark evidence to a new source head, image, model, or config.

## Stored state

OMP stores appliance data beneath `~/.omp/agent/appliance` by default; `PI_CODING_AGENT_DIR` changes the parent agent directory.

| Data | Contents | Exposure rule |
| --- | --- | --- |
| `state.json` | Versioned active, fleet, and rollback installations | Private; route must still pass registry and loopback validation |
| `secrets/*.key` | Bearer credentials | Private; never printed or included in receipts |
| `artifacts/<kind>/<sha256>` | Verified runtime/model bytes | Addressed by digest |
| `candidates/*/service.json` | Private launch metadata without bearer secret | Retained for diagnosis |
| `candidates/*/service.log` | Runtime diagnostics | Private; may contain implementation diagnostics |
| `receipts/*.json` | Content-safe lifecycle evidence | Excludes content and private topology |
| Session provider blobs | Chaining baseline and prior output items | Private acceleration state; not authoritative transcript |

Hashed session affinity stores only the endpoint/profile/model/artifact binding, last-success time, and a bounded fallback reason. Base URLs, hostnames, raw identities, prompts, outputs, and secrets are excluded.

## Receipt and support-output contract

Ordinary appliance receipts must not contain:

- prompts, tool payloads, or generated text;
- raw session or request IDs;
- API keys, environment values, or argv;
- usernames, hostnames, private paths, or endpoint URLs;
- fabricated measurements or inferred success.

Missing evidence is `null` or a blocker, never a guessed value. `omp appliance support-bundle` emits redacted JSON locally and never uploads it. Review private runtime logs separately before sharing them; their retention does not make them public-safe.

## Checkpoint privacy contract

The exact checkpoint requests are:

```text
POST   /v1/ninfer/checkpoints
GET    /v1/ninfer/checkpoints/<session-sha256>/status
DELETE /v1/ninfer/checkpoints/<session-sha256>
```

Save sends one JSON field, `{"session_sha256":"<64 lowercase hex>"}`, with `Content-Type: application/json`. Status and delete have no request body. Successful responses identify the checkpoint artifact type and state but do not need to echo the session digest. OMP validates the response schema and operation-appropriate state before producing a receipt.

A checkpoint is acceleration state. Deleting it does not delete the authoritative OMP transcript. A missing, corrupt, disabled, or incompatible checkpoint must result in deterministic full replay, not loss of the conversation.

## Rollback contract

Promotion preserves the exact prior installation metadata and artifacts. Rollback proves the old runtime directly, restores its route atomically, and proves a routed request before final cleanup. If recovery cannot be proven, OMP preserves both release artifacts, secrets, state, and diagnostics rather than deleting evidence or claiming that either route is runnable.

Rollback never weakens artifact verification and never changes the no-cloud-fallback rule.

## Current limitations

- Both public Qwen3.8 profiles are non-installable until their exact artifact and qualification blockers close.
- RTX 5090 image/live evidence is held even though source provenance has been remediated.
- RTX 4090 K3 stopped at the first restart red; the corrected MTP0 package candidate is locally verified but not live-qualified, and MTP3/K5 did not run.
- D6 source/host contracts pass; exact `sm_120a` binary/live restart proof is blocked on the held RTX 5090 lane.
- The single-key stored-response boundary is not a multi-tenant authorization system.

See [Qualification](./qualification.md) before interpreting any candidate result as released security evidence.
