#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
failures=0

pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "$1 is available"
  else
    fail "$1 is required but was not found"
  fi
}

require_file() {
  if [[ -f "$repo_root/$1" ]]; then
    pass "$1 exists"
  else
    fail "$1 is missing"
  fi
}

printf 'Coding assistant environment doctor\n'
printf 'Repository: %s\n\n' "$repo_root"

for command_name in git cargo node npm; do
  require_command "$command_name"
done

if command -v dotslash >/dev/null 2>&1; then
  pass "dotslash is available"
else
  warn "dotslash is unavailable; Rust proto builds may need it"
fi

for relative_path in AGENTS.md Cargo.toml run webui/package.json \
  scripts/coding-assistant/verify.sh docs/coding-assistant/evaluation.md; do
  require_file "$relative_path"
done

if [[ "$repo_root" == *" "* ]]; then
  pass "space-containing checkout detected; Rust checks use an external target directory"
fi

if command -v node >/dev/null 2>&1 && [[ -f "$repo_root/webui/package.json" ]]; then
  if node -e '
    const scripts = require(process.argv[1]).scripts || {};
    for (const name of ["build", "test:registry", "test:runner"]) {
      if (!scripts[name]) process.exit(1);
    }
  ' "$repo_root/webui/package.json"; then
    pass "required WebUI scripts are defined"
  else
    fail "webui/package.json is missing a required validation script"
  fi
fi

runtime_home="${GROK_HOME:-$repo_root/.personal-grok}"
if [[ -n "${XAI_API_KEY:-}" ]]; then
  pass "XAI_API_KEY is configured for the default Grok 4.5 profile (value hidden)"
elif [[ -f "$runtime_home/auth.json" ]]; then
  pass "xAI login state exists for the default Grok 4.5 profile (contents not read)"
else
  warn "xAI login or XAI_API_KEY was not detected; Grok 4.5 model-backed acceptance cannot run"
fi

if [[ -n "${MIMO_API_KEY:-}" ]]; then
  pass "MIMO_API_KEY is configured for the optional MiMo profile (value hidden)"
else
  warn "MIMO_API_KEY is not configured; optional MiMo acceptance cannot run"
fi

if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  pass "DEEPSEEK_API_KEY is configured (value hidden)"
else
  warn "DEEPSEEK_API_KEY is not configured; DeepSeek acceptance cannot run"
fi

if command -v git >/dev/null 2>&1 && git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  changed_count="$(git -C "$repo_root" status --porcelain | wc -l | tr -d ' ')"
  if [[ "$changed_count" == "0" ]]; then
    pass "working tree is clean"
  else
    warn "working tree has $changed_count changed or untracked entries; preserve them"
  fi
fi

printf '\n'
if (( failures > 0 )); then
  printf 'Doctor found %d blocking issue(s).\n' "$failures" >&2
  exit 1
fi
printf 'Doctor found no blocking environment issues.\n'
