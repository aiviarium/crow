//! The router of the `ai` plugin: an app service that provides the plugin's `ai` service.
//!
//! It maps a task (text, fast, transcription) to a connection and a model for the caller, enforces the
//! caller's budget, calls the provider (the built-in OpenAI-compatible one, or a plugin that contributed to
//! `ai.providers`) and records usage. It uses Rookery's public protocol (`rookery-proto`) and service SDK
//! surface.

pub mod budget;
pub mod conn;
pub mod dictation;
pub mod methods;
pub mod models;
pub mod provider;
pub mod router;
pub mod rules;
pub mod sdk;
pub mod transport;
pub mod types;

pub use methods::register;
pub use router::Router;
