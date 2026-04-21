// useMicPrime — request microphone permission at app boot, not mid-turn.
//
// macOS WKWebView shows the TCC mic prompt the FIRST time `getUserMedia`
// is called. If we wait until the user has already pressed space and
// spoken, that first turn silently fails because `getUserMedia` is
// pending on the prompt — `useVoiceActivity` silently no-ops and the
// 25 s recording backstop fires every time.
//
// Fix: request a throwaway mic stream once at mount, immediately stop
// all tracks. This surfaces the TCC prompt at app launch, so by the
// time the user speaks for real the permission has either been granted
// (VAD works) or denied (we fall back to manual-stop with the short
// backstop). Either way, no mid-turn surprise.
import { useEffect } from 'react';

export function useMicPrime(): void {
  useEffect(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await md.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        // Immediately release — we only wanted the permission prompt to
        // fire. useVoiceActivity re-acquires its own stream per turn.
        stream.getTracks().forEach(t => t.stop());
      } catch {
        // Permission denied or not available. Silent — useVoiceActivity
        // will report the same condition when voice actually starts.
      }
    })();
    return () => { cancelled = true; };
  }, []);
}
