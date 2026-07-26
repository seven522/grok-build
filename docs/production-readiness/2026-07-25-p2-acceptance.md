# RunBuild P2 acceptance

Acceptance date: 2026-07-25

## Result

P2 implementation and automated acceptance are complete. RunBuild now has a durable
provider registry, explicit long-term memory, evidence-gated goal execution, and a
recoverable subagent supervision boundary without weakening the existing ACP,
project, or approval model. The current packaged-app native reopen remains pending
only because the local Mac was locked during final desktop QA.

## Delivered behavior

- Provider Registry preserves the existing `Grok ACP` `/acp` route as the default
  provider. Future providers can be registered with typed capability contracts but
  remain visibly unbound until a real runtime adapter exists; credentials, endpoints,
  and raw provider failures are not persisted or shown.
- Memory is local, explicit, inspectable, reversible, scoped by local user and
  project, and recorded with task/run/event provenance. The UI only lets a user save
  a fact or an accepted decision; verified-cause and successful-checkpoint labels are
  reserved for a future trusted ledger reducer. Deterministic retrieval and budgeted,
  redacted context composition are provider-neutral; retrieved context cannot
  override system, user, or safety instructions.
- A sourced memory must name a pre-existing ledger event with the same task, project,
  and run; its provenance points to that event rather than to its own audit row.
  Sourced writes use a private, atomic `prepared → proposed → stored → committed`
  recovery journal, so restart and context retrieval reconcile interrupted writes
  without inventing a commit or duplicating a fact.
- Each P2 context build records only its inspectable receipt (memory IDs, budget,
  omissions, redaction flag, and section counts) in the task ledger before injection,
  then records dispatch after ACP returns. If the first receipt cannot be persisted,
  the memory text is not injected. No context text or secret-bearing fact is copied
  into the ledger.
- A project can read its matching global preferences but cannot edit, dispute, delete,
  or restore them from that page; the server enforces the same boundary. The memory
  workspace labels global/project scope and supports restoring disputed or superseded
  records to `active`.
- Development and packaged desktop both mount the same P2 control plane and provider
  bridge configuration, so browser preview does not silently lose memory behavior.
- Every desktop task prompt has a durable execution-and-verification goal. A terminal
  coding result is accepted only after an independent verifier receipt with evidence;
  missing evidence becomes blocked rather than a fabricated success. Checkpoints
  restore the goal/run relationship after restart.
- The subagent supervisor persists scope, authorization narrowing, reports,
  disconnect/recover/cancel lifecycle, and safe activity summaries. Its current P2
  mode is deliberately synchronous: it supervises a durable child-work record but
  does not silently launch a second ACP/model process.
- Desktop UI exposes an inspectable `记忆` workspace and renders the dynamic provider
  registry in `技能和连接器`. The packaged-app check confirmed `Bridge 已连接` and
  `Grok ACP 已就绪`.

## Verification evidence

- `./scripts/coding-assistant/verify.sh webui` passed after the final integration:
  registry 7, Runner 7, navigation 25, conversation 22, automations 1, desktop 68,
  frontend architecture, typography, renderer, Electron main, preload, and desktop
  bundle builds.
- P2 acceptance/recovery tests prove provider and memory persistence across restart,
  exact source-event provenance, redacted context composition, evidence-gated goal
  settlement, checkpoint restoration, long-run pagination, and recovery after
  failure immediately after proposal or store.
- The final `desktop:pack` build completed and
  `codesign --verify --deep --strict --verbose=4` validated the packaged app and its
  designated requirement.
- A prior packaged-app pass showed the `记忆` workspace, `ACP Bridge 已连接`,
  `项目 Runner 已启用`, and `Grok ACP 已就绪`. The final package must be reopened
  after the local Mac is unlocked to refresh that native-only evidence.

## Known boundaries

- Registered future providers deliberately remain unbound until their actual ACP or
  runtime adapter is implemented. P2 does not claim multi-provider execution merely
  because a provider appears in configuration.
- P2 subagents are durable synchronous supervision records, not automatic parallel
  ACP child runtimes. Starting independent child agents is a separate, explicit
  provider/runtime capability.
- The macOS bundle is locally ad-hoc signed for development verification. It is not
  notarized and has no update or rollback channel. The Vite renderer chunk still has
  the existing non-blocking over-500 KB warning.
