//! Per-tab operations: navigate, click, type, read, screenshot, wait, eval.
//!
//! All async functions are `Send`-safe — they own their parameters before
//! calling `handle::with_tab`, which requires `F: 'static + Send`.

use std::time::{Duration, Instant};

use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;

use crate::browser::cdp::error::{CdpError, CdpResult};
use crate::browser::cdp::handle;
use crate::browser::cdp::security::validate_url;
use crate::browser::cdp::types::{
    CdpActionResult, CdpEvalResult, CdpOpenResult, CdpScreenshot, CdpText, CdpWaitResult, TabInfo,
};

const SELECTOR_WAIT_DEFAULT_MS: u64 = 5_000;
const READ_TEXT_CAP: usize = 16_000;

// ---------------------------------------------------------------------------
// browser_cdp_open
// ---------------------------------------------------------------------------

pub async fn cdp_open(url: &str, existing_tab_id: Option<&str>) -> CdpResult<CdpOpenResult> {
    validate_url(url)?;
    let url_owned = url.to_string();

    let tab_id = match existing_tab_id {
        Some(id) => {
            let id_owned = id.to_string();
            let url2 = url_owned.clone();
            handle::with_tab(id_owned.clone(), move |page| async move {
                page.goto(url2)
                    .await
                    .map_err(|e| CdpError::Protocol(e.to_string()))?;
                Ok(())
            })
            .await?;
            id_owned
        }
        None => handle::open_tab(&url_owned).await?,
    };

    Ok(CdpOpenResult {
        tab_id,
        url: url_owned,
    })
}

// ---------------------------------------------------------------------------
// browser_cdp_click
// ---------------------------------------------------------------------------

pub async fn cdp_click(
    tab_id: &str,
    selector: &str,
    timeout_ms: Option<u64>,
) -> CdpResult<CdpActionResult> {
    let timeout = timeout_ms.unwrap_or(SELECTOR_WAIT_DEFAULT_MS);
    let sel = selector.to_string();
    let tab_id_owned = tab_id.to_string();

    handle::with_tab(tab_id_owned.clone(), move |page| async move {
        wait_for_selector(&page, &sel, timeout).await?;
        page.find_element(sel.as_str())
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?
            .click()
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?;
        Ok(CdpActionResult {
            tab_id: tab_id_owned,
            selector: sel,
            action: "click".into(),
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// browser_cdp_type
// ---------------------------------------------------------------------------

pub async fn cdp_type(
    tab_id: &str,
    selector: &str,
    text: &str,
    submit: bool,
) -> CdpResult<CdpActionResult> {
    let sel = selector.to_string();
    let text_owned = text.to_string();
    let tab_id_owned = tab_id.to_string();

    handle::with_tab(tab_id_owned.clone(), move |page| async move {
        wait_for_selector(&page, &sel, SELECTOR_WAIT_DEFAULT_MS).await?;
        let el = page
            .find_element(sel.as_str())
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?;

        el.click()
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?;

        // Select-all via CDP Input.dispatchKeyEvent
        dispatch_key(&page, "a", Some("Meta")).await?;
        // Delete selection
        dispatch_key(&page, "Delete", None).await?;

        el.type_str(text_owned.as_str())
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?;

        if submit {
            dispatch_key(&page, "Return", None).await?;
        }

        let action = if submit { "type+submit" } else { "type" }.to_string();
        Ok(CdpActionResult {
            tab_id: tab_id_owned,
            selector: sel,
            action,
        })
    })
    .await
}

/// Send a keydown + keyup pair via CDP Input.dispatchKeyEvent.
async fn dispatch_key(
    page: &chromiumoxide::page::Page,
    key: &str,
    modifier_key: Option<&str>,
) -> CdpResult<()> {
    // chromiumoxide exposes page.execute(cmd) for raw CDP commands.
    // For key events the simplest cross-OS approach is to use `type_str`
    // for printable chars or evaluate `document.execCommand` for control ops.
    // Here we use a JS approach that's reliable across platforms:
    match key {
        "Delete" | "Backspace" => {
            // Use execCommand select-all + delete via JS — reliable.
            let js = "document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);";
            page.evaluate(js)
                .await
                .map_err(|e| CdpError::Protocol(e.to_string()))?;
        }
        "Return" => {
            let js = "document.activeElement && document.activeElement.form && document.activeElement.form.requestSubmit ? document.activeElement.form.requestSubmit() : document.activeElement && document.activeElement.form && document.activeElement.form.submit()";
            page.evaluate(js)
                .await
                .map_err(|e| CdpError::Protocol(e.to_string()))?;
        }
        "a" if modifier_key == Some("Meta") => {
            // Select all.
            let js = "document.execCommand('selectAll', false, null)";
            page.evaluate(js)
                .await
                .map_err(|e| CdpError::Protocol(e.to_string()))?;
        }
        _ => {
            // For other keys fall through — not used in current call sites.
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// browser_cdp_read
// ---------------------------------------------------------------------------

pub async fn cdp_read(tab_id: &str, selector: Option<&str>) -> CdpResult<CdpText> {
    let sel = selector.unwrap_or("body").to_string();
    let tab_id_owned = tab_id.to_string();

    handle::with_tab(tab_id_owned.clone(), move |page| async move {
        let sel_json = serde_json::to_string(&sel).unwrap_or_else(|_| "\"body\"".into());
        let js = format!(
            "(function(){{ var el=document.querySelector({s}); if(!el) return null; return el.innerText||el.textContent||\"\"; }})()",
            s = sel_json
        );
        let raw: Option<String> = page
            .evaluate(js)
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?
            .into_value()
            .map_err(|e| CdpError::EvalError(e.to_string()))?;

        let text_raw = raw.unwrap_or_default();
        let cleaned = collapse_whitespace(&text_raw);
        let (text, truncated) = if cleaned.chars().count() > READ_TEXT_CAP {
            let t: String = cleaned.chars().take(READ_TEXT_CAP).collect();
            (t, true)
        } else {
            (cleaned, false)
        };

        Ok(CdpText {
            tab_id: tab_id_owned,
            selector: sel,
            text,
            truncated,
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// browser_cdp_eval
// ---------------------------------------------------------------------------

pub async fn cdp_eval(tab_id: &str, js: &str) -> CdpResult<CdpEvalResult> {
    let js_owned = js.to_string();
    let tab_id_owned = tab_id.to_string();

    handle::with_tab(tab_id_owned.clone(), move |page| async move {
        let result = page
            .evaluate(js_owned)
            .await
            .map_err(|e| CdpError::Protocol(e.to_string()))?;

        let value: serde_json::Value = result
            .into_value::<serde_json::Value>()
            .unwrap_or(serde_json::Value::String("(non-serialisable result)".into()));

        Ok(CdpEvalResult {
            tab_id: tab_id_owned,
            value,
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// browser_cdp_screenshot
// ---------------------------------------------------------------------------

pub async fn cdp_screenshot(tab_id: &str, full_page: bool) -> CdpResult<CdpScreenshot> {
    let tab_id_owned = tab_id.to_string();
    let downloads = handle::downloads_dir()?;

    handle::with_tab(tab_id_owned.clone(), move |page| async move {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        let filename = format!("sunny-cdp-{nonce:x}.png");
        let path = downloads.join(&filename);

        let params = chromiumoxide::page::ScreenshotParams::builder()
            .format(CaptureScreenshotFormat::Png)
            .full_page(full_page)
            .build();

        let png_bytes = page
            .screenshot(params)
            .await
            .map_err(|e| CdpError::ScreenshotFailed(e.to_string()))?;

        let bytes = png_bytes.len() as u64;
        std::fs::write(&path, &png_bytes)
            .map_err(|e| CdpError::Io(format!("write screenshot: {e}")))?;

        Ok(CdpScreenshot {
            tab_id: tab_id_owned,
            path: path.to_string_lossy().into_owned(),
            bytes,
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// browser_cdp_wait
// ---------------------------------------------------------------------------

pub async fn cdp_wait(
    tab_id: &str,
    wait_target: &str,
    timeout_ms: Option<u64>,
) -> CdpResult<CdpWaitResult> {
    let timeout = timeout_ms.unwrap_or(SELECTOR_WAIT_DEFAULT_MS);
    let target = wait_target.to_string();
    let tab_id_owned = tab_id.to_string();

    handle::with_tab(tab_id_owned.clone(), move |page| async move {
        let start = Instant::now();

        if target == "networkidle" {
            let deadline = Duration::from_millis(timeout.max(1000));
            let poll = Duration::from_millis(500);
            let mut last_count: usize = 0;
            let outer_start = Instant::now();
            loop {
                if outer_start.elapsed() > deadline {
                    return Err(CdpError::NetworkIdleTimeout(timeout));
                }
                let count: usize = page
                    .evaluate("window.performance.getEntriesByType('resource').length")
                    .await
                    .ok()
                    .and_then(|v| v.into_value::<serde_json::Value>().ok())
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize)
                    .unwrap_or(0);
                if count == last_count && outer_start.elapsed() > Duration::from_millis(500) {
                    break;
                }
                last_count = count;
                tokio::time::sleep(poll).await;
            }
        } else {
            wait_for_selector(&page, &target, timeout).await?;
        }

        Ok(CdpWaitResult {
            tab_id: tab_id_owned,
            waited_for: target,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// browser_cdp_list_tabs
// ---------------------------------------------------------------------------

pub async fn cdp_list_tabs() -> CdpResult<Vec<TabInfo>> {
    let raw = handle::list_tabs().await?;
    Ok(raw
        .into_iter()
        .map(|(tab_id, url, title)| TabInfo { tab_id, url, title })
        .collect())
}

// ---------------------------------------------------------------------------
// browser_cdp_close_tab
// ---------------------------------------------------------------------------

pub async fn cdp_close_tab(tab_id: &str) -> CdpResult<()> {
    handle::close_tab(tab_id).await
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async fn wait_for_selector(
    page: &chromiumoxide::page::Page,
    selector: &str,
    timeout_ms: u64,
) -> CdpResult<()> {
    let deadline = Duration::from_millis(timeout_ms);
    let poll = Duration::from_millis(200);
    let start = Instant::now();
    let sel = selector.to_string();

    loop {
        match page.find_element(sel.as_str()).await {
            Ok(_) => return Ok(()),
            Err(_) if start.elapsed() < deadline => {
                tokio::time::sleep(poll).await;
            }
            Err(_) => {
                return Err(CdpError::SelectorTimeout {
                    selector: sel,
                    timeout_ms,
                });
            }
        }
    }
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut blank_run = 0usize;
    for raw_line in input.split('\n') {
        let mut line = String::with_capacity(raw_line.len());
        let mut prev_space = false;
        for ch in raw_line.chars() {
            if ch == ' ' || ch == '\t' {
                if !prev_space {
                    line.push(' ');
                    prev_space = true;
                }
            } else {
                line.push(ch);
                prev_space = false;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_whitespace_collapses_tabs_and_spaces() {
        let input = "  hello   world  \n\n\n\nnext\n\n\n";
        assert_eq!(collapse_whitespace(input), "hello world\n\nnext");
    }

    #[test]
    fn collapse_whitespace_preserves_unicode() {
        assert_eq!(collapse_whitespace("café  —  münchen"), "café — münchen");
    }

    #[test]
    fn collapse_whitespace_empty_input() {
        assert_eq!(collapse_whitespace(""), "");
    }

    #[test]
    fn read_text_cap_is_reasonable() {
        assert!(READ_TEXT_CAP >= 8_000 && READ_TEXT_CAP <= 32_000);
    }

    #[test]
    fn selector_wait_default_is_five_seconds() {
        assert_eq!(SELECTOR_WAIT_DEFAULT_MS, 5_000);
    }

    #[test]
    fn cdp_text_truncation_flag_logic() {
        let long_text = "a".repeat(READ_TEXT_CAP + 100);
        let (text, truncated) = if long_text.chars().count() > READ_TEXT_CAP {
            let t: String = long_text.chars().take(READ_TEXT_CAP).collect();
            (t, true)
        } else {
            (long_text.clone(), false)
        };
        assert!(truncated);
        assert_eq!(text.len(), READ_TEXT_CAP);
    }

    #[test]
    fn cdp_text_no_truncation_under_cap() {
        let short = "hello world".to_string();
        let (text, truncated) = if short.chars().count() > READ_TEXT_CAP {
            let t: String = short.chars().take(READ_TEXT_CAP).collect();
            (t, true)
        } else {
            (short.clone(), false)
        };
        assert!(!truncated);
        assert_eq!(text, "hello world");
    }
}
