#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
command -v pi >/dev/null || { echo "pi is required" >&2; exit 1; }

pnpm install

installed=0
for manifest in "$repo_root"/packages/*/package.json; do
  if node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(manifest.pi ? 0 : 1);
  ' "$manifest"; then
    package_dir="${manifest%/package.json}"
    echo "Installing $(basename "$package_dir")..."
    pi install "$package_dir"
    installed=$((installed + 1))
  fi
done

echo "Installed $installed local Pi packages."
