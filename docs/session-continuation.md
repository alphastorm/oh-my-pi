# Session continuation

OMP owns the conversation; NInfer accelerates it. This separation lets a long session survive missing cache state, a stale stored-response chain, an OMP restart, and—after D6 is qualified—a NInfer process restart without changing the model or sending the request to cloud infrastructure.

## Canonical and disposable state

The OMP transcript is authoritative for messages, tool calls/results, branch history, and replay. Provider acceleration state is a private optimization that records a committed Responses baseline and prior output items after transcript publication.

A provider snapshot is usable only when its provider, model, endpoint fingerprint, request-shape version, branch digest, and committed turn agree with the current session. A missing or invalid snapshot is ignored and the transcript remains sufficient.

This ordering matters:

1. Build the request from the authoritative transcript.
2. Apply stable NInfer session identity.
3. Apply a valid previous-response delta, if available.
4. Stream and prepare a new provider snapshot.
5. Publish the transcript turn.
6. Commit the prepared provider snapshot.

If publication fails, the prepared state rolls back. The next turn cannot chain from an unpublished response.

## Hashed identity and affinity

OMP derives a domain-separated lowercase SHA-256 for the session and another for each logical OMP response request. The stable digest is sent as `ninfer_session`; the request digest is sent as `ninfer_request_id`. Raw OMP session IDs are not used as NInfer routing identity.

Warm affinity persists only:

- the session SHA-256;
- authenticated endpoint fingerprint;
- deployment profile and served model;
- artifact SHA-256;
- last-success timestamp;
- optional `endpoint_identity_changed`, `stale_previous_response_id`, or `warm_owner_unavailable` reason.

It never stores the endpoint URL, API key, raw session identity, prompt, generated output, or private host path.

The fingerprint binds the normalized endpoint to the authenticated NInfer source, patch stack, binary, artifact, config, deployment profile, target, served model, and request-shape identity. A changed fingerprint cannot inherit a warm chain silently.

## Normal continuation

For a matching snapshot and endpoint, OMP sends the new delta with `previous_response_id`. NInfer uses the stable session digest to scope stored response/cache state under the configured API key. On successful transcript publication, OMP commits the new response baseline for the next turn.

A single configured NInfer API key is the stored-response tenant boundary. `ninfer_session` separates sessions inside that boundary; it is not a replacement for tenant authentication.

## Deterministic full replay

Recovery is deliberately narrow:

| Condition | OMP behavior |
| --- | --- |
| Provider snapshot absent, corrupt, future-version, branch-mismatched, or incompatible | Ignore acceleration state and build from the full transcript |
| Authenticated endpoint fingerprint changed | Clear the old baseline, record `endpoint_identity_changed`, and use full replay |
| NInfer rejects a stale/expired/missing previous response | Record `stale_previous_response_id` and retry exactly once with full transcript and no `previous_response_id` |
| Warm owner unavailable, cold-local fallback disabled | Fail explicitly |
| Warm owner unavailable, cold-local fallback enabled | Select another healthy compatible local endpoint, record `warm_owner_unavailable`, and use full replay |
| Durable checkpoint missing, corrupt, incompatible, disabled, or deleted | Use full replay from the OMP transcript |

The stale-chain retry cannot recursively chain because the retry contains no previous response ID. None of these paths switches to another model, cloud provider, or unverified endpoint.

## OMP restart versus NInfer restart

These are different proofs:

- **OMP process restart:** OMP reloads the transcript and validated provider snapshot, re-authenticates the endpoint identity, and continues. A still-running NInfer process may retain warm state.
- **NInfer process restart:** in-memory and ordinary stored-response state can disappear. Durable continuity requires a transactionally saved checkpoint, a matching NInfer build/config/artifact, restored state, and exact continuation after the actual runtime restarts.

Existing long-session restart evidence must identify which process restarted. It is not valid to relabel an OMP restart as NInfer restart durability.

## Durable D6 checkpoint contract

The operation contract is exact:

```text
save:   POST   /v1/ninfer/checkpoints
        Content-Type: application/json
        {"session_sha256":"<64 lowercase hex>"}

status: GET    /v1/ninfer/checkpoints/<digest>/status
        no request body

delete: DELETE /v1/ninfer/checkpoints/<digest>
        no request body
```

All three requests are authenticated with the installation bearer secret. Successful output has `artifact_type: ninfer_session_checkpoint_status`, a valid operation-appropriate `state`, and strictly typed optional generation, timestamp, byte, frontier-token, restored-token, and response-record fields. The response does not need to echo the session digest; OMP associates it with the digest used in the authenticated request.

Save may return HTTP 409 `checkpoint_unavailable` when no complete response is checkpointable. That is an explicit unavailable result, not permission to checkpoint an incomplete turn.

Checkpoint CLI commands accept only the hashed identity:

```sh
omp appliance checkpoint save --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
omp appliance checkpoint status --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
omp appliance checkpoint delete --session-sha256 "$SESSION_SHA256" --profile rtx4090-windows --json
```

## Current D6 status

OMP's client, CLI, strict response validation, and receipt path implement this contract. Matching NInfer source and host/API contracts pass, but the exact `sm_120a` binary and live save-restart-restore proof are blocked on the held RTX 5090 lane. Therefore:

- do not claim NInfer process restart continuity for the release;
- do not promote a profile based on checkpoint capability declaration alone;
- keep full replay as the authoritative recovery path;
- bind eventual evidence to the exact runtime, model, config, and deployment identities.

The required proof is Fixture L: 80–120K continuation, checkpoint save after a complete response, actual NInfer process restart, authenticated restore/status, exact continuation, and deterministic full replay when the checkpoint is unavailable or invalid. See [Qualification](./qualification.md).
