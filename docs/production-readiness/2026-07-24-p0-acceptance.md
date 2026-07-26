# RunBuild P0 acceptance record

Acceptance date: 2026-07-24

Status: **passed for the local trustworthy-core scope**. This is a development
package record, not a notarized public-distribution release.

This record closes the P0 items defined by
[`2026-07-24-runbuild-audit.md`](./2026-07-24-runbuild-audit.md): safe local
execution, durable root/project Runner ownership, a typed task ledger,
evidence-gated coding completion, and current-source package provenance.

## What is now enforced

- Root Agent and project Runner start with `--sandbox workspace --permission-mode default`.
  The WebUI defaults every new/restored task to **执行前确认**; "替我执行" is an
  explicit, task-local choice.
- The desktop app is single-instance per app-data root. Root and project Runners
  have a persistent lease containing only safe runtime metadata: port, real
  binary path, command hash, real workspace path, timestamps, state, and exact
  process identities. Heartbeats are atomically updated and stale cleanup only
  targets an exact owned process/PGID.
- The local server persists an append-only JSONL task ledger with a stable event
  ID, sequence, task/project/run scope, source, idempotency key, and schema
  version. ACP events are adapted into the ledger and replay idempotently.
- A `turn_completed` transport event is not a verified coding result. Changed
  files require a later raw-tool readback; failed/background tools or assistant
  prose cannot satisfy the verifier. The ledger then records a
  `verification.recorded` receipt and `state=verified`, or leaves the run
  incomplete.
- The macOS package records its source revision, Git commit, and dirty-tree
  status in `Info.plist` before signing.

## Fresh repeatable evidence

Run from the repository root:

```sh
./scripts/coding-assistant/doctor.sh
./scripts/coding-assistant/verify.sh webui
```

The final `verify.sh webui` run passed all relevant groups:

| Gate | Result |
| --- | --- |
| Project registry | 7 / 7 |
| Project Runner, lease, stale recovery, guardian | 7 / 7 |
| Navigation/session isolation | 19 / 19 |
| Conversation, authorization, and completion evidence | 22 / 22 |
| Automations | 1 / 1 |
| Desktop, ledger, ACP adapter, P0 HTTP chain, single-instance, package metadata | 35 / 35 |
| Renderer, Electron main, and preload builds | passed |

The dedicated P0 command is also available:

```sh
cd webui
npm run test:p0
```

It covers a temporary real local HTTP ledger, authenticated append/read,
ACP-event adaptation, idempotent replay, the unverified-terminal rejection,
post-change readback verification, root/project lifecycle, guardian cleanup,
single-instance behavior, and package provenance.

## Current-source desktop package

The package was rebuilt with:

```sh
cd webui
PERSONAL_AGENT_PACK_BINARY=/tmp/grok-build-target/debug/xai-grok-pager npm run desktop:pack
```

The resulting `release/mac-arm64/RunBuild.app` passed
`codesign --verify --deep --strict`. Its package provenance is:

| Field | Value |
| --- | --- |
| Schema | `1` |
| Package version | `0.1.0` |
| Source revision | `c5c4ce03436b4bb2cec43d3feaa27dee0109bf37` |
| Git commit | `a881e6703f46b01d8c7d4a5437683546df30449d` |
| Dirty source | `true` |

The bundled arm64 `xai-grok-pager` SHA-256 matched the requested local input
binary. A native smoke run opened this package, reached the workspace with a
connected Bridge and visible **执行前确认** mode, and confirmed that the spawned
root Agent used the workspace/default command. Quitting the package removed
the exact package, Agent, and guardian test processes.

## Deliberately remaining outside this P0 exit

- The package is ad-hoc signed (`TeamIdentifier` is absent), not notarized, and
  has no update channel or rollback proof. Those are release-distribution work.
- This acceptance did not spend a live provider/model turn from the newly
  packaged app; provider/model acceptance remains a separate, credential and
  cost-bearing check.
- Semantic fact extraction/retrieval, editable project/user memory, provider
  registry, subagents, automation execution, remote workspaces, and public
  release operations remain later release work. The P0 ledger includes typed
  memory proposal/commit receipts as a safe foundation, not a claim of a full
  Mem0-style memory product.
