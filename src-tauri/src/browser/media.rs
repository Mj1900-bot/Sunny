//! Media analysis primitives. Given a local media file (from Downloads),
//! extract what the AI tools need: metadata, an audio track suitable for
//! transcription, and a timeline of keyframes suitable for vision analysis.
//!
//! We intentionally keep the pipeline deterministic — same input always
//! produces the same outputs, stashed under
//! `~/.sunny/browser/media/<job_id>/`. The vision + transcription steps
//! themselves run inside the existing AI plumbing and are not implemented
//! here; this module gives them clean inputs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browser::audit::audit_dir;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MediaMeta {
    pub duration_sec: f64,
    #[ts(type = "number")]
    pub width: u32,
    #[ts(type = "number")]
    pub height: u32,
    #[ts(type = "number")]
    pub bitrate: u64,
    pub codec_video: String,
    pub codec_audio: String,
    pub container: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExtractResult {
    pub job_id: String,
    pub audio_path: String,
    pub frames_dir: String,
    #[ts(type = "number")]
    pub frame_count: usize,
    pub meta: MediaMeta,
}

pub fn workbench_dir(job_id: &str) -> Result<PathBuf, String> {
    let base = audit_dir()?;
    let target = base.join("media").join(job_id);
    std::fs::create_dir_all(&target).map_err(|e| format!("mkdir media: {e}"))?;
    Ok(target)
}

/// Run ffprobe for metadata, ffmpeg for mp3 audio, ffmpeg for keyframes.
pub async fn extract(job_id: &str, media_path: &Path) -> Result<ExtractResult, String> {
    let (ffmpeg, ffprobe) = find_ffmpeg().await?;
    let dir = workbench_dir(job_id)?;
    let audio = dir.join("audio.mp3");
    let frames = dir.join("frames");
    std::fs::create_dir_all(&frames).map_err(|e| format!("mkdir frames: {e}"))?;

    let meta = ffprobe_meta(&ffprobe, media_path).await?;

    // Audio: 16k mono mp3 — fine for whisper without wasting bytes.
    let status = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(media_path)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-b:a")
        .arg("64k")
        .arg(&audio)
        .status()
        .await
        .map_err(|e| format!("spawn ffmpeg audio: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg audio exit {status}"));
    }

    // Frames: target about 120 frames across the video, capped to 1 every
    // 2 seconds (we never want faster than that — it's bytes, not insight).
    let rate = frame_rate_for(meta.duration_sec);
    let pattern = frames.join("frame-%04d.jpg");
    let status = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(media_path)
        .arg("-vf")
        .arg(format!("fps={rate}"))
        .arg("-q:v")
        .arg("5")
        .arg(&pattern)
        .status()
        .await
        .map_err(|e| format!("spawn ffmpeg frames: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg frames exit {status}"));
    }
    let frame_count = std::fs::read_dir(&frames)
        .map_err(|e| format!("read frames: {e}"))?
        .filter_map(|r| r.ok())
        .filter(|d| {
            d.file_name()
                .to_string_lossy()
                .starts_with("frame-")
        })
        .count();

    Ok(ExtractResult {
        job_id: job_id.to_string(),
        audio_path: audio.to_string_lossy().to_string(),
        frames_dir: frames.to_string_lossy().to_string(),
        frame_count,
        meta,
    })
}

fn frame_rate_for(duration_sec: f64) -> String {
    // Target ~120 frames total, capped min 1/60s, max 1/2s.
    if duration_sec < 1.0 {
        return "1".into();
    }
    let target = (120.0 / duration_sec).clamp(1.0 / 60.0, 0.5);
    // ffmpeg prefers fps=1/N or a decimal. Express as 1/N when N>=2.
    if target <= 0.5 {
        let n = (1.0 / target).round() as u32;
        format!("1/{n}")
    } else {
        format!("{target:.4}")
    }
}

async fn find_ffmpeg() -> Result<(PathBuf, PathBuf), String> {
    let probe = super::downloads::probe_tools().await;
    let ffmpeg = probe
        .ffmpeg_path
        .ok_or_else(|| "ffmpeg not found on PATH".to_string())?;
    let ffmpeg_pb = PathBuf::from(&ffmpeg);
    let ffprobe_pb = ffmpeg_pb
        .parent()
        .map(|p| p.join("ffprobe"))
        .unwrap_or_else(|| PathBuf::from("ffprobe"));
    Ok((ffmpeg_pb, ffprobe_pb))
}

async fn ffprobe_meta(ffprobe: &Path, media: &Path) -> Result<MediaMeta, String> {
    let out = tokio::process::Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(media)
        .output()
        .await
        .map_err(|e| format!("spawn ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe exit {}", out.status));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("parse ffprobe json: {e}"))?;

    let duration = v["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let bitrate = v["format"]["bit_rate"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let container = v["format"]["format_name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let mut width = 0u32;
    let mut height = 0u32;
    let mut codec_video = String::new();
    let mut codec_audio = String::new();

    if let Some(streams) = v["streams"].as_array() {
        for s in streams {
            let kind = s["codec_type"].as_str().unwrap_or("");
            let name = s["codec_name"].as_str().unwrap_or("");
            match kind {
                "video" => {
                    if codec_video.is_empty() {
                        codec_video = name.to_string();
                        width = s["width"].as_u64().unwrap_or(0) as u32;
                        height = s["height"].as_u64().unwrap_or(0) as u32;
                    }
                }
                "audio" => {
                    if codec_audio.is_empty() {
                        codec_audio = name.to_string();
                    }
                }
                _ => {}
            }
        }
    }

    Ok(MediaMeta {
        duration_sec: duration,
        width,
        height,
        bitrate,
        codec_video,
        codec_audio,
        container,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_for_short_clip_is_every_frame() {
        let r = frame_rate_for(0.5);
        assert_eq!(r, "1");
    }

    #[test]
    fn rate_for_ten_minute_clip_is_once_every_five_seconds() {
        let r = frame_rate_for(600.0);
        assert_eq!(r, "1/5");
    }
}
