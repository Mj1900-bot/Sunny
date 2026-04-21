import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Vitest's default discovery (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) would
    // pick up the Playwright specs in `e2e/`, which import `@playwright/test`
    // — a separate runner that isn't a dev-dep until the user explicitly
    // activates the E2E harness. Excluding `e2e/` keeps the unit-test
    // suite (vitest) and the integration suite (playwright) cleanly
    // separated; both runners ignore each other's files by default once
    // this exclude is in place.
    exclude: ['node_modules', 'dist', 'e2e/**'],
  },
  build: {
    // Ship sourcemaps next to the bundle so stack traces inside the Tauri
    // webview point at real file/line numbers instead of minified globs.
    // Trivial bundle-size cost; indispensable when a production-only crash
    // (e.g. React error #185) surfaces.
    sourcemap: true,
    rollupOptions: {
      output: {
        // Fix 6: manual chunk splitting keeps the vendor graph predictable and
        // lets the Tauri webview cache framework code independently of app code.
        // Vite 8 uses rolldown whose manualChunks only accepts the function form.
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@tauri-apps/')) {
            return 'vendor-tauri';
          }
          // @noble/* — ed25519 + hashes are cryptography primitives that are
          // both large (~23 KB minified for ed25519 alone) and version-stable.
          // Isolating them into a single chunk lets the Tauri webview cache them
          // independently of SkillsPage logic, which changes far more often.
          if (id.includes('node_modules/@noble/')) {
            return 'vendor-noble';
          }
          // @xterm/xterm core — 294 KB minified, changes only on xterm releases.
          // Splitting it away from PtyTerminal.tsx means component logic changes
          // don't bust the xterm cache entry (and vice-versa).
          if (id.includes('node_modules/@xterm/xterm/')) {
            return 'vendor-xterm';
          }
          return undefined;
        },
      },
    },
  },
})
