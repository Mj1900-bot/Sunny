#!/bin/sh
# pre-commit-latency.sh — Wave 3 regression gate for Sunny HUD's 2s SLA.
#
# Fires when a staged change touches a perf-sensitive path. Reads the most
# recent latency-harness output at ~/.sunny/latency/runs.jsonl, compares it
# against the committed baseline, and blocks the commit on any >=10% p95
# regression in any stage.
#
# Fork-bomb safety: this hook NEVER runs cargo, pnpm, npm, ollama, or anything
# that starts Tauri/daemons. It only reads files and shells out to `node` to
# run scripts/analyze_latency.ts in --json mode.
#
# Exit codes (mirrors scripts/analyze_latency.ts where it makes sense):
#   0 — pass, skip (non-perf diff), or stale-warning with no regression
#   1 — blocked: regression >=10% or SLA red
#
# Portability: POSIX sh. No bash arrays, no `mapfile`, no `[[ ]]`.
# Override with `git commit --no-verify` (audited — see footer message).

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 0

RUNS_JSONL="${SUNNY_LATENCY_RUNS:-${HOME}/.sunny/latency/runs.jsonl}"
BASELINE="${SUNNY_LATENCY_BASELINE:-${REPO_ROOT}/docs/fixtures/latency/baselines/current.json}"
ANALYZER="${REPO_ROOT}/scripts/analyze_latency.ts"
STALE_SECS=$((24 * 60 * 60))

# --- 1. Is any staged file perf-sensitive? --------------------------------
# The gate is a no-op for docs-only / UI-only commits. Pattern mirrors the
# brief: agent_loop/, memory/, ai.rs, and agent_loop/providers/ (the last
# is a sub-tree of the first but listed explicitly for intent).
PERF_RE='^src-tauri/src/agent_loop/|^src-tauri/src/memory/|^src-tauri/src/ai\.rs$|^src-tauri/src/agent_loop/providers/'

# Handle the initial commit (no HEAD yet) gracefully.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  DIFF_CMD="git diff --cached --name-only --diff-filter=ACMR"
else
  DIFF_CMD="git diff --cached --name-only --diff-filter=ACMR"
fi

DIFF_HITS="$(${DIFF_CMD} | grep -E "${PERF_RE}" || true)"

if [ -z "${DIFF_HITS}" ]; then
  # No perf-sensitive paths touched — gate is silent.
  exit 0
fi

echo "pre-commit-latency: perf-sensitive paths touched:"
echo "${DIFF_HITS}" | sed 's/^/  /'

# --- 2. Pre-flight: harness output present? --------------------------------
if [ ! -f "${RUNS_JSONL}" ]; then
  cat >&2 <<EOF

pre-commit-latency: BLOCK — no harness output found.
  expected: ${RUNS_JSONL}

  Run the dev harness first:
    # from inside the Tauri dev shell (operator-run, not the hook):
    invoke('latency_run_fixture', { ... })  # see src-tauri/src/latency_harness.rs

  Or export SUNNY_LATENCY_RUNS=/path/to/runs.jsonl to point at a different file.
  Override (audited): git commit --no-verify
EOF
  exit 1
fi

# --- 3. Staleness warning (non-blocking) -----------------------------------
# Portable mtime: BSD stat (macOS) uses -f %m; GNU stat (Linux) uses -c %Y.
if stat -f %m "${RUNS_JSONL}" >/dev/null 2>&1; then
  MTIME="$(stat -f %m "${RUNS_JSONL}")"
else
  MTIME="$(stat -c %Y "${RUNS_JSONL}" 2>/dev/null || echo 0)"
fi
NOW="$(date +%s)"
AGE=$((NOW - MTIME))
if [ "${AGE}" -gt "${STALE_SECS}" ]; then
  HOURS=$((AGE / 3600))
  echo "pre-commit-latency: WARN — runs.jsonl is ${HOURS}h old (>24h)" >&2
  echo "  re-run harness before committing perf-sensitive changes" >&2
  # Continue — stale is a warning, not a block. The analyzer result still
  # gates us in case those stale numbers already show a regression.
fi

# --- 4. Analyzer available? ------------------------------------------------
if [ ! -f "${ANALYZER}" ]; then
  echo "pre-commit-latency: BLOCK — analyzer missing at ${ANALYZER}" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit-latency: BLOCK — node not on PATH (required for analyzer)" >&2
  exit 1
fi

# --- 5. Baseline optional but expected -------------------------------------
BASELINE_ARGS=""
if [ -f "${BASELINE}" ]; then
  BASELINE_ARGS="--baseline ${BASELINE}"
else
  echo "pre-commit-latency: note — no baseline at ${BASELINE}; running SLA-only check" >&2
fi

# --- 6. Run analyzer in --json mode ----------------------------------------
# Capture stdout (the JSON summary) and stderr separately. Exit code convention
# from analyze_latency.ts: 0 = green, 1 = SLA red, 2 = regression, 64/66 = usage.
TMP_OUT="$(mktemp -t sunny-latency-XXXXXX)"
TMP_ERR="$(mktemp -t sunny-latency-err-XXXXXX)"
# shellcheck disable=SC2086
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  "${ANALYZER}" "${RUNS_JSONL}" ${BASELINE_ARGS} --json \
  >"${TMP_OUT}" 2>"${TMP_ERR}"
RC=$?

if [ "${RC}" -eq 64 ] || [ "${RC}" -eq 66 ]; then
  echo "pre-commit-latency: BLOCK — analyzer usage/load error (exit ${RC})" >&2
  cat "${TMP_ERR}" >&2
  rm -f "${TMP_OUT}" "${TMP_ERR}"
  exit 1
fi

# --- 7. Parse the JSON summary ---------------------------------------------
# Keep the shell side lightweight: ask `node` to do the parsing since we already
# depend on it. This avoids a hard jq dependency and handles JSON safely.
SUMMARY="$(
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
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
    const out = {
      anyRed: !!s.anyRed,
      anyRegression: !!s.anyRegression,
      runs: s.runs || 0,
      topRegressions: topRegs,
      topRed: topRed.slice(0, 3),
    };
    process.stdout.write(JSON.stringify(out));
  ' "${TMP_OUT}"
)"

if [ -z "${SUMMARY}" ]; then
  echo "pre-commit-latency: BLOCK — could not parse analyzer output" >&2
  cat "${TMP_ERR}" >&2
  rm -f "${TMP_OUT}" "${TMP_ERR}"
  exit 1
fi

ANY_RED="$(printf '%s' "${SUMMARY}"  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(d).anyRed)))')"
ANY_REG="$(printf '%s' "${SUMMARY}"  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(d).anyRegression)))')"

if [ "${ANY_RED}" != "true" ] && [ "${ANY_REG}" != "true" ]; then
  echo "pre-commit-latency: PASS — SLA green, no regression vs baseline"
  rm -f "${TMP_OUT}" "${TMP_ERR}"
  exit 0
fi

# --- 8. Failure report: top 3 slowest / worst regressions ------------------
echo "" >&2
echo "pre-commit-latency: BLOCKED" >&2
echo "  source:   ${RUNS_JSONL}" >&2
if [ -n "${BASELINE_ARGS}" ]; then
  echo "  baseline: ${BASELINE}" >&2
fi
echo "" >&2

printf '%s' "${SUMMARY}" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c);
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    const fmt = v => v >= 1000 ? (v/1000).toFixed(2) + "s" : v.toFixed(0) + "ms";
    if (s.anyRegression) {
      console.error("  top regressions (>=10% p95 vs baseline):");
      for (const r of s.topRegressions) {
        const pct = (r.deltaPct * 100).toFixed(1);
        console.error(`    ${r.category} / ${r.stage}: ${fmt(r.baselineP95)} -> ${fmt(r.currentP95)} (+${pct}%)`);
      }
    }
    if (s.anyRed) {
      if (s.anyRegression) console.error("");
      console.error("  SLA violations (p95 over budget):");
      for (const r of s.topRed) {
        const ratio = (r.p95 / r.budget).toFixed(2);
        console.error(`    ${r.category} / ${r.stage}: p95 ${fmt(r.p95)} > budget ${fmt(r.budget)}  (x${ratio})`);
      }
    }
  });
' >&2

cat >&2 <<EOF

  full report:
    node --experimental-strip-types --no-warnings=ExperimentalWarning \\
      scripts/analyze_latency.ts ${RUNS_JSONL}${BASELINE_ARGS:+ ${BASELINE_ARGS}}

  Override (AUDITED — tracked via llm_turns.kind='override' where the schema
  supports it; otherwise logged against this commit SHA):
    git commit --no-verify

  New baseline? Baselines are not auto-updated. Requires explicit sign-off
  from sunny-test-sla-steward before docs/fixtures/latency/baselines/current.json
  is rewritten.
EOF

rm -f "${TMP_OUT}" "${TMP_ERR}"
exit 1
