//! Pure / deterministic compute tools. Trust-class Pure (no wrapping)
//! with no capability requirements — the evaluator never reaches
//! outside the process.
pub mod calc;
pub mod py_run;
pub mod stock_quote;
pub mod timezone_now;
pub mod unit_convert;
pub mod uuid_new;
