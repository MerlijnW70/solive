#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field() {
  awk -v section="[$1]" -v key="$2" '
    /^\[/ { inside = ($0 == section); next }
    inside && $1 == key && $2 == "=" { sub(/^[^=]*=[ ]*"/, ""); sub(/"[ ]*$/, ""); print; found = 1; exit }
    END { if (!found) exit 1 }
  ' "$root/identity.toml" || { echo "identity.toml: missing $1.$2" >&2; exit 1; }
}
name="$(field product name)"
slug="$(field product slug)"
distro="$(field dev wsl_distro)"
repository="$(field security repository)"
licensor="$(field license licensor)"
first_year="$(field license first_year)"
change_date="$(field license change_date)"
change_license="$(field license change_license)"
[[ "$slug" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "identity.toml: slug must match ^[a-z][a-z0-9-]*$" >&2; exit 1; }
[[ "$distro" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "identity.toml: wsl_distro has invalid characters" >&2; exit 1; }
[[ "$repository" =~ ^https://[A-Za-z0-9./_-]+$ ]] || { echo "identity.toml: security.repository must be an https url" >&2; exit 1; }
[[ "$change_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "identity.toml: license.change_date must be YYYY-MM-DD" >&2; exit 1; }
[[ "$first_year" =~ ^[0-9]{4}$ ]] || { echo "identity.toml: license.first_year must be a year" >&2; exit 1; }
busl() {
  printf 'Business Source License 1.1

License text copyright (c) 2017 MariaDB Corporation Ab, All Rights Reserved.
"Business Source License" is a trademark of MariaDB Corporation Ab.

-----------------------------------------------------------------------------

Parameters

Licensor:             %s

Licensed Work:        %s on-chain intent engine: the Solana program in
                      programs/intent_engine and the intent-core library in
                      crates/intent-core.
                      The Licensed Work is (c) %s %s.

Additional Use Grant: You may make production use of the Licensed Work,
                      provided that you do not use it, or a derivative of
                      it, to operate a deployment of the Licensed Work or of
                      a derivative of it other than a deployment made by the
                      Licensor. Auditing, security research, testing on local
                      and test networks, and building, operating and
                      distributing software that interacts with a deployment
                      made by the Licensor, such as wallets, clients,
                      solvers, relayers, cranks and agents, are permitted.

Change Date:          %s

Change License:       %s

' "$licensor" "$name" "$first_year" "$licensor" "$change_date" "$change_license"
  cat "$root/scripts/busl-terms.txt"
}
render() {
  case "$1" in
    README.md) printf '\043 %s\n\nStart here: [Use it from your AI](docs/ai.md), or the [command line quickstart](docs/quickstart.md)\n' "$name" ;;
    scripts/wsl.cmd | packages/core/scripts/wsl.cmd | packages/cli/scripts/wsl.cmd | packages/solver/scripts/wsl.cmd) printf '@wsl.exe -d %s --cd "%%~dp0.." -- %%*\r\n' "$distro" ;;
    programs/intent_engine/src/security.rs) printf '\043[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "intent-engine",
    project_url: "%s",
    contacts: "link:%s/security/advisories/new",
    policy: "%s/security/advisories/new",
    source_code: "%s"
}
' "$repository" "$repository" "$repository" "$repository" ;;
    packages/core/generated/identity.ts) printf 'export const PRODUCT_NAME = "%s";\nexport const PRODUCT_SLUG = "%s";\nexport const PRODUCT_REPOSITORY = "%s";\n' "$name" "$slug" "$repository" ;;
    programs/intent_engine/LICENSE | crates/intent-core/LICENSE) busl ;;
  esac
}
targets=(README.md programs/intent_engine/src/security.rs scripts/wsl.cmd packages/core/scripts/wsl.cmd packages/cli/scripts/wsl.cmd packages/solver/scripts/wsl.cmd packages/core/generated/identity.ts programs/intent_engine/LICENSE crates/intent-core/LICENSE)
drift=0
for target in "${targets[@]}"; do
  if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s <(render "$target") "$root/$target"; then echo "identity drift: $target" >&2; drift=1; fi
  else
    mkdir -p "$(dirname "$root/$target")"
    render "$target" > "$root/$target"
  fi
done
exit "$drift"
