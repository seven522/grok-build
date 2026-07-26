#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
verification_target="${1:-common}"

usage() {
  cat <<'EOF'
Usage: ./scripts/coding-assistant/verify.sh <common|webui|rust|all>

  common  Validate assistant artifacts and shell entrypoints.
  webui   Run common checks, WebUI tests, and production build.
  rust    Run common checks and targeted Rust compilation.
  all     Run both WebUI and Rust verification.
EOF
}

run_common() {
  printf '\n== Common checks ==\n'
  bash -n "$repo_root/run"
  bash -n "$repo_root/scripts/coding-assistant/doctor.sh"
  bash -n "$repo_root/scripts/coding-assistant/verify.sh"
  node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    for (const heading of ["Required task protocol", "Validation routing", "Evidence standard"]) {
      if (!text.includes(`## ${heading}`)) throw new Error(`AGENTS.md is missing: ${heading}`);
    }
  ' "$repo_root/AGENTS.md"
  node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const safeServe = `cargo run -p xai-grok-pager-bin -- --sandbox "$sandbox" --permission-mode default --model "$model_profile" agent serve`;
    if (!text.includes(`web-agent) sandbox="workspace" ;;`) || !text.includes(safeServe)) {
      throw new Error("./run web-agent must start agent serve with workspace sandboxing and permission-mode default");
    }
  ' "$repo_root/run"
}

run_webui() {
  printf '\n== WebUI checks ==\n'
  (cd "$repo_root/webui" && npm run test:registry && npm run test:runner && npm run test:navigation && npm run test:conversation && npm run test:automations && npm run test:desktop && npm run test:frontend-architecture && npm run test:typography && npm run build && npm run build:desktop)
}

run_rust() {
  printf '\n== Targeted Rust check ==\n'
  (
    cd "$repo_root"
    export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/grok-build-target}"
    cargo check -p xai-grok-pager-bin
  )
}

case "$verification_target" in
  common) run_common ;;
  webui) run_common; run_webui ;;
  rust) run_common; run_rust ;;
  all) run_common; run_webui; run_rust ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

printf '\nVerification target "%s" passed.\n' "$verification_target"
