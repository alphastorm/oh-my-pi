# Appliance qualification

Qualification binds behavior and performance to one exact source head, binary or image, model artifact, configuration, deployment profile, and protocol schema. Evidence from another combination is historical context, not a release receipt.

## Current gate status

| Lane | Current truth | Gate that remains |
| --- | --- | --- |
| RTX 5090 release | Source provenance was remediated on clean NInfer release head `ae044b45259e46ca652e64e6b9f9672121ef4518`. The isolated candidate image build is held and has not run. | Build the exact candidate, publish runtime/model checksums, run protocol/long/Golden and rollback proof, then publish a public receipt. Prior measurements are not rebound to this head. |
| RTX 4090 K3/K5 | MTP0 Golden passed once, then K3 stopped on the first restart red. The rehash root cause is fixed and the remediated package candidate passes no-service verification; MTP3/K5 did not run. | Independently review the frozen fix, rerun fresh MTP0 protocol/long/Golden/restart gates, then run MTP3 only if MTP0 is completely green. Publish only after the existing promotion and receipt rules pass. |
| Durable D6 | OMP's exact client and the matching NInfer source/host contracts pass. The canonical runtime is `sm_120a`/POSIX, so the SF native-Windows build cannot produce the binary. | Use the held Linux/RTX 5090 lane to build the exact candidate and prove save/status/delete plus live NInfer process restart. No release-level durable continuity claim exists yet. |
| Public registry | `rtx5090-linux` and `rtx4090-windows` identities are present. | Both remain `installable: false` until their exact release evidence is published. |

Production routes, services, images, and rollback locks are outside qualification. Candidate evidence does not mutate them.

## Three-fixture budget

Use exactly three fixture classes:

| Fixture | Purpose |
| --- | --- |
| **P** | Protocol and tool correctness |
| **L** | 80–120K continuation, cache reuse, and restart |
| **G** | One real Golden implementation task |

The budget and stop rules are mandatory:

- Every code change runs the smallest affected unit tests.
- Every protocol or session change runs P.
- Every cache or persistence change runs L.
- Only release candidates and meaningful runtime changes run G.
- One warm-up and one measured run are enough for correctness.
- Performance candidates use two measurements, then three to five measurements only for finalists.
- Do not run a broad model tournament.
- Do not reopen MTP5.
- Do not start a kernel campaign without end-to-end attribution.
- Reject a maintenance-bearing optimization below 5% end-to-end gain.
- Retain correctness fixes regardless of speed when they close a real agent failure.
- Never trade deterministic quality for a throughput headline.

Stop when the required observation is decisive. Do not turn an unambiguous pass or fail into a broader campaign.

## Fixture P: protocol and tools

P covers observable OMP/NInfer interoperability, including:

- OpenAI Responses request and streaming event shape;
- stable hashed `ninfer_session` and per-attempt `ninfer_request_id`;
- authenticated, schema-exact `/v1/ninfer/status`;
- tools, reasoning, and thinking-history behavior declared by the profile;
- malformed or stale `previous_response_id` classification;
- exactly one full-replay recovery without provider/model switching;
- checkpoint operation paths, save JSON body, authentication, strict response fields, and HTTP 409 `checkpoint_unavailable` classification when D6 is in scope.

A protocol pass requires no malformed tool or response behavior. A throughput result cannot waive protocol correctness.

## Fixture L: long continuation and restart

L uses an 80–120K session and records cold, warm, and restart behavior against the exact candidate. It must demonstrate:

- exact transcript continuation after OMP process restart;
- authenticated endpoint identity and warm-owner affinity;
- reported prompt reuse rather than inference from wall time alone;
- deterministic full replay after missing, stale, corrupt, incompatible, or endpoint-mismatched acceleration state;
- no cloud/model/endpoint-class fallback;
- for D6, a real NInfer process restart followed by checkpoint restoration and exact continuation.

OMP restart continuity and NInfer restart continuity are separate claims. A persisted OMP transcript plus a still-running NInfer process proves only the former.

## Fixture G: Golden implementation

G is one real implementation task executed only for a release candidate or meaningful runtime change. Score the complete outcome: correctness, tool behavior, final artifact, and end-to-end wall time. Do not substitute a synthetic token benchmark for the task.

### RTX 4090 MTP stop rule

Run one bounded MTP3 requalification only after protocol parity. It includes P, L, and G once. Promote MTP3 only if all of these are observed on the exact candidate:

1. no malformed protocol, tool, or response behavior;
2. at least 10% improvement in complete Golden wall time;
3. exact persistence and continuation behavior.

Otherwise keep MTP0, record the result, and close the experiment. The public `rtx4090-windows` registry currently declares `speculation: none`, matching the incumbent.

## Release receipt

A public receipt must bind:

- source and patch-stack identities;
- binary or image and model SHA-256;
- exact config and deployment profile;
- served model, protocol, context, KV mode, speculation mode, and concurrency;
- P/L/G verdicts required for that change;
- cold/warm/restart measurements actually observed;
- protocol/tool, persistence, and rollback verdicts;
- qualification timestamp and receipt schema.

It must exclude prompts, generated text, raw session/request IDs, secrets, hostnames, usernames, private paths, endpoint URLs, argv, and environment. Missing evidence remains explicit and blocks release.

## Promotion and rollback gate

A profile may become installable only after its assets, checksums, launch descriptor, and public receipt all agree. Fresh install must occur on isolated candidate resources while the incumbent remains available. Promotion requires candidate health, bounded qualification, routed proof, and a preserved rollback target. Rollback itself must be exercised and proven before release.

The RTX 5090's remediated source is necessary but insufficient because the candidate image/live receipt is held. The RTX 4090's stopped K3 run and locally verified remediated package candidate are useful evidence but are not a green K3/K5 promotion receipt. D6's OMP client and NInfer host contracts are necessary but do not prove the exact `sm_120a` binary or live process restart.

See [RTX 5090](./rtx5090.md), [RTX 4090](./rtx4090.md), and [Session continuation](./session-continuation.md).
