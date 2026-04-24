#!/usr/bin/env bash
# verify_latency_fixtures.sh
#
# Hash-lock verifier for Sunny HUD latency fixtures.
# Recomputes sha256 of each fixture file (excluding the sha256 field itself,
# with sorted keys and compact separators — the same canonical form used by
# scripts/gen_latency_fixtures.py) and fails loudly on any mismatch.
#
# Exit codes:
#   0 — every fixture + the index match their stored hashes
#   1 — at least one fixture drifted, or the index is inconsistent
#   2 — required tool missing (jq, shasum, python3)
#
# No network, no cargo, no pnpm, no daemons. Safe to wire into pre-commit.

set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${ROOT_DIR}/docs/fixtures/latency"
INDEX_FILE="${FIXTURE_DIR}/index.json"

for bin in jq shasum python3; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "verify_latency_fixtures: missing required tool: ${bin}" >&2
    exit 2
  fi
done

if [[ ! -d "${FIXTURE_DIR}" ]]; then
  echo "verify_latency_fixtures: fixture directory not found: ${FIXTURE_DIR}" >&2
  exit 1
fi

if [[ ! -f "${INDEX_FILE}" ]]; then
  echo "verify_latency_fixtures: index.json missing" >&2
  exit 1
fi

fail=0
checked=0

# Canonicalise JSON the same way the generator does:
#   python3 -c "json.dumps(obj, sort_keys=True, separators=(',',':'))" with sha256 stripped.
canonical_hash() {
  python3 - "$1" <<'PY'
import hashlib, json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    obj = json.load(f)
obj.pop("sha256", None)
payload = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
sys.stdout.write(hashlib.sha256(payload).hexdigest())
PY
}

while IFS= read -r -d '' fixture; do
  stored=$(jq -r '.sha256 // empty' "${fixture}")
  if [[ -z "${stored}" ]]; then
    echo "MISSING_HASH  ${fixture#${ROOT_DIR}/}" >&2
    fail=$((fail + 1))
    continue
  fi
  computed=$(canonical_hash "${fixture}")
  if [[ "${stored}" != "${computed}" ]]; then
    echo "DRIFT         ${fixture#${ROOT_DIR}/}" >&2
    echo "  stored   = ${stored}" >&2
    echo "  computed = ${computed}" >&2
    fail=$((fail + 1))
  fi
  checked=$((checked + 1))
# Only verify fixtures inside a category subdirectory. Sibling artefacts at
# the fixture root (e.g. load_shapes.json owned by sunny-test-load-shape-designer)
# are not part of the hash-locked corpus.
done < <(find "${FIXTURE_DIR}" -mindepth 2 -type f -name '*.json' -print0)

# Index cross-check: every fixture listed exists with matching hash,
# and every fixture on disk is listed.
index_total=$(jq -r '.total_fixtures' "${INDEX_FILE}")
disk_total=$(find "${FIXTURE_DIR}" -mindepth 2 -type f -name '*.json' | wc -l | tr -d ' ')
if [[ "${index_total}" != "${disk_total}" ]]; then
  echo "COUNT_MISMATCH index.total_fixtures=${index_total} disk=${disk_total}" >&2
  fail=$((fail + 1))
fi

while IFS=$'\t' read -r path want; do
  full="${FIXTURE_DIR}/${path}"
  if [[ ! -f "${full}" ]]; then
    echo "INDEX_ORPHAN  ${path} listed but file absent" >&2
    fail=$((fail + 1))
    continue
  fi
  got=$(jq -r '.sha256' "${full}")
  if [[ "${got}" != "${want}" ]]; then
    echo "INDEX_DRIFT   ${path}" >&2
    echo "  index = ${want}" >&2
    echo "  file  = ${got}" >&2
    fail=$((fail + 1))
  fi
done < <(jq -r '.fixtures[] | [.path, .sha256] | @tsv' "${INDEX_FILE}")

if [[ "${fail}" -gt 0 ]]; then
  echo "verify_latency_fixtures: FAILED — ${fail} problem(s) across ${checked} fixtures" >&2
  exit 1
fi

echo "verify_latency_fixtures: OK — ${checked} fixtures hash-locked, index consistent"
exit 0
