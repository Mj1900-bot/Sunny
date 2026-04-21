//! Idle sensor — polls `CGEventSourceSecondsSinceLastEventType` every 15 s
//! and publishes `SunnyEvent::AutopilotSignal { source: "idle", ... }` when the
//! idle state changes meaningfully (crossed/uncrossed the 60-second threshold).
//!
//! No panics: every fallible operation is wrapped and logged; the loop
//! continues regardless of individual sample failures.

use chrono::Utc;

use crate::event_bus::{self, SunnyEvent};
use crate::supervise;

const POLL_INTERVAL_SECS: u64 = 15;
/// Seconds of inactivity before we consider the user "idle".
const IDLE_THRESHOLD_SECS: f64 = 60.0;

/// CGEventSource constant for "any" event type (combined hardware events).
/// Value 4 = kCGAnyInputEventType on macOS.
#[cfg(target_os = "macos")]
const CG_ANY_INPUT_EVENT_TYPE: u32 = 4;

/// Read idle seconds via CoreGraphics FFI on macOS.
#[cfg(target_os = "macos")]
fn idle_secs() -> Result<f64, String> {
    // SAFETY: CGEventSourceSecondsSinceLastEventType is a pure read-only
    // CoreGraphics function with no side effects. The return value is a
    // CFTimeInterval (f64 seconds). We link against CoreGraphics via
    // the system framework path; the symbol is always present on macOS 10.4+.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(
            state_id: i32,
            event_type: u32,
        ) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState = 1
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(1, CG_ANY_INPUT_EVENT_TYPE) };
    if secs < 0.0 || secs > 86_400.0 {
        return Err(format!("implausible idle_secs value: {secs}"));
    }
    Ok(secs)
}

/// Fallback for non-macOS targets (Linux CI, tests).
#[cfg(not(target_os = "macos"))]
fn idle_secs() -> Result<f64, String> {
    Ok(0.0)
}

/// Supervised sensor task. Call this from the wiring pass (not from lib.rs).
pub fn spawn() {
    supervise::spawn_supervised("autopilot_sensor_idle", || async {
        run_idle_loop().await;
    });
}

async fn run_idle_loop() {
    let mut last_was_idle = false;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;

        let secs = match idle_secs() {
            Ok(s) => s,
            Err(e) => {
                log::debug!("[autopilot/idle] idle_secs error: {e}");
                continue;
            }
        };

        let now_idle = secs >= IDLE_THRESHOLD_SECS;

        // Only publish on state transitions to avoid flooding the bus.
        if now_idle == last_was_idle {
            continue;
        }
        last_was_idle = now_idle;

        let payload = serde_json::json!({
            "idle_secs": secs,
            "is_idle": now_idle,
        })
        .to_string();

        event_bus::publish(SunnyEvent::AutopilotSignal {
            seq: 0,
            boot_epoch: 0,
            source: "idle".to_string(),
            payload,
            at: Utc::now().timestamp_millis(),
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_threshold_constant_is_positive() {
        assert!(IDLE_THRESHOLD_SECS > 0.0);
    }

    #[test]
    fn idle_secs_returns_non_negative() {
        // On any platform the stub must return a non-negative value.
        let result = idle_secs();
        if let Ok(v) = result {
            assert!(v >= 0.0, "idle_secs must be >= 0, got {v}");
        }
        // An Err is also acceptable (e.g. permission denied on sandboxed CI).
    }

    #[test]
    fn payload_is_valid_json() {
        let secs = 90.0_f64;
        let payload = serde_json::json!({
            "idle_secs": secs,
            "is_idle": secs >= IDLE_THRESHOLD_SECS,
        })
        .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["idle_secs"], 90.0);
        assert_eq!(parsed["is_idle"], true);
    }
}
