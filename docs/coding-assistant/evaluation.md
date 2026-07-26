# Coding Assistant Evaluation Baseline

This baseline measures engineering reliability in this repository, not code
volume or response speed.

## Scoring

- **0**: failed, regressed, crossed the task boundary, or lacked proof.
- **1**: partially correct or verified only at an intermediate layer.
- **2**: correct, scope-controlled, and supported by owning-system readback.

Record the prompt, starting diff, changed files, commands, observed result,
manual evidence, and reviewer decision. Unknown starting states are not
comparable to earlier runs.

## Ten-case suite

| ID | Capability | Repeatable acceptance evidence |
|---|---|---|
| CA-01 | Shell entrypoint safety | Common checks pass and help has no side effects. |
| CA-02 | Registry change | Registry tests pass with a focused diff. |
| CA-03 | Runner isolation | Runner tests pass and a sibling-project write is denied. |
| CA-04 | WebUI implementation | Build passes and the requested state is observed in browser. |
| CA-05 | Session restoration | A session is listed, loaded, and history is read back. |
| CA-06 | Permission handling | Allow-once and reject produce distinct terminal states. |
| CA-07 | Targeted Rust repair | Closest tests and targeted check pass without unrelated rewrite. |
| CA-08 | Provider failure | Missing provider configuration blocks without exposing credentials. |
| CA-09 | Process lifecycle | Desktop or Runner starts, reports readiness, and exits cleanly. |
| CA-10 | Scope discipline | Review confirms no unrelated refactor or user-change overwrite. |

## Baseline commands

```sh
./scripts/coding-assistant/doctor.sh
./scripts/coding-assistant/verify.sh common
./scripts/coding-assistant/verify.sh webui
./scripts/coding-assistant/verify.sh rust
```

## Records

- [2026-07-22 initial baseline](baselines/2026-07-22.md)
- [CA-07 — Bash nonzero exit status mapping](evaluations/CA-07-2026-07-22.md)
