#!/usr/bin/env bash
# SUNNY unified self-test harness (R16-J).
#
# Composes every shipping test + eval into one command and emits a single
# JSON readiness report at /tmp/sunny_selftest/report.json.
#
#   ./scripts/self_test.sh            # full run (includes BFCL, 5+ min)
#   ./scripts/self_test.sh --fast     # skip BFCL + latency
#   ./scripts/self_test.sh --only=cargo_check,tsc
#
# No -e: we deliberately run every section and aggregate failures.
set -uo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
FAST=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    -h|--help)
      grep '^# ' "$0" | head -20
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths + bootstrap
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="/tmp/sunny_selftest"
REPORT="$OUT_DIR/report.json"
LOG_DIR="$OUT_DIR/logs"

mkdir -p "$OUT_DIR" "$LOG_DIR"

# Concurrent-run guard — use a pid-stamped run dir but keep a stable report path.
RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
RUN_DIR="$OUT_DIR/run-$RUN_ID"
mkdir -p "$RUN_DIR"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

section_enabled() {
  local name="$1"
  if [[ -z "$ONLY" ]]; then return 0; fi
  case ",$ONLY," in
    *",$name,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Cross-platform timeout shim (macOS has gtimeout via coreutils, not timeout).
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  TIMEOUT_BIN=""
fi

run_with_timeout() {
  local secs="$1"; shift
  if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" --preserve-status "$secs" "$@"
  else
    # Poor-man's timeout: background + watchdog.
    "$@" &
    local child=$!
    (
      sleep "$secs"
      if kill -0 "$child" 2>/dev/null; then
        kill -TERM "$child" 2>/dev/null || true
        sleep 2
        kill -KILL "$child" 2>/dev/null || true
      fi
    ) &
    local watchdog=$!
    wait "$child"
    local rc=$?
    kill "$watchdog" 2>/dev/null || true
    return $rc
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

# ---------------------------------------------------------------------------
# Section runners — each writes /tmp/sunny_selftest/<name>.json
# ---------------------------------------------------------------------------

run_cargo_check() {
  local name="cargo_check"
  section_enabled "$name" || { echo "SKIP  $name"; return; }
  echo "RUN   $name"
  local log="$LOG_DIR/$name.log"
  local start end exit_code warnings
  start=$(date +%s)
  ( cd "$REPO_ROOT/src-tauri" && run_with_timeout 900 cargo check --release ) \
    > "$log" 2>&1
  exit_code=$?
  end=$(date +%s)
  warnings=$(grep -cE '^warning:' "$log" || true)
  python3 - "$name" "$exit_code" "$warnings" "$((end-start))" "$log" <<'PY'
import json, sys
name, exit_code, warnings, elapsed, log = sys.argv[1:]
out = {
    "name": name,
    "exit": int(exit_code),
    "warnings": int(warnings),
    "elapsed_sec": int(elapsed),
    "log": log,
}
open(f"/tmp/sunny_selftest/{name}.json", "w").write(json.dumps(out, indent=2))
print(f"      exit={exit_code} warnings={warnings} ({elapsed}s)")
PY
}

run_cargo_test() {
  local name="cargo_test"
  section_enabled "$name" || { echo "SKIP  $name"; return; }
  echo "RUN   $name (batched + capped + fused)"
  local log="$LOG_DIR/$name.log"
  : > "$log"
  local start end exit_code=0 batch_rc

  # Fuse #1 — pre-flight: if the uid is already near the kernel cap, bail
  # loudly before we start spawning. Better a clean FAIL than a locked Mac.
  local proc_used proc_cap proc_free
  proc_used=$(ps -u "$USER" 2>/dev/null | wc -l | tr -d ' ')
  proc_cap=$(sysctl -n kern.maxprocperuid 2>/dev/null || echo 1418)
  proc_free=$(( proc_cap - proc_used ))
  if [[ "$proc_free" -lt 400 ]]; then
    echo "  FATAL: only $proc_free of $proc_cap uid process slots free (in use: $proc_used)"
    echo "  close apps or reboot before retrying $name"
    python3 - "$name" "$log" "$proc_used" "$proc_cap" <<'PY'
import json, sys
name, log, used, cap = sys.argv[1:]
open(f"/tmp/sunny_selftest/{name}.json","w").write(json.dumps({
    "name": name, "exit": 99, "skipped": True,
    "reason": f"insufficient headroom (cap={cap}, used={used})",
    "passed": 0, "failed": 0, "ignored": 0,
    "elapsed_sec": 0, "log": log,
}, indent=2))
PY
    return
  fi

  # Fuse #2 — belt: cap THIS script's subtree below the uid ceiling.
  # Set to (cap - 300) so we use nearly the full kernel budget but still
  # blow up 300 slots before the kernel would — protecting GUI daemons
  # from the same EAGAIN. Previous baseline+400 formula took a snapshot
  # at script start and ran out as test subprocesses pushed the total up.
  local ulimit_target=$(( proc_cap - 300 ))
  ulimit -u "$ulimit_target" 2>/dev/null || true
  echo "  fuse: ulimit -u $ulimit_target (baseline $proc_used, cap $proc_cap, free $proc_free)"

  start=$(date +%s)

  # One batch per top-level src-tauri/src/ directory — except agent_loop,
  # which has 847 tests whose zombie cloud is too large to drain in one
  # reap window. It gets sub-split into its 9 direct subdirectories so
  # each sub-batch leaves a smaller trail.
  local BATCHES=(
    "agent_loop::context_window"
    "agent_loop::critic"
    "agent_loop::dialogue"
    "agent_loop::dispatch"
    "agent_loop::model_router"
    "agent_loop::prompts"
    "agent_loop::providers"
    "agent_loop::reflexion"
    "agent_loop::tools::sandbox"
    "agent_loop::tools"
    "agent_loop"
    "ambient"
    "autopilot"
    "browser"
    "commands"
    "memory"
    "pages"
    "scan"
    "security"
    "tools_compute"
    "voice"
    "world"
  )

  # Waits until the uid process count drops to (initial_baseline + 800)
  # or max_wait seconds elapse — whichever comes first. Empty ps output
  # is treated as "table is full, keep waiting" rather than "table is
  # empty, proceed", which was the bug that produced a fake `free 10666`
  # on a cap-saturated system.
  wait_for_reap() {
    local target=$(( proc_used + 800 ))
    local max_wait=60
    local waited=0 now
    while (( waited < max_wait )); do
      now=$(ps -u "$USER" 2>/dev/null | wc -l | tr -d ' ')
      if [[ -z "$now" || "$now" == "0" ]]; then
        now=99999  # ps pipe failed — assume worst
      fi
      if (( now <= target )); then
        return 0
      fi
      sleep 3
      waited=$(( waited + 3 ))
    done
    echo "  WARN: $now procs after ${max_wait}s reap wait (target $target) — proceeding anyway"
    return 1
  }

  # Caps applied to every cargo invocation below:
  #   CARGO_BUILD_JOBS=2   — caps rustc/link worker count during build
  #   --test-threads=2     — caps concurrent test execution inside one run
  # With both in force, peak concurrent subprocesses stay well under the
  # 1024 ulimit even if individual tests spawn a few helpers each.

  for batch in "${BATCHES[@]}"; do
    # Mid-run budget check — bail if the table is genuinely full. Treat
    # empty ps output as full (it can't fork, so we can't either).
    local now_used now_free
    now_used=$(ps -u "$USER" 2>/dev/null | wc -l | tr -d ' ')
    if [[ -z "$now_used" || "$now_used" == "0" ]]; then
      echo "  ABORT: ps pipe failed (table at or near cap) — stopping cleanly"
      exit_code=99
      break
    fi
    now_free=$(( proc_cap - now_used ))
    if [[ "$now_free" -lt 200 ]]; then
      echo "  ABORT: only $now_free slots free before $batch:: batch — stopping cleanly"
      exit_code=99
      break
    fi

    echo "  [batch] $batch:: (used $now_used, free $now_free)"
    (
      cd "$REPO_ROOT/src-tauri" || exit 1
      export CARGO_BUILD_JOBS=2
      run_with_timeout 300 cargo test --lib --release --no-fail-fast \
        "${batch}::" -- --test-threads=2
    ) 2>&1 | tee -a "$log"
    # PIPESTATUS[0] — cargo's exit, not tee's.
    batch_rc=${PIPESTATUS[0]}
    [[ $batch_rc -ne 0 ]] && exit_code=$batch_rc

    # Active reap — poll until the process count drops back near baseline
    # before starting the next batch. Handles the case where tests leave
    # a zombie cloud that needs launchd several seconds to drain.
    wait_for_reap
  done

  # Catch-all for tests in top-level .rs files (anything not inside the
  # batched directories). libtest --skip is repeatable and matches by
  # substring, so skipping each batched prefix leaves only the leftovers.
  local skip_args=()
  for batch in "${BATCHES[@]}"; do
    skip_args+=(--skip "${batch}::")
  done
  echo "  [batch] top-level (catch-all)"
  (
    cd "$REPO_ROOT/src-tauri" || exit 1
    export CARGO_BUILD_JOBS=2
    run_with_timeout 300 cargo test --lib --release --no-fail-fast \
      -- --test-threads=2 "${skip_args[@]}"
  ) 2>&1 | tee -a "$log"
  batch_rc=${PIPESTATUS[0]}
  [[ $batch_rc -ne 0 ]] && exit_code=$batch_rc

  end=$(date +%s)

  # The parser sums every `test result: …` line in the aggregated log,
  # so per-batch totals add up to the full-suite figure automatically.
  python3 - "$name" "$exit_code" "$((end-start))" "$log" <<'PY'
import json, re, sys
name, exit_code, elapsed, log = sys.argv[1:]
text = open(log, errors="replace").read()
# cargo test emits lines like:
#   test result: ok. 507 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
passed = failed = ignored = 0
for m in re.finditer(r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored", text):
    passed  += int(m.group(1))
    failed  += int(m.group(2))
    ignored += int(m.group(3))
out = {
    "name": name,
    "exit": int(exit_code),
    "passed": passed,
    "failed": failed,
    "ignored": ignored,
    "elapsed_sec": int(elapsed),
    "log": log,
}
open(f"/tmp/sunny_selftest/{name}.json", "w").write(json.dumps(out, indent=2))
print(f"      passed={passed} failed={failed} ignored={ignored} ({elapsed}s)")
PY
}

run_tsc() {
  local name="tsc"
  section_enabled "$name" || { echo "SKIP  $name"; return; }
  echo "RUN   $name"
  local log="$LOG_DIR/$name.log"
  local start end exit_code error_count
  start=$(date +%s)
  ( cd "$REPO_ROOT" && run_with_timeout 300 npx --no-install tsc -b --noEmit --force ) \
    > "$log" 2>&1
  exit_code=$?
  end=$(date +%s)
  error_count=$(grep -cE 'error TS[0-9]+' "$log" || true)
  python3 - "$name" "$exit_code" "$error_count" "$((end-start))" "$log" <<'PY'
import json, sys
name, exit_code, errors, elapsed, log = sys.argv[1:]
out = {
    "name": name,
    "exit": int(exit_code),
    "errors": int(errors),
    "elapsed_sec": int(elapsed),
    "log": log,
}
open(f"/tmp/sunny_selftest/{name}.json", "w").write(json.dumps(out, indent=2))
print(f"      exit={exit_code} errors={errors} ({elapsed}s)")
PY
}

run_smoke() {
  local name="smoke"
  section_enabled "$name" || { echo "SKIP  $name"; return; }
  if [[ ! -f /tmp/sunny_smoke.py ]]; then
    echo "SKIP  $name (missing /tmp/sunny_smoke.py)"
    python3 -c "import json; open('/tmp/sunny_selftest/$name.json','w').write(json.dumps({'name':'$name','skipped':True,'reason':'missing /tmp/sunny_smoke.py'},indent=2))"
    return
  fi
  echo "RUN   $name (up to 600s)"
  local log="$LOG_DIR/$name.log"
  local start end exit_code
  start=$(date +%s)
  # Pre-clear stale detail JSON so a timeout can never be misread as a pass.
  rm -f /tmp/sunny_smoke_r13.json
  run_with_timeout 600 python3 -u /tmp/sunny_smoke.py > "$log" 2>&1
  exit_code=$?
  end=$(date +%s)
  python3 - "$name" "$exit_code" "$((end-start))" "$log" <<'PY'
import json, sys, os
name, exit_code, elapsed, log = sys.argv[1:]
# smoke writes /tmp/sunny_smoke_r13.json (list of case dicts)
passed = total = 0
detail_path = "/tmp/sunny_smoke_r13.json"
cases = []
if os.path.exists(detail_path):
    try:
        cases = json.load(open(detail_path))
        total = len(cases)
        passed = sum(1 for c in cases if c.get("status") == "PASS")
    except Exception as e:
        print(f"      (could not parse {detail_path}: {e})")
out = {
    "name": name,
    "exit": int(exit_code),
    "passed": passed,
    "total": total,
    "elapsed_sec": int(elapsed),
    "detail_json": detail_path,
    "log": log,
}
open(f"/tmp/sunny_selftest/{name}.json", "w").write(json.dumps(out, indent=2))
print(f"      passed={passed}/{total} exit={exit_code} ({elapsed}s)")
PY
}

run_bfcl() {
  local name="bfcl"
  section_enabled "$name" || { echo "SKIP  $name"; return; }
  if [[ "$FAST" -eq 1 ]]; then
    echo "SKIP  $name (--fast)"
    python3 -c "import json; open('/tmp/sunny_selftest/$name.json','w').write(json.dumps({'name':'$name','skipped':True,'reason':'--fast'},indent=2))"
    return
  fi
  if [[ ! -f /tmp/sunny_bfcl.py ]]; then
    echo "SKIP  $name (missing /tmp/sunny_bfcl.py)"
    python3 -c "import json; open('/tmp/sunny_selftest/$name.json','w').write(json.dumps({'name':'$name','skipped':True,'reason':'missing /tmp/sunny_bfcl.py'},indent=2))"
    return
  fi
  echo "RUN   $name (slow — up to 900s)"
  local log="$LOG_DIR/$name.log"
  local start end exit_code
  start=$(date +%s)
  rm -f /tmp/sunny_bfcl.json
  run_with_timeout 900 python3 -u /tmp/sunny_bfcl.py > "$log" 2>&1
  exit_code=$?
  end=$(date +%s)
  python3 - "$name" "$exit_code" "$((end-start))" "$log" <<'PY'
import json, sys, os
name, exit_code, elapsed, log = sys.argv[1:]
detail_path = "/tmp/sunny_bfcl.json"
passed = total = 0
accuracy = None
by_cat = {}
if os.path.exists(detail_path):
    try:
        raw = json.load(open(detail_path))
        summary = raw.get("summary", {})
        passed = summary.get("passed", 0)
        total = summary.get("total", 0)
        accuracy = summary.get("accuracy_pct")
        by_cat = summary.get("by_category", {})
    except Exception as e:
        print(f"      (could not parse {detail_path}: {e})")
out = {
    "name": name,
    "exit": int(exit_code),
    "passed": passed,
    "total": total,
    "accuracy_pct": accuracy,
    "by_category": by_cat,
    "elapsed_sec": int(elapsed),
    "detail_json": detail_path,
    "log": log,
}
open(f"/tmp/sunny_selftest/{name}.json", "w").write(json.dumps(out, indent=2))
print(f"      passed={passed}/{total} accuracy={accuracy}% ({elapsed}s)")
PY
}

run_latency() {
  local name="latency"
  section_enabled "$name" || { echo "SKIP  $name"; return; }
  if [[ "$FAST" -eq 1 ]]; then
    echo "SKIP  $name (--fast)"
    python3 -c "import json; open('/tmp/sunny_selftest/$name.json','w').write(json.dumps({'name':'$name','skipped':True,'reason':'--fast'},indent=2))"
    return
  fi
  if [[ ! -f /tmp/sunny_latency_bench.py ]]; then
    echo "SKIP  $name (missing /tmp/sunny_latency_bench.py)"
    python3 -c "import json; open('/tmp/sunny_selftest/$name.json','w').write(json.dumps({'name':'$name','skipped':True,'reason':'missing /tmp/sunny_latency_bench.py'},indent=2))"
    return
  fi
  echo "RUN   $name (up to 600s)"
  local log="$LOG_DIR/$name.log"
  local start end exit_code
  start=$(date +%s)
  rm -f /tmp/sunny_latency_bench.json
  run_with_timeout 600 python3 -u /tmp/sunny_latency_bench.py > "$log" 2>&1
  exit_code=$?
  end=$(date +%s)
  python3 - "$name" "$exit_code" "$((end-start))" "$log" <<'PY'
import json, sys, os
name, exit_code, elapsed, log = sys.argv[1:]
detail_path = "/tmp/sunny_latency_bench.json"
summary = {}
if os.path.exists(detail_path):
    try:
        raw = json.load(open(detail_path))
        summary = {
            "model": raw.get("model"),
            "whisper_ms": raw.get("whisper_ms"),
            "kokoro_render_ms": raw.get("kokoro_render_ms"),
            "afplay_spawn_ms": raw.get("afplay_spawn_ms"),
            "llm_keys": sorted((raw.get("llm") or {}).keys()),
        }
    except Exception as e:
        print(f"      (could not parse {detail_path}: {e})")
out = {
    "name": name,
    "exit": int(exit_code),
    "summary": summary,
    "elapsed_sec": int(elapsed),
    "detail_json": detail_path,
    "log": log,
}
open(f"/tmp/sunny_selftest/{name}.json", "w").write(json.dumps(out, indent=2))
print(f"      exit={exit_code} ({elapsed}s)")
PY
}

# ---------------------------------------------------------------------------
# Aggregate into report.json
# ---------------------------------------------------------------------------
aggregate_report() {
  python3 - "$TIMESTAMP" "$RUN_DIR" <<'PY'
import json, os, sys, pathlib

timestamp, run_dir = sys.argv[1:]
out_dir = "/tmp/sunny_selftest"

def load(name):
    p = os.path.join(out_dir, f"{name}.json")
    if not os.path.exists(p):
        return {"missing": True}
    try:
        return json.load(open(p))
    except Exception as e:
        return {"error": f"parse failed: {e}"}

cargo_check = load("cargo_check")
cargo_test  = load("cargo_test")
tsc         = load("tsc")
smoke       = load("smoke")
bfcl        = load("bfcl")
latency     = load("latency")

def ok(section, *keys):
    if section.get("skipped") or section.get("missing"):
        return None  # neutral — doesn't affect verdict
    if "exit" in section and section["exit"] != 0:
        return False
    for k in keys:
        v = section.get(k)
        if v is not None and v != 0:
            return False
    return True

signals = {
    "cargo_check": ok(cargo_check),
    "cargo_test":  ok(cargo_test, "failed"),
    "tsc":         ok(tsc, "errors"),
    "smoke":       (smoke.get("passed") == smoke.get("total")) if not smoke.get("skipped") and smoke.get("total") else None,
    "bfcl":        None if bfcl.get("skipped") else (
        (bfcl.get("accuracy_pct") or 0) >= 85.0
    ),
    "latency":     None if latency.get("skipped") else (latency.get("exit") == 0),
}

# Verdict:
#   - any False -> FAIL
#   - any None (because skipped) with all others True -> DEGRADED
#   - all True -> PASS
values = [v for v in signals.values() if v is not None]
has_false = any(v is False for v in signals.values())
has_skipped = any(v is None for v in signals.values())
if has_false:
    verdict = "FAIL"
elif has_skipped:
    verdict = "DEGRADED"
elif values and all(values):
    verdict = "PASS"
else:
    verdict = "DEGRADED"

report = {
    "timestamp": timestamp,
    "run_dir": run_dir,
    "cargo_check": {
        "exit": cargo_check.get("exit"),
        "warnings": cargo_check.get("warnings"),
        "elapsed_sec": cargo_check.get("elapsed_sec"),
        "skipped": cargo_check.get("skipped", False),
    },
    "cargo_test": {
        "exit": cargo_test.get("exit"),
        "passed": cargo_test.get("passed"),
        "failed": cargo_test.get("failed"),
        "ignored": cargo_test.get("ignored"),
        "elapsed_sec": cargo_test.get("elapsed_sec"),
        "skipped": cargo_test.get("skipped", False),
    },
    "tsc": {
        "exit": tsc.get("exit"),
        "errors": tsc.get("errors"),
        "elapsed_sec": tsc.get("elapsed_sec"),
        "skipped": tsc.get("skipped", False),
    },
    "smoke": {
        "exit": smoke.get("exit"),
        "passed": smoke.get("passed"),
        "total": smoke.get("total"),
        "elapsed_sec": smoke.get("elapsed_sec"),
        "skipped": smoke.get("skipped", False),
    },
    "bfcl": {
        "exit": bfcl.get("exit"),
        "passed": bfcl.get("passed"),
        "total": bfcl.get("total"),
        "accuracy_pct": bfcl.get("accuracy_pct"),
        "by_category": bfcl.get("by_category"),
        "elapsed_sec": bfcl.get("elapsed_sec"),
        "skipped": bfcl.get("skipped", False),
        "skip_reason": bfcl.get("reason") if bfcl.get("skipped") else None,
    },
    "latency": {
        "exit": latency.get("exit"),
        "summary": latency.get("summary"),
        "elapsed_sec": latency.get("elapsed_sec"),
        "skipped": latency.get("skipped", False),
        "skip_reason": latency.get("reason") if latency.get("skipped") else None,
    },
    "signals": signals,
    "verdict": verdict,
}

report_path = os.path.join(out_dir, "report.json")
open(report_path, "w").write(json.dumps(report, indent=2))
# Also snapshot into the run dir so concurrent runs don't clobber history.
open(os.path.join(run_dir, "report.json"), "w").write(json.dumps(report, indent=2))
print(f"\n[aggregate] wrote {report_path}")
print(f"[aggregate] verdict: {verdict}")
PY
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "SUNNY self-test"
echo "  timestamp : $TIMESTAMP"
echo "  repo      : $REPO_ROOT"
echo "  out       : $OUT_DIR"
echo "  run_dir   : $RUN_DIR"
echo "  fast      : $FAST"
echo "  only      : ${ONLY:-<all>}"
echo

OVERALL_START=$(date +%s)

run_cargo_check
run_cargo_test
run_tsc
run_smoke
run_bfcl
run_latency

OVERALL_END=$(date +%s)
echo
echo "Total elapsed: $((OVERALL_END - OVERALL_START))s"

aggregate_report

# Print human summary using the sibling python script.
if [[ -x "$REPO_ROOT/scripts/self_test.py" ]]; then
  echo
  "$REPO_ROOT/scripts/self_test.py" "$REPORT" || true
fi

# Exit code: 0 on PASS, 1 on DEGRADED, 2 on FAIL.
VERDICT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("verdict","UNKNOWN"))' "$REPORT" 2>/dev/null || echo UNKNOWN)"
case "$VERDICT" in
  PASS)     exit 0 ;;
  DEGRADED) exit 1 ;;
  FAIL)     exit 2 ;;
  *)        exit 3 ;;
esac
