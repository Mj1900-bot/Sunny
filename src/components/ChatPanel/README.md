# ChatPanel

The ChatPanel component was split into four focused files during Phase 2.
Each file has a single responsibility; the top-level `index.tsx` composes them.

## File layout

| File | Responsibility |
|---|---|
| `session.ts` | Pure TypeScript — session types (`ChatSession`, `Message`, `Role`) and stateless utilities (e.g. `makeSessionId`, `formatTimestamp`). No React, no side effects. |
| `styles.ts` | Static `CSSProperties` objects used by the panel and its sub-components. Keeping styles out of JSX eliminates inline-object churn on every render and makes visual diffs easy to read. |
| `useChatMessages.ts` | React hook — owns the streaming receive path and the `send` action. Subscribes to `sunny://chat.chunk` and `sunny://chat.done` events, appends delta tokens to the live message, and exposes `{ messages, send, isStreaming }`. |
| `useSessionManager.ts` | React hook — owns session lifecycle: create, switch, and restore across app restarts (reads/writes `conversation.*` Tauri commands). Exposes `{ session, sessions, createSession, switchSession }`. |

## Conventions

- `session.ts` and `styles.ts` are plain TypeScript modules — import them
  anywhere without pulling in React.
- The two hooks are the only files that call `invokeSafe` or `listen`; keep
  Tauri IPC calls out of `session.ts` and `styles.ts`.
- Types exported from `session.ts` are the single source of truth; do not
  redeclare `Message` or `ChatSession` in other files.
