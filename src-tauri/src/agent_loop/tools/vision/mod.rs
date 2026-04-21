//! Local vision tools. `image_describe` calls a local Ollama
//! multimodal model (minicpm-v / llava), so no network egress beyond
//! 127.0.0.1:11434; capability `vision.describe`.
pub mod image_describe;
