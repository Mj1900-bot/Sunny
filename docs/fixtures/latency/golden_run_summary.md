# Golden-output example — `analyze_latency.ts`

This is what a healthy run of the analyzer looks like on a synthetic 50-turn
JSONL. Compare the first live run against this — shape, column layout, and
verdict lines should all match. Exact numbers will differ.

The synthetic JSONL used here covers five categories from
`docs/fixtures/latency/index.json`:

| category                    | fixtures | budget prep / first / full (ms) |
| --------------------------- | -------- | ------------------------------- |
| `memory_recall_cross_session` | 10       | 200 / 1200 / 2000               |
| `tool_use_single_call`        | 10       | 150 / 900  / 1800               |
| `tool_use_chain_3x`           | 10       | 200 / 1500 / 3500               |
| `adversarial_prompt_injection`| 10       | 100 / 800  / 1600               |
| `voice_pipeline_interactive`  | 10       | 120 / 700  / 1400               |

---

## Command

```
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  scripts/analyze_latency.ts ~/.sunny/latency/runs.jsonl \
  --baseline ~/.sunny/latency/baseline.jsonl
```

## Console output

```
analyze_latency: 50 runs across 5 categories
  source: ~/.sunny/latency/runs.jsonl
  index:  docs/fixtures/latency/index.json
  baseline: ~/.sunny/latency/baseline.jsonl

summary by category
category                       n   stage          p50     p95      p99      budget   status
-----------------------------  --  -------------  ------  -------  -------  -------  ------
adversarial_prompt_injection   10  prep_context   42ms    71ms     76ms     100ms    PASS
                                   first_token    520ms   740ms    780ms    800ms    PASS
                                   full_response  1.10s   1.44s    1.54s    1600ms   PASS

memory_recall_cross_session    10  prep_context   95ms    180ms    195ms    200ms    PASS
                                   first_token    710ms   1.08s    1.16s    1200ms   PASS
                                   full_response  1.55s   1.92s    1.97s    2000ms   PASS

tool_use_chain_3x              10  prep_context   110ms   175ms    190ms    200ms    PASS
                                   first_token    880ms   1.42s    1.48s    1500ms   PASS
                                   full_response  2.60s   3.38s    3.46s    3500ms   PASS

tool_use_single_call           10  prep_context   72ms    128ms    145ms    150ms    PASS
                                   first_token    540ms   850ms    880ms    900ms    PASS
                                   full_response  1.22s   1.68s    1.74s    1800ms   PASS

voice_pipeline_interactive     10  prep_context   58ms    105ms    115ms    120ms    PASS
                                   first_token    430ms   690ms    698ms    700ms    PASS
                                   full_response  960ms   1.32s    1.38s    1400ms   PASS

histogram: prep_context (n=50)
     40ms | #####                                                         5
     48ms | ########                                                      8
     56ms | ##########                                                   10
     64ms | #######                                                       7
     72ms | ######                                                        6
     80ms | ####                                                          4
     88ms | ###                                                           3
     96ms | ###                                                           3
    104ms | ##                                                            2
    112ms | #                                                             1
    120ms | #                                                             1
  [buckets 136ms – 192ms trimmed for brevity — full output has all 20]

histogram: first_token (n=50)
    430ms | ###                                                           3
    500ms | ######                                                        6
    570ms | ########                                                      8
    640ms | #########                                                     9
    710ms | #######                                                       7
    780ms | #####                                                         5
    850ms | ####                                                          4
    920ms | ###                                                           3
    990ms | ##                                                            2
   1.06s  | ##                                                            2
   1.13s  | #                                                             1
  [buckets 1.2s – 1.48s trimmed — tail is sparse]

histogram: full_response (n=50)
    960ms | ##                                                            2
   1.12s  | ####                                                          4
   1.28s  | ########                                                      8
   1.44s  | ##########                                                   10
   1.60s  | ########                                                      8
   1.76s  | ######                                                        6
   1.92s  | ####                                                          4
   2.08s  | ###                                                           3
   2.24s  | ##                                                            2
   2.40s  | #                                                             1
   2.56s  | #                                                             1
  [buckets 2.72s – 3.46s trimmed]

top 10 slowest runs
run_id    category                       fixture                           prep    first   full    violates
--------  -----------------------------  --------------------------------  ------  ------  ------  ---------------
3f2a1c9d  tool_use_chain_3x              tool_use_chain_3x_07              190ms   1.48s   3.46s   within budget
b9e4772a  tool_use_chain_3x              tool_use_chain_3x_02              185ms   1.46s   3.41s   within budget
7d2c88fe  memory_recall_cross_session    mem_recall_cross_session_09       195ms   1.16s   1.97s   within budget
c03f4a21  tool_use_single_call           tool_use_single_call_04           145ms   880ms   1.74s   within budget
f1e9b5a3  memory_recall_cross_session    mem_recall_cross_session_03       180ms   1.08s   1.93s   within budget
aa2b77c0  tool_use_chain_3x              tool_use_chain_3x_10              175ms   1.40s   3.34s   within budget
5e6ff210  tool_use_single_call           tool_use_single_call_08           128ms   850ms   1.69s   within budget
2b1a99de  voice_pipeline_interactive     voice_pipeline_interactive_06     115ms   698ms   1.38s   within budget
d4c7e018  adversarial_prompt_injection   adversarial_prompt_injection_05   76ms    780ms   1.54s   within budget
64a0d7c2  voice_pipeline_interactive     voice_pipeline_interactive_02     105ms   690ms   1.32s   within budget

regression vs baseline (>=10%)
category                       stage          baseline p95  current p95  delta    flag
-----------------------------  -------------  ------------  -----------  -------  -----------
tool_use_chain_3x              first_token    1.28s         1.42s        10.9%    REGRESSION
memory_recall_cross_session    full_response  1.86s         1.92s        3.2%     stable
tool_use_single_call           prep_context   135ms         128ms        -5.2%    stable
adversarial_prompt_injection   first_token    780ms         740ms        -5.1%    stable
voice_pipeline_interactive     full_response  1.35s         1.32s        -2.2%    stable
[remaining stages trimmed — all "stable"]

verdict: SLA: GREEN   baseline: REGRESSION
```

Exit code: **2** (regression flagged; SLA still green).

## `--json` output (trimmed)

Same invocation with `--json` appended:

```json
{
  "version": 1,
  "runs": 50,
  "anyRed": false,
  "anyRegression": true,
  "categories": [
    {
      "category": "adversarial_prompt_injection",
      "count": 10,
      "red": false,
      "stages": {
        "prep_context":   { "p50": 42,   "p95": 71,   "p99": 76,   "budget": 100  },
        "first_token":    { "p50": 520,  "p95": 740,  "p99": 780,  "budget": 800  },
        "full_response":  { "p50": 1100, "p95": 1440, "p99": 1540, "budget": 1600 }
      }
    }
    // … four more categories elided
  ],
  "regressions": [
    {
      "category": "tool_use_chain_3x",
      "stage": "first_token",
      "baselineP95": 1280,
      "currentP95": 1420,
      "deltaPct": 0.1094,
      "regression": true
    }
  ]
}
```

The regression-gate script parses `anyRegression` and the `regressions[]`
array; it does not need the human-readable table.

## Reading the verdict line

- `SLA: GREEN` — every category's p95 is within its SLA budget.
- `SLA: RED`   — at least one category's p95 blew the budget. Exit 1.
- `baseline: OK` — every overlapping stage within 10% of baseline.
- `baseline: REGRESSION` — one or more stages >=10% slower. Exit 2.

If both fire, exit code is 2 (regression takes precedence for gate signalling).
Operators should scan the summary table first, then the top-10 for culprits,
then the regression table to decide whether to block the merge.
