# RunBuild production-readiness audit

Audit date: 2026-07-24

## Executive verdict

RunBuild is a working local engineering prototype, not yet a production desktop agent.
Its strongest foundation is the project model: a project is a real folder, each project
has an isolated Runner, and an ACP session can be restored into the same working
directory. The next release should preserve that foundation and harden the execution
contract around it.

The production order is:

1. No silent privilege escalation.
2. No lost, duplicated, or cross-project state.
3. No orphan Runner or stale listening port after exit or crash.
4. Every claimed result has an action receipt and verification evidence.
5. Only then add semantic memory, subagents, schedules, and remote workspaces.

## Evidence and limits

This audit used four independent evidence paths:

- repository and runtime inspection;
- the current WebUI verification gate (60 Node tests plus renderer, Electron main,
  and preload builds);
- live browser flow checks against the local desktop server;
- native Electron checks for permissions, project import, and the macOS folder picker.

Passing a build is not treated as proof of desktop behavior. The current packaged app
is older than the audited source tree, is ad-hoc signed, and has no notarization or
update-channel evidence. Live model output, file readback, crash recovery, and signed
distribution remain separate acceptance gates.

## Current product architecture

```text
React workspace UI
  -> Electron local HTTP/WebSocket boundary
      -> root Agent runtime, or one project Runner per real cwd
          -> ACP session and event stream
              -> Grok Shell / model / tools / project files
```

What should remain:

- the workspace and sidebar information architecture;
- immediate task selection with loading contained inside the conversation;
- a blank, usable composer before a new session is fully initialized;
- real project `cwd`, `.grok/`, `AGENTS.md`, and one Runner boundary per project;
- ACP as the first Agent-provider adapter, not as the whole product data model.

What must change is the authority model: the WebSocket stream is transport, not the
canonical task database; UI labels are presentation, not proof of sandbox or approval
state; and a process handle held only in Electron memory is not durable Runner
ownership.

## Retested product flow

| Step | Current health | Verified behavior | Production gap |
|---|---|---|---|
| 1. Start and permission setup | Yellow | Native app and setup modal open; two of three core macOS permissions were already granted | High-trust permissions are requested too early; request them only when a feature needs them |
| 2. Add a project | Green/Yellow | Existing-folder and new-workspace routes open; the native folder picker works | No complete remove, archive, ownership-transfer, or data-cleanup lifecycle |
| 3. Create a task | Green | Blank composer became usable in about 0.4 seconds | Keep this behavior as a regression gate |
| 4. Switch a project task | Green/Yellow | Selection and local loading were immediate; cold Runner plus session restore completed in about 5.3 seconds | Show explicit phases after two seconds: starting Runner, authenticating, loading events, ready |
| 5. Prompt, attachment, and cancel | Yellow | Text, paste, drop, and attachments are wired | No prompt timeout; cancel and disconnect can leave ambiguous running state; cold attachment replay is incomplete |
| 6. Tool authorization | Red at baseline; first P0 slice verified | Manual approval UI and allow-once/reject paths exist | The audited baseline used `--sandbox off --always-approve`; the current worktree now starts root/project Runners with workspace sandboxing and explicit approval |
| 7. Archive and search | Red | Pin/archive preferences persist locally | Archived tasks have no normal recovery view; search is not a complete message/archive index |
| 8. Automation | Red | Saved prompts can be created and manually reused | No scheduler, webhook, event trigger, run ledger, retry, or background worker; the current surface is a template library |
| 9. Skills and connectors | Yellow | ACP Bridge, project Runner, MCP, and GitHub concepts are visible | Mostly descriptive state; no complete install, auth, health check, invocation receipt, or repair flow |
| 10. Exit and recover | Red | Normal shutdown calls Runner stop | Seven live `PPID=1` Agent processes were found listening on localhost; there is no single-instance lock, owner lease, stale-process reclamation, or crash test |

The native folder picker was exercised and cancelled. Its screenshot is intentionally
excluded because it displayed unrelated private filenames.

## P0 release gate: make execution trustworthy

## First P0 slice completed in this audit

The unsafe-default mismatch was corrected without changing the workspace UI or ACP
architecture:

- desktop root Agent and project Runner launch with
  `--sandbox workspace --permission-mode default`;
- `./run web-agent` uses the same CLI contract;
- runtime TOML migrates `yolo=true / always-approve` to
  `yolo=false / permission_mode="ask"`;
- every new or restored WebUI session starts at “执行前确认” and sends the matching
  ACP permission-state notification;
- “替我执行” remains available only as an explicit session choice.

Fresh verification after the change:

- 63 Node tests passed: registry 7, Runner 3, navigation 19, conversation 9,
  automation 1, and desktop 24;
- renderer, Electron main, and preload builds passed;
- a real `web-agent` root process and a real project Runner were observed with the
  workspace/default CLI arguments;
- a live Grok 4.5 turn returned `SAFE_DEFAULT_OK` while the UI remained at
  “执行前确认”;
- “允许一次” created and read back `safe-allowed.txt` with `ALLOWED_OK`;
- “拒绝” left `safe-rejected.txt` absent;
- an approved write outside the project returned
  `IO Error: Operation not permitted` and the target remained absent;
- controlled shutdown closed the root, Vite, and project Runner ports and both test
  Agent PIDs exited.

The first live attempt also caught a test-only false positive: the CLI does not accept
`--permission-mode ask`; its safe CLI value is `default`, while `ask` remains the
canonical TOML/ACP value. The full gate was rerun after correcting this.

The built-in workspace profile intentionally allows temporary directories. Therefore
`/tmp` is not a valid outside-workspace negative fixture; the final sandbox test used a
non-temporary sibling path. This should be encoded in the future Electron/ACP E2E
harness.

This slice does **not** close abnormal-exit recovery. The pre-existing orphan Agents
remain an independent P0 lifecycle item and were not killed during the audit.

### Safe execution contract

Default mode must be **workspace sandbox plus per-action confirmation**.

The user may explicitly enable “run for me” for the current task, but that choice must:

- display the effective sandbox and writable roots;
- expire at task end or a visible timeout;
- never turn an old or newly restored task into full access silently;
- create an authorization event containing action, risk, scope, decision, and time;
- remain subordinate to immutable deny rules for secrets and protected paths.

The UI must read effective runtime state. It must not infer safety from a locally stored
toggle.

### Runner ownership and recovery

Add a durable owner record for every root/project Runner:

```text
runner_id, project_id, owner_instance_id, pid, process_start_time,
port, binary_path, workspace_realpath, started_at, heartbeat_at, state
```

Required behavior:

- Electron is single-instance per application data root;
- a Runner validates its parent/lease and exits when ownership is lost;
- startup reclaims only a process whose PID, start time, binary, secret/lease, and
  workspace all match the stale record;
- normal exit, Electron crash, force kill, and restart all converge to zero orphan
  Runners and zero stale ports;
- cleanup never kills a merely similar user process.

### Canonical event ledger

Introduce an append-only, typed task event ledger. At minimum:

```text
UserMessage | AssistantMessage | ToolAction | ToolObservation
AuthorizationRequested | AuthorizationDecided | AgentError
StateChanged | CancelRequested | Checkpoint | VerificationResult
ContextCondensed | MemoryProposed | MemoryCommitted
```

Each event needs a stable ID, task ID, project ID, run ID, timestamp, sequence/cursor,
source, and schema version. ACP/WebSocket events are adapted into this ledger and can
be replayed idempotently. The conversation screen becomes a projection of the ledger,
not a second source of truth.

### Completion evidence

“Agent said done” is never the terminal condition. A completed coding task records:

- changed files or explicit no-change result;
- commands attempted and their exit codes;
- relevant diff/readback;
- verifier result and remaining uncertainty;
- cleanup result for processes and temporary resources.

## Target architecture

```text
RunBuild Control Plane
  |- Task/Event Store -------- recovery, projections, audit
  |- Agent Provider Registry - Grok ACP first; Codex/Claude/Gemini adapters later
  |- Authorization Engine ---- policy + risk + decision ledger
  |- Workspace Manager ------- local now; Docker/remote behind one contract later
  |- Runner Supervisor ------- ownership, heartbeat, cleanup, diagnostics
  |- Context Builder --------- rules + summary + retrieved memories
  |- Verifier ---------------- diff, tests, readback, acceptance receipts
  `- Automation Engine ------- only after manual runs are durable and recoverable
```

The provider contract should expose capabilities rather than product-specific UI
assumptions: session create/load/cancel, event stream, model list, permission request,
tool observation, context usage, and provider health.

## Production memory system

Do not replace the task store or session archive with a vector database. Use four
separate layers:

1. **Working context** — the current turn window, plan, active files, and a condenser.
2. **Session ledger** — immutable messages, actions, observations, decisions, errors,
   checkpoints, and recovery state.
3. **Inspectable project/user memory** — concise Markdown rules and decisions that the
   user can review, edit, pin, or delete.
4. **Semantic fact memory** — Mem0-style extraction and retrieval for useful facts
   across conversations.

A semantic memory record should include:

```text
id
scope: user | project | agent | run
subject_id
fact
source_event_ids
source_conversation_id
created_at
valid_from / valid_to
status: active | superseded | disputed | deleted
confidence
sensitivity
pinned
metadata
```

Write only after an explicit “remember this”, an accepted decision, a verified fault
cause, or a successful checkpoint. Extraction failure must never block the task reply.
Never store credentials, raw environment values, temporary command noise, or an
unverified Agent guess.

Before a model call, build context in deterministic order:

```text
project rules
+ user/project Markdown memory
+ current session summary
+ scoped semantic top-K
+ relevant verified successes/failures
-> deduplicate, resolve time conflicts, enforce sensitivity and token budget
```

Every injected memory must retain a visible source and support correct, supersede,
forget, and hard-delete operations. Chinese entity and keyword recall needs its own
evaluation set; English defaults are not sufficient evidence.

## What to borrow from the reference projects

### Mem0

Borrow the separation between messages and extracted facts, scoped retrieval, hybrid
semantic/keyword ranking, and inspectable memory lifecycle. Put it behind a RunBuild
Memory Adapter because its current SDK and migration surface change quickly.

Do not use it as the task state machine, event store, authorization log, transcript
archive, dependency graph, or business database.

### OpenHands

Borrow the control-plane / Agent Server / Workspace separation, typed append-only
events, Conversation recovery contract, Agent-provider profiles, security policies,
skills/hooks, and verifier loop.

Do not fork the product, replace the current desktop workspace, or copy the current
Canvas frontend. Its repository split and Canvas transition are still moving; the
useful part is the contract boundary, not the implementation stack.

## Delivery sequence

### Release 0 — trustworthy local core (P0)

- safe runtime defaults and truthful authorization UI;
- Runner supervisor, single-instance ownership, and crash cleanup;
- canonical task/event ledger and deterministic replay;
- Electron + ACP acceptance harness;
- current-source packaging provenance.

Exit gate: project isolation, allow/reject, outside-workspace denial, cancel/reconnect,
cold restore, normal exit, crash, and force-kill all have repeatable receipts.

### Release 1 — durable daily driver (P1)

- archived-task recovery and project lifecycle;
- prompt timeout, reconnect, attachment persistence, and diagnostics;
- settings/safety/storage/log center;
- task-scoped drafts, activity, and tool events;
- on-demand macOS permissions;
- provider and connector health checks.

Exit gate: a user can diagnose and recover every normal failure without opening source
code or manually hunting processes.

### Release 2 — stronger coding and memory (P1/P2)

- provider registry while retaining Grok ACP;
- context condenser and path-triggered skills;
- goal -> execute -> verify loop;
- inspectable project/user memory and semantic fact adapter;
- synchronous, recoverable, observable subagents before parallel execution.

Exit gate: cold-session recall is source-backed; a coding task cannot report completion
without verification evidence; subagent work survives reconnect and cannot exceed the
parent authorization scope.

### Release 3 — automation and remote execution (P2/P3)

- real cron/webhook/GitHub triggers with run history, retry, pause, and manual replay;
- Docker and remote Workspace backends behind the existing contract;
- signed/notarized builds, update channel, rollback, and release provenance;
- team auth, RBAC, tenant boundaries, quotas, and audit export if collaboration is in
  product scope.

Exit gate: unattended runs use narrower policy than interactive runs, have explicit
budgets and termination conditions, and always leave a reviewable receipt.

## Required acceptance suite

The production gate must keep these proofs separate:

1. service reachable;
2. ACP/session action accepted;
3. model output received;
4. tool permission allow-once, reject, and explicit auto-run exercised;
5. resulting filesystem or process state read back from the owner;
6. UI projection matches that state;
7. shutdown or crash cleanup verified.

Minimum scenarios:

- root and two project sessions cannot mix cwd, messages, tools, drafts, or memories;
- a workspace-sandbox session cannot write outside its project;
- a restored session cannot silently widen its sandbox or approval mode;
- replayed WebSocket events do not duplicate output;
- a draft typed during session creation is not erased;
- cancel, network loss, Agent exit, Electron crash, and OS restart recover visibly;
- normal quit and three abnormal-exit paths leave no Runner or listening port;
- a memory can be traced, corrected, superseded, forgotten, and hard-deleted;
- a completion claim includes diff/readback, test exit code, and verifier status;
- the packaged app is built from the audited commit and passes signing/notarization
  checks on a clean machine.

## Current quality risks outside P0

- `main.tsx` and the primary stylesheet are too large for safe parallel product work;
  split them by stable domain only after the P0 contracts are defined.
- the renderer bundle is above the current 500 kB warning threshold;
- the dependency audit reports Vite/esbuild development-chain findings whose supported
  fix requires a Vite major-version migration;
- the app bundle is about 992 MB, dominated by the embedded Agent binary;
- accessibility observations are encouraging at the semantic-control level, but full
  keyboard, focus-order, screen-reader, zoom, reduced-motion, and measured-contrast
  testing has not yet been completed.

## Reference sources

- Mem0: [How it works](https://docs.mem0.ai/core-concepts/how-it-works),
  [OSS overview](https://docs.mem0.ai/open-source/overview), and
  [V2 to V3 migration](https://docs.mem0.ai/migration/oss-v2-to-v3)
- OpenHands: [Agent Server](https://docs.openhands.dev/sdk/arch/agent-server),
  [events](https://docs.openhands.dev/sdk/arch/events),
  [conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence),
  [security](https://docs.openhands.dev/sdk/guides/security), and
  [persistent memory](https://docs.openhands.dev/sdk/guides/persistent-memory)
