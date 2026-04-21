#!/usr/bin/env python3
"""SUNNY self-test human readiness summary (R16-J).

Parses /tmp/sunny_selftest/report.json (or an explicit path) and emits a
~300-word plain-English summary of where SUNNY stands: compilation, unit
tests, type check, live-agent smoke, BFCL tool-calling accuracy, and the
voice-turn latency envelope. Designed to be dropped into a commit message,
a status update, or a Telegram ping.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def load_report(path: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        print(f"error: report not found at {path}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"error: could not parse {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def fmt_section(label: str, body: str) -> str:
    return f"  {label:<14} {body}"


def section_cargo_check(r: dict[str, Any]) -> str:
    if r.get("skipped"):
        return "skipped"
    exit_code = r.get("exit")
    warnings = r.get("warnings")
    verdict = "clean compile" if exit_code == 0 else f"FAILED (exit {exit_code})"
    return f"{verdict}, {warnings} warnings ({r.get('elapsed_sec','?')}s)"


def section_cargo_test(r: dict[str, Any]) -> str:
    if r.get("skipped"):
        return "skipped"
    passed = r.get("passed") or 0
    failed = r.get("failed") or 0
    ignored = r.get("ignored") or 0
    status = "all green" if failed == 0 and passed > 0 else f"{failed} FAIL"
    return f"{passed} passed / {failed} failed / {ignored} ignored — {status}"


def section_tsc(r: dict[str, Any]) -> str:
    if r.get("skipped"):
        return "skipped"
    exit_code = r.get("exit")
    errors = r.get("errors") or 0
    if exit_code == 0 and errors == 0:
        return "type-clean"
    return f"{errors} errors (exit {exit_code})"


def section_smoke(r: dict[str, Any]) -> str:
    if r.get("skipped"):
        return "skipped"
    passed = r.get("passed") or 0
    total = r.get("total") or 0
    return f"{passed}/{total} cases against live ollama"


def section_bfcl(r: dict[str, Any]) -> str:
    if r.get("skipped"):
        return f"skipped ({r.get('skip_reason') or 'n/a'})"
    passed = r.get("passed") or 0
    total = r.get("total") or 0
    acc = r.get("accuracy_pct")
    return f"{passed}/{total} ({acc}%) tool-calling accuracy"


def section_latency(r: dict[str, Any]) -> str:
    if r.get("skipped"):
        return f"skipped ({r.get('skip_reason') or 'n/a'})"
    summary = r.get("summary") or {}
    model = summary.get("model") or "?"
    n = len(summary.get("whisper_ms") or [])
    return f"{n}-run envelope on {model}"


def verdict_blurb(verdict: str) -> str:
    if verdict == "PASS":
        return (
            "SUNNY is GREEN across every layer that ran — compile, unit tests, "
            "type check, live smoke, and every eval that was enabled. Safe to "
            "ship or demo."
        )
    if verdict == "DEGRADED":
        return (
            "SUNNY is YELLOW: every layer that actually ran passed, but one or "
            "more sections were skipped (usually --fast mode or a missing "
            "eval script). Ship with caveats; re-run without --fast before "
            "any customer-visible milestone."
        )
    if verdict == "FAIL":
        return (
            "SUNNY is RED: at least one hard invariant is broken. Do not ship "
            "or demo. Inspect the section(s) flagged false in `signals` and "
            "the per-section log under /tmp/sunny_selftest/logs."
        )
    return f"SUNNY status: {verdict} — inspect report.json manually."


def summarize(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(
        f"SUNNY readiness report — {report.get('timestamp')}"
    )
    lines.append(f"Verdict: {report.get('verdict','UNKNOWN')}")
    lines.append("")
    lines.append(verdict_blurb(report.get("verdict", "UNKNOWN")))
    lines.append("")
    lines.append("Section summary:")
    lines.append(fmt_section("cargo check", section_cargo_check(report.get("cargo_check", {}))))
    lines.append(fmt_section("cargo test",  section_cargo_test(report.get("cargo_test", {}))))
    lines.append(fmt_section("tsc",         section_tsc(report.get("tsc", {}))))
    lines.append(fmt_section("smoke",       section_smoke(report.get("smoke", {}))))
    lines.append(fmt_section("bfcl",        section_bfcl(report.get("bfcl", {}))))
    lines.append(fmt_section("latency",     section_latency(report.get("latency", {}))))
    lines.append("")

    # Human paragraph — the ~300-word readable summary.
    cc = report.get("cargo_check", {}) or {}
    ct = report.get("cargo_test", {}) or {}
    ts = report.get("tsc", {}) or {}
    sm = report.get("smoke", {}) or {}
    bf = report.get("bfcl", {}) or {}
    lt = report.get("latency", {}) or {}

    paragraphs: list[str] = []
    cc_word = "cleanly" if cc.get("exit") == 0 else "with errors"
    ts_errors = ts.get("errors") or 0
    ts_word = (
        "was clean"
        if ts.get("exit") == 0 and ts_errors == 0
        else f"reported {ts_errors} errors"
    )
    paragraphs.append(
        f"Rust side compiled {cc_word} under --release "
        f"({cc.get('warnings','?')} warnings, {cc.get('elapsed_sec','?')}s). "
        f"The library test suite reported {ct.get('passed','?')} passing and "
        f"{ct.get('failed','?')} failing cases across every module covered by "
        f"`cargo test --lib`; {ct.get('ignored','?')} cases stayed ignored. "
        f"Frontend TypeScript compilation {ts_word}."
    )

    if sm.get("skipped"):
        smoke_line = "The live-ollama smoke harness was skipped this run."
    else:
        smoke_line = (
            f"Against a live local ollama, the 19-case composite-tools smoke "
            f"harness returned {sm.get('passed','?')}/{sm.get('total','?')} "
            f"passes — this is the single best indicator that the voice "
            f"persona, streaming path, and tool catalog are wired correctly."
        )
    paragraphs.append(smoke_line)

    if bf.get("skipped"):
        bfcl_line = (
            f"The BFCL tool-calling eval was skipped ({bf.get('skip_reason') or 'n/a'}); "
            f"run without --fast before any release to regenerate the 50-case accuracy number."
        )
    else:
        bfcl_line = (
            f"The 50-case BFCL-style tool-calling eval landed at "
            f"{bf.get('accuracy_pct','?')}% "
            f"({bf.get('passed','?')}/{bf.get('total','?')} correct first-tool calls). "
            f"Category breakdown is in the detail json for regression tracking."
        )
    paragraphs.append(bfcl_line)

    if lt.get("skipped"):
        lat_line = (
            f"Voice-pipeline latency bench was skipped ({lt.get('skip_reason') or 'n/a'})."
        )
    else:
        summary = lt.get("summary") or {}
        lat_line = (
            f"Voice-pipeline latency bench completed on model "
            f"`{summary.get('model','?')}` with "
            f"{len(summary.get('whisper_ms') or [])} runs of the whisper / "
            f"ollama / kokoro / afplay stages; see /tmp/sunny_latency_bench.json for the raw numbers."
        )
    paragraphs.append(lat_line)

    paragraphs.append(verdict_blurb(report.get("verdict", "UNKNOWN")))

    lines.append("\n\n".join(paragraphs))
    lines.append("")
    lines.append("Artifacts:")
    lines.append("  report.json       /tmp/sunny_selftest/report.json")
    lines.append("  per-section json  /tmp/sunny_selftest/<name>.json")
    lines.append("  raw logs          /tmp/sunny_selftest/logs/<name>.log")
    return "\n".join(lines)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sunny_selftest/report.json"
    report = load_report(path)
    print(summarize(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
