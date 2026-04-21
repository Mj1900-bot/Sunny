// Inline CSS for the command-palette DOM. Rendered inside a <style> tag in
// the CommandBar component so it scopes cleanly and avoids polluting the
// global stylesheet.

export const CMDK_CSS = `
        .cmdk-backdrop {
          position: fixed; inset: 0; z-index: 1100;
          background: rgba(0, 0, 0, 0.62); backdrop-filter: blur(6px);
          display: flex; align-items: flex-start; justify-content: center;
          padding-top: 14vh;
          animation: fadeIn 0.18s ease;
        }
        @media (prefers-reduced-transparency: reduce) {
          .cmdk-backdrop {
            backdrop-filter: none;
            background: rgba(0, 0, 0, 0.88);
          }
        }
        .cmdk-panel {
          width: 620px; max-width: calc(100vw - 48px);
          background: rgba(5, 15, 22, 0.96);
          border: 1px solid var(--line);
          color: var(--ink); font-family: var(--label);
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(57, 229, 255, 0.18);
          position: relative;
        }
        .cmdk-panel::before, .cmdk-panel::after {
          content: ""; position: absolute; width: 12px; height: 12px;
          border: 1px solid var(--cyan); pointer-events: none;
        }
        .cmdk-panel::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
        .cmdk-panel::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
        .cmdk-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 12px 16px; border-bottom: 1px solid var(--line-soft);
          background: linear-gradient(90deg, rgba(57, 229, 255, 0.14), transparent);
        }
        .cmdk-head h2 {
          margin: 0; font-family: var(--display); font-weight: 800;
          letter-spacing: 0.3em; color: var(--cyan); font-size: 13px;
        }
        .cmdk-head button {
          all: unset; cursor: pointer; font-size: 22px; line-height: 1;
          color: var(--ink-2); padding: 0 6px;
        }
        .cmdk-head button:hover { color: var(--cyan); }
        .cmdk-input {
          width: 100%; box-sizing: border-box;
          background: rgba(4, 10, 16, 0.7); color: var(--ink);
          border: 0; border-bottom: 1px solid var(--line-soft);
          padding: 14px 16px; outline: none;
          font-family: var(--mono); font-size: 13px; letter-spacing: 0.12em;
        }
        .cmdk-input::placeholder { color: var(--ink-dim); }
        .cmdk-input:focus { border-bottom-color: var(--cyan); }
        .cmdk-list {
          max-height: 44vh; overflow-y: auto; padding: 6px 0;
        }
        .cmdk-section {
          padding: 8px 16px 4px;
          font-family: var(--display); font-size: 10px; letter-spacing: 0.28em;
          color: var(--cyan); font-weight: 700;
        }
        .cmdk-item {
          all: unset; display: flex; justify-content: space-between; align-items: center;
          width: 100%; box-sizing: border-box;
          padding: 10px 16px; cursor: pointer;
          font-family: var(--mono); font-size: 12.5px; color: var(--ink);
          border-left: 2px solid transparent;
        }
        .cmdk-item.active {
          background: rgba(57, 229, 255, 0.12);
          border-left-color: var(--cyan);
          color: #fff;
        }
        .cmdk-title { flex: 1; letter-spacing: 0.02em; }
        .cmdk-chip {
          font-family: var(--display); font-size: 9.5px; font-weight: 700;
          letter-spacing: 0.25em; padding: 3px 8px;
          border: 1px solid var(--line-soft); color: var(--cyan);
          background: rgba(57, 229, 255, 0.05);
        }
        .cmdk-item.active .cmdk-chip {
          border-color: var(--cyan);
          background: rgba(57, 229, 255, 0.22);
          color: #fff;
        }
        .chip-nav    { color: var(--cyan-2); }
        .chip-ai     { color: var(--cyan-3); }
        .chip-system { color: var(--ink-2); }
        .chip-power  { color: #ffb36b; border-color: rgba(255, 179, 107, 0.35); }
        .cmdk-empty {
          padding: 18px 16px;
          font-family: var(--mono); font-size: 12px; color: var(--ink-dim);
        }
        .cmdk-foot {
          display: flex; gap: 18px; justify-content: flex-end;
          padding: 8px 16px; border-top: 1px solid var(--line-soft);
          font-family: var(--mono); font-size: 10.5px; color: var(--ink-dim);
          letter-spacing: 0.08em;
        }
        .cmdk-ask { padding: 6px 0 0; }
        .cmdk-ask-hint {
          padding: 8px 16px;
          font-family: var(--mono); font-size: 11px; color: var(--ink-dim);
          letter-spacing: 0.04em;
          border-top: 1px solid var(--line-soft);
        }
        .cmdk-ask-result {
          padding: 12px 16px; max-height: 40vh; overflow-y: auto;
          font-family: var(--mono); font-size: 12px; color: var(--ink);
          white-space: pre-wrap; line-height: 1.55;
          border-top: 1px solid var(--line-soft);
          background: rgba(4, 10, 16, 0.5);
        }

        /* -------- Agent mode -------- */
        .cmdk-agent { padding: 0; }
        .cmdk-agent-row {
          display: flex; align-items: stretch; gap: 0;
          border-bottom: 1px solid var(--line-soft);
        }
        .cmdk-input-agent {
          border-bottom: 0;
          flex: 1;
        }
        .cmdk-agent-meta {
          display: flex; align-items: center; gap: 8px;
          padding: 0 12px;
          border-left: 1px solid var(--line-soft);
          background: rgba(4, 10, 16, 0.5);
        }
        .cmdk-agent-timer {
          font-family: var(--mono); font-size: 11.5px;
          letter-spacing: 0.12em; color: var(--cyan);
          font-variant-numeric: tabular-nums;
        }
        .cmdk-agent-stop {
          all: unset; cursor: pointer;
          font-family: var(--display); font-size: 10px; font-weight: 800;
          letter-spacing: 0.28em; color: #ff8b8b;
          padding: 4px 10px;
          border: 1px solid rgba(255, 139, 139, 0.55);
          background: rgba(255, 139, 139, 0.08);
        }
        .cmdk-agent-stop:hover {
          background: rgba(255, 139, 139, 0.22);
          color: #fff;
        }
        .cmdk-agent-hint {
          padding: 8px 16px;
          font-family: var(--mono); font-size: 11px; color: var(--ink-dim);
          letter-spacing: 0.12em;
          border-bottom: 1px solid var(--line-soft);
        }
        .cmdk-agent-steps {
          max-height: 32vh; overflow-y: auto;
          padding: 4px 0;
          border-bottom: 1px solid var(--line-soft);
          background: rgba(4, 10, 16, 0.5);
        }
        .cmdk-agent-step {
          display: flex; gap: 10px; align-items: flex-start;
          padding: 6px 16px;
          font-family: var(--mono); font-size: 11.5px;
          color: var(--ink); letter-spacing: 0.04em;
          border-left: 2px solid transparent;
        }
        .cmdk-agent-step-kind {
          flex-shrink: 0;
          font-family: var(--display); font-size: 9px; font-weight: 800;
          letter-spacing: 0.22em; color: var(--cyan);
          min-width: 82px; padding-top: 2px;
        }
        .cmdk-agent-step-text {
          flex: 1; white-space: pre-wrap; word-break: break-word;
          color: var(--ink);
        }
        .step-plan        { border-left-color: rgba(57, 229, 255, 0.4); }
        .step-tool_call   { border-left-color: var(--cyan); }
        .step-tool_result { border-left-color: rgba(57, 229, 255, 0.25); color: var(--ink-dim); }
        .step-tool_result .cmdk-agent-step-text { color: var(--ink-dim); }
        .step-message     { border-left-color: #b8f2b5; }
        .step-error       { border-left-color: #ff8b8b; }
        .step-error .cmdk-agent-step-kind { color: #ff8b8b; }

        .cmdk-agent-final {
          padding: 12px 16px;
          display: flex; flex-direction: column; gap: 10px;
          border-top: 1px solid var(--line-soft);
          background: linear-gradient(180deg, rgba(57, 229, 255, 0.06), transparent);
        }
        .cmdk-agent-final-body {
          font-family: var(--mono); font-size: 12.5px;
          letter-spacing: 0.04em;
          color: var(--cyan);
          white-space: pre-wrap; line-height: 1.55;
          padding: 10px 12px;
          background: rgba(4, 10, 16, 0.75);
          border: 1px solid rgba(57, 229, 255, 0.35);
          max-height: 28vh; overflow-y: auto;
        }
        .cmdk-agent-clear {
          all: unset; cursor: pointer; align-self: flex-end;
          font-family: var(--display); font-size: 10px; font-weight: 800;
          letter-spacing: 0.28em; color: var(--ink-dim);
          padding: 4px 10px;
          border: 1px solid var(--line-soft);
        }
        .cmdk-agent-clear:hover {
          color: var(--cyan);
          border-color: var(--cyan);
        }
      `;
