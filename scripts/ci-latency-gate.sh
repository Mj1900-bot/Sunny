#!/bin/sh
# ci-latency-gate.sh — CI variant of the regression gate.
#
# Same logic as scripts/hooks/pre-commit-latency.sh, but:
#   - reads the harness output from an artifact path passed as $1
#     (e.g. an actions/download-artifact path in a future GitHub workflow)
#   - does NOT consult `git diff` — CI runs the full gate on every PR
#   - does NOT short-circuit on docs-only changes (up to the workflow to
#     decide whether to invoke this step via path filters)
#   - emits a GitHub-actions-friendly error annotation when the gate fails
#
# Fork-bomb safety: no cargo, no pnpm, no ollama, no Tauri.
#
# Exit codes (mirrors scripts/analyze_latency.ts):
#   0 — SLA green and no regression
#   1 — SLA red or regression >=10% vs baseline
#   2 — usage error (missing artifact, missing analyzer)
#
# Usage:
#   scripts/ci-latency-gate.sh <path-to-runs.jsonl> [--baseline <path>]
#
# The baseline defaults to docs/fixtures/latency/baselines/current.json.

set -u

if [ $# -lt 1 ]; then
  cat >&2 <<EOF
ci-latency-gate: usage: $0 <runs.jsonl> [--baseline <path>]
EOF
  exit 2
fi

RUNS_JSONL="$1"
shift

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="${REPO_ROOT}/docs/fixtures/latency/baselines/current.json"
ANALYZER="${REPO_ROOT}/scripts/analyze_latency.ts"

while [ $# -gt 0 ]; do
  case "$1" in
    --baseline)
      shift
      if [ $# -lt 1 ]; then
        echo "ci-latency-gate: --baseline requires a path" >&2
        exit 2
      fi
      BASELINE="$1"
      shift
      ;;
    -h|--help)
      cat <<EOF
ci-latency-gate: compare harness output against baseline in CI.

  runs.jsonl            path to the harness artifact (JSONL)
  --baseline <path>     baseline JSON (default: docs/fixtures/latency/baselines/current.json)
EOF
      exit 0
      ;;
    *)
      echo "ci-latency-gate: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# --- 1. Pre-flight checks --------------------------------------------------
if [ ! -f "${RUNS_JSONL}" ]; then
  echo "::error::ci-latency-gate: runs artifact missing: ${RUNS_JSONL}"
  exit 2
fi

if [ ! -f "${ANALYZER}" ]; then
  echo "::error::ci-latency-gate: analyzer missing: ${ANALYZER}"
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "::error::ci-latency-gate: node not on PATH"
  exit 2
fi

BASELINE_ARGS=""
if [ -f "${BASELINE}" ]; then
  BASELINE_ARGS="--baseline ${BASELINE}"
else
  echo "::warning::ci-latency-gate: no baseline at ${BASELINE}; running SLA-only check"
fi

# --- 2. Run the analyzer ---------------------------------------------------
TMP_OUT="$(mktemp -t sunny-latency-ci-XXXXXX)"
TMP_ERR="$(mktemp -t sunny-latency-ci-err-XXXXXX)"

# shellcheck disable=SC2086
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  "${ANALYZER}" "${RUNS_JSONL}" ${BASELINE_ARGS} --json \
  >"${TMP_OUT}" 2>"${TMP_ERR}"
RC=$?

if [ "${RC}" -eq 64 ] || [ "${RC}" -eq 66 ]; then
  echo "::error::ci-latency-gate: analyzer usage/load error (exit ${RC})"
  sed 's/^/::error::/' "${TMP_ERR}" >&2
  rm -f "${TMP_OUT}" "${TMP_ERR}"
  exit 2
fi

# --- 3. Parse + report -----------------------------------------------------
REPORT="$(
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const fmt = v => v >= 1000 ? (v/1000).toFixed(2) + "s" : v.toFixed(0) + "ms";
    const topRegs = (s.regressions || [])
      .filter(r => r.regression)
      .sort((a, b) => b.deltaPct - a.deltaPct)
      .slice(0, 3);
    const topRed = [];
    for (const cat of s.categories || []) {
      if (!cat.red) continue;
      for (const [stage, info] of Object.entries(cat.stages || {})) {
        if (info.budget != null && info.p95 > info.budget) {
          topRed.push({ category: cat.category, stage, p95: info.p95, budget: info.budget });
        }
      }
    }
    topRed.sort((a, b) => (b.p95 / b.budget) - (a.p95 / a.budget));
    const out = [];
    out.push(`ANY_RED=${!!s.anyRed}`);
    out.push(`ANY_REG=${!!s.anyRegression}`);
    out.push(`RUNS=${s.runs || 0}`);
    out.push("---REGRESSIONS---");
    for (const r of topRegs) {
      const pct = (r.deltaPct * 100).toFixed(1);
      out.push(`${r.category} / ${r.stage}: ${fmt(r.baselineP95)} -> ${fmt(r.currentP95)} (+${pct}%)`);
    }
    out.push("---REDLINES---");
    for (const r of topRed.slice(0, 3)) {
      const ratio = (r.p95 / r.budget).toFixed(2);
      out.push(`${r.category} / ${r.stage}: p95 ${fmt(r.p95)} > budget ${fmt(r.budget)}  (x${ratio})`);
    }
    process.stdout.write(out.join("\n"));
  ' "${TMP_OUT}"
)"

ANY_RED="$(printf '%s\n' "${REPORT}" | grep '^ANY_RED=' | cut -d= -f2)"
ANY_REG="$(printf '%s\n' "${REPORT}" | grep '^ANY_REG=' | cut -d= -f2)"
RUNS="$(printf '%s\n' "${REPORT}"    | grep '^RUNS='    | cut -d= -f2)"

echo "ci-latency-gate: analyzed ${RUNS} runs"

if [ "${ANY_RED}" != "true" ] && [ "${ANY_REG}" != "true" ]; then
  echo "ci-latency-gate: PASS — SLA green, no regression vs baseline"
  rm -f "${TMP_OUT}" "${TMP_ERR}"
  exit 0
fi

# Failure path — emit annotations for GitHub's check surface.
echo "::group::ci-latency-gate failure detail"
if [ "${ANY_REG}" = "true" ]; then
  echo "::error::Latency regression >=10% detected vs baseline (see summary below)"
  printf '%s\n' "${REPORT}" | sed -n '/^---REGRESSIONS---/,/^---REDLINES---/p' | sed '1d;$d' | while IFS= read -r line; do
    [ -z "${line}" ] && continue
    echo "::error::regression: ${line}"
  done
fi
if [ "${ANY_RED}" = "true" ]; then
  echo "::error::SLA violation (p95 over budget)"
  printf '%s\n' "${REPORT}" | sed -n '/^---REDLINES---/,$p' | sed '1d' | while IFS= read -r line; do
    [ -z "${line}" ] && continue
    echo "::error::sla: ${line}"
  done
fi

echo ""
echo "full report:"
echo "  node --experimental-strip-types --no-warnings=ExperimentalWarning \\"
echo "    scripts/analyze_latency.ts ${RUNS_JSONL}${BASELINE_ARGS:+ ${BASELINE_ARGS}}"
echo "::endgroup::"

rm -f "${TMP_OUT}" "${TMP_ERR}"
exit 1
