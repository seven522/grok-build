# RunBuild P1 acceptance

Acceptance date: 2026-07-25

## Result

P1, the durable daily-driver release, is complete. The desktop app now retains the
task working state needed for ordinary recovery and provides a local, redacted path
to diagnose it. The P2 semantic-memory, multi-provider registry, and subagent work
remain deliberately out of this release.

## Delivered behavior

- Task workspace storage keeps per-project drafts, unsent attachment references, and
  opaque attachment blobs across app/server restart. Blobs are private files rather
  than JSON payloads; cross-project reads are rejected.
- Task and project lifecycle operations are durable and reversible. Project
  archive/detach is a safe overlay: it never deletes the real project directory,
  registry, Runner, or task data.
- Prompt waiting has an explicit deadline and bounded reconnect plan. A disconnect
  remains `unconfirmed` until a real ACP terminal event arrives; it never invents a
  successful or failed task outcome. Pending cancellation is resent after recovery.
- ACP delivery replay is normalized before ledger idempotency comparison, including
  compatibility with old records that contained delivery-local replay metadata.
- The task activity panel projects durable lifecycle, checkpoint, memory, and tool
  receipts without exposing raw messages, tool output, or secrets.
- Settings and local diagnostics show the root lease/PID/port, local storage health,
  model availability, redacted logs, and explicit-only Agent restart/permission
  actions. No macOS permission is requested during startup.
- Recent MCP spawn failures are surfaced as degraded connectors with only a safe
  server name. Full command/error detail stays in the bounded, redacted local log.

## Verification evidence

- `./scripts/coding-assistant/verify.sh webui` passed after the final changes:
  registry 7, Runner 7, navigation 25, conversation 22, automations 1, desktop 48,
  frontend architecture, typography, renderer, Electron main, and preload builds.
- The P1 acceptance case proves draft/blob persistence, archive/restore across a
  local-server restart, project isolation, and reconnect remaining unconfirmed until
  an explicit terminal event.
- The final `desktop:pack` build completed and
  `codesign --verify --deep --strict --verbose=4` validated the packaged app and its
  designated requirement.
- The freshly packaged app was launched natively. It reached `Bridge 已连接` on a
  blank task without a false recovery banner. Its diagnostics view showed a live
  lease/PID/port, task-workspace storage, redacted logs, no automatic permission
  prompt, and the existing `postgres` / `summer-engine` MCP startup failures as
  visible `待检查` connector cards.

## Known boundaries

- The two MCP cards report an existing local environment/configuration failure; P1
  makes that failure diagnosable but does not install, alter, or delete user-managed
  MCP dependencies.
- The macOS bundle is locally ad-hoc signed for development verification. It is not
  notarized and has no update/rollback channel; those are Release 3 work.
- The Vite build retains the pre-existing over-500 KB renderer chunk warning.
