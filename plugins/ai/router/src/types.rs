//! Wire and collection types for the `ai` router service (matching `../methods.json` & `../plugin.json`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sdk::Collection;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Task {
    #[default]
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "fast")]
    Fast,
    #[serde(rename = "transcription")]
    Transcription,
}

impl Task {
    pub fn as_str(&self) -> &'static str {
        match self {
            Task::Text => "text",
            Task::Fast => "fast",
            Task::Transcription => "transcription",
        }
    }
}

impl std::fmt::Display for Task {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Scope {
    #[serde(rename = "global")]
    Global,
    #[serde(rename = "space")]
    Space,
    #[serde(rename = "user")]
    User,
}

impl Scope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Scope::Global => "global",
            Scope::Space => "space",
            Scope::User => "user",
        }
    }
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub type MappingTask = Task;
pub type MappingScope = Scope;

/// A row of the `mappings` collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mapping {
    pub id: String,
    #[serde(rename = "updatedAt", with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
    pub key: String,
    pub task: MappingTask,
    pub scope: MappingScope,
    #[serde(default)]
    pub space: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    pub connection: String,
    pub model: String,
    #[serde(default)]
    pub live: Option<bool>,
}

impl Collection for Mapping {
    const NAME: &'static str = "mappings";
}

/// A row of the `limits` collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limit {
    pub id: String,
    pub user: String,
    #[serde(default)]
    pub requests: Option<i64>,
    #[serde(default)]
    pub tokens: Option<i64>,
    #[serde(rename = "audioSeconds", default)]
    pub audio_seconds: Option<i64>,
}

impl Collection for Limit {
    const NAME: &'static str = "limits";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MessageRole {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "assistant")]
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GenerateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(default = "default_text_task")]
    pub task: Task,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<Message>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<BTreeMap<String, Value>>,
    #[serde(rename = "schemaName", default, skip_serializing_if = "Option::is_none")]
    pub schema_name: Option<String>,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
}

fn default_text_task() -> Task {
    Task::Text
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(rename = "inputTokens", default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(rename = "outputTokens", default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(rename = "audioSeconds", default, skip_serializing_if = "Option::is_none")]
    pub audio_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Generated {
    pub request: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub object: Value,
    pub model: String,
    pub provider: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DictateParams {
    pub request: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DictateAudioParams {
    pub request: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<bool>,
}

pub type DictateAudioResult = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(rename = "audioSeconds", default, skip_serializing_if = "Option::is_none")]
    pub audio_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitsInfoUsersItem {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitsInfo {
    pub default: Limits,
    pub users: Vec<LimitsInfoUsersItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MappingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MappingInfo {
    pub task: Task,
    pub scope: Scope,
    #[serde(rename = "spaceId", default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(rename = "userId", default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub connection: String,
    #[serde(rename = "connectionName")]
    pub connection_name: String,
    #[serde(rename = "connectionType")]
    pub connection_type: String,
    pub provider: String,
    pub model: String,
    pub live: bool,
    pub destination: String,
    pub local: bool,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MappingsResult {
    pub mappings: Vec<MappingInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelsParams {
    pub connection: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<Task>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelsResult {
    pub models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(rename = "connectionType")]
    pub connection_type: String,
    pub tasks: Vec<Task>,
    #[serde(rename = "detectsLanguage")]
    pub detects_language: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProvidersResult {
    pub providers: Vec<ProviderInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoveMappingParams {
    pub task: Task,
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
}

pub type RemoveMappingResult = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetLimitsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetMappingParams {
    pub task: Task,
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    pub connection: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TasksParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskInfo {
    pub task: Task,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub live: bool,
    #[serde(rename = "detectsLanguage")]
    pub detects_language: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TasksResult {
    pub tasks: Vec<TaskInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestParams {
    pub connection: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscribeParams {
    pub audio: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcribed {
    pub request: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    pub model: String,
    pub provider: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UsageParamsBy {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "plugin")]
    Plugin,
    #[serde(rename = "task")]
    Task,
    #[serde(rename = "model")]
    Model,
    #[serde(rename = "day")]
    Day,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageParams {
    pub by: UsageParamsBy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageRow {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub requests: i64,
    pub errors: i64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "audioSeconds")]
    pub audio_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageResult {
    pub rows: Vec<UsageRow>,
    pub since: String,
}
