# Coding Agent Operating Rules

These rules apply to every task in this repository. The goal is reliable,
scope-controlled engineering, not the largest possible patch.

## Repository facts

- The upstream product is a Rust workspace. The root `Cargo.toml` is generated;
  treat it as read-only and edit per-crate manifests instead.
- `webui/` is the local React, TypeScript, Vite, and Electron RunBuild client.
- A project is a durable working directory (`cwd`). Do not model a project as
  only a frontend card or inject its full context into every chat turn.
- Use `.personal-grok/` only for isolated local runtime state. Never commit API
  keys, tokens, `.env` contents, session data, or generated logs.
- The repository path contains a space. Use an external Rust target directory,
  such as `/tmp/grok-build-target`.
- Isolated source trees used for red-green comparison must use different Cargo
  target directories. Sharing one target can run a stale test binary from the
  other source tree.

## Required task protocol

1. Inspect `git status`, affected files, and existing tests before editing.
2. Establish a reproducible baseline or state why reproduction is unavailable.
3. Identify the smallest module that owns the behavior.
4. Make the smallest relevant change. A bug fix does not authorize unrelated
   refactoring, new architecture, formatting churn, or broad test additions.
5. Run checks proportional to the changed surface.
6. Report changed files, fresh verification evidence, and uncertainty.

Multi-command verification must use `set -euo pipefail` or explicit `&&`
chaining so a later successful command cannot hide an earlier failure.

Preserve all pre-existing user changes. Never discard or overwrite unrelated
work to make a patch easier.

## Validation routing

Start with the read-only environment check:

```sh
./scripts/coding-assistant/doctor.sh
```

Then choose the narrowest relevant verification:

```sh
./scripts/coding-assistant/verify.sh common
./scripts/coding-assistant/verify.sh webui
./scripts/coding-assistant/verify.sh rust
./scripts/coding-assistant/verify.sh all
```

- Rust changes: run the closest crate tests, then targeted `cargo check`. Do
  not build the full workspace by default.
- WebUI changes: run the relevant Node test, then the TypeScript/Vite build.
- Shell changes: run `bash -n` and a non-effectful help or diagnostic path.
- Runtime, session, sandbox, or permission changes require an end-to-end check
  in addition to compilation.

## Evidence standard

Keep these outcomes separate:

1. The service or tool is reachable.
2. The requested action was attempted.
3. The resulting state was read back from the owning system.
4. The UI maps that state correctly.

An HTTP 200, tool receipt, process start, or generated explanation alone is not
proof of the requested result. Never claim a check passed when it was not run;
record it as blocked or not run with the reason.

## Security and effect boundaries

- Read secrets only from the approved process environment. Never print their
  values or copy them into repository files.
- Use read-only diagnostics before effectful commands.
- Do not send external messages, publish, push, or change external state unless
  the task explicitly requires it.
- Treat sandbox denial, missing credentials, and protected resources as
  explicit blocked states rather than retrying blindly.
