//! Messaging channels — outside-world reach for Sunny beyond the local HUD.
//!
//! Each submodule is a single-channel adapter: bot-token / webhook /
//! API plumbing on one side, a uniform `ChannelMessage` → agent loop
//! bridge on the other. v0.1 lands one adapter (Telegram) as a proof
//! of the pattern; Discord / Slack / iMessage / Signal follow the
//! same shape.
//!
//! ## Non-goals for v0.1
//!
//! * No unified dispatcher — each channel's poll/webhook loop lives
//!   in its own module. Consolidation can come later once ≥3 channels
//!   ship and a stable interface emerges.
//! * No outbound scheduling (i.e. "send at 3pm") — that's the
//!   cron/delivery-queue layer, not the channel adapter.

pub mod telegram;
