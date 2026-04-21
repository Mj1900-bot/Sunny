//! Sensor modules — each publishes `SunnyEvent::AutopilotSignal` onto the bus.

pub mod idle;
pub mod fs_burst;
pub mod build;
pub mod clipboard_change;
