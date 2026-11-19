//! Providers: the built-in OpenAI-compatible one, and the contributions to `ai.providers`, which name a service
//! of their plugin. The router calls that service's `generate` (a stream of `delta` chunks and one `result`),
//! `transcribe` and `models` as the caller and hands it the connection's id: the provider reads the connection
//! itself, which reveals its secrets to the plugin that owns the connection type.

use std::time::Duration;

use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::conn::Conn;
use crate::models::{
    self, BUILTIN, CANCEL_GRACE, CancellationToken, Endpoint, GenerateIn, GenerateOut, MODELS_TIMEOUT,
    ModelError, OpenAi, TranscribeIn, TranscribeOut,
};
use crate::sdk::{Contribution, Ctx, Error, Result};
use crate::transport::SharedTransport;
use crate::types::{ModelInfo, ProviderInfo, Task};

/// The connection type of the built-in provider.
pub const BUILTIN_TYPE: &str = "ai.openai-compatible";

/// The point other plugins contribute to.
pub const POINT: &str = "ai.providers";

/// A contribution to `ai.providers`, as the point's schema has it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Def {
    pub id: String,
    pub title: String,
    pub connection_type: String,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
    #[serde(default)]
    pub detects_language: bool,
    pub service: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Provider {
    Builtin,
    Contributed {
        plugin: String,
        def: Def,
        /// The contributor's service, when it provides the one the contribution names.
        service: Option<String>,
    },
}

pub type Builtin = OpenAi<SharedTransport>;

impl Provider {
    pub fn id(&self) -> String {
        match self {
            Provider::Builtin => BUILTIN.into(),
            Provider::Contributed { def, .. } => def.id.clone(),
        }
    }

    pub fn tasks(&self) -> Vec<Task> {
        match self {
            Provider::Builtin => vec![Task::Text, Task::Fast, Task::Transcription],
            Provider::Contributed { def, .. } => def.tasks.clone(),
        }
    }

    pub fn detects_language(&self) -> bool {
        match self {
            Provider::Builtin => true,
            Provider::Contributed { def, .. } => def.detects_language,
        }
    }

    pub fn connection_type(&self) -> &str {
        match self {
            Provider::Builtin => BUILTIN_TYPE,
            Provider::Contributed { def, .. } => &def.connection_type,
        }
    }

    pub fn info(&self) -> ProviderInfo {
        match self {
            Provider::Builtin => ProviderInfo {
                id: self.id(),
                title: "OpenAI-compatible API".into(),
                plugin: None,
                connection_type: BUILTIN_TYPE.into(),
                tasks: self.tasks(),
                detects_language: true,
            },
            Provider::Contributed { plugin, def, .. } => ProviderInfo {
                id: def.id.clone(),
                title: def.title.clone(),
                plugin: Some(plugin.clone()),
                connection_type: def.connection_type.clone(),
                tasks: def.tasks.clone(),
                detects_language: def.detects_language,
            },
        }
    }

    /// Where requests for a connection go, and whether that is this machine or a private network.
    pub fn destination(&self, conn: &Conn) -> (String, bool) {
        let fallback = match self {
            Provider::Builtin => None,
            Provider::Contributed { def, .. } => Some(def.title.as_str()),
        };
        models::destination_for_config(&conn.config(), fallback)
    }
}

/// The provider that serves connections of a type.
pub fn for_type<'a>(providers: &'a [Provider], kind: &str) -> Option<&'a Provider> {
    providers.iter().find(|p| p.connection_type() == kind)
}

/// Every provider: the built-in one, then each contribution (in plugin id order).
pub fn from_contributions(list: Vec<Contribution<Def>>) -> Vec<Provider> {
    let mut out = vec![Provider::Builtin];
    for c in list {
        out.push(Provider::Contributed {
            plugin: c.plugin,
            def: c.value,
            service: c.service,
        });
    }
    out
}

pub fn model_error(e: ModelError) -> Error {
    use models::ErrorCode;
    let mut err = match e.code {
        ErrorCode::Invalid => Error::invalid(e.message),
        ErrorCode::NotFound => Error::not_found(e.message),
        ErrorCode::Timeout => Error::timeout(e.message),
        ErrorCode::Unavailable => Error::unavailable(e.message),
        ErrorCode::Internal => Error::internal(e.message),
    };
    if let Some(d) = e.details {
        err = err.with_details(d);
    }
    err
}

/// The error a cancelled request ends with.
pub fn cancelled() -> Error {
    model_error(ModelError::cancelled())
}

pub fn to_model_task(t: Task) -> models::Task {
    match t {
        Task::Text => models::Task::Text,
        Task::Fast => models::Task::Fast,
        Task::Transcription => models::Task::Transcription,
    }
}

pub fn from_model_task(t: models::Task) -> Task {
    match t {
        models::Task::Text => Task::Text,
        models::Task::Fast => Task::Fast,
        models::Task::Transcription => Task::Transcription,
    }
}

fn endpoint(conn: &Conn) -> Result<Endpoint> {
    Endpoint::from_values(&conn.values).map_err(model_error)
}

// ── what a contributed provider's service is called with and answers ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCall<'a> {
    request: &'a str,
    provider: &'a str,
    task: Task,
    connection: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Chunk {
    Delta {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Result {
        text: String,
        #[serde(default)]
        object: Option<Value>,
        #[serde(default)]
        usage: Option<models::Usage>,
        #[serde(default)]
        model: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Heard {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    seconds: Option<f64>,
    #[serde(default)]
    model: Option<String>,
}

fn messages_value(messages: &[models::Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            json!({
                "role": match m.role { models::Role::User => "user", models::Role::Assistant => "assistant" },
                "content": m.content,
            })
        })
        .collect()
}

fn service_of(p: &Provider) -> Result<(&str, &Def)> {
    match p {
        Provider::Contributed {
            def,
            service: Some(service),
            ..
        } => Ok((service, def)),
        Provider::Contributed { def, plugin, .. } => Err(Error::unavailable(format!(
            "provider {} is not available: {plugin} does not provide the service {}",
            def.id, def.service
        ))),
        Provider::Builtin => Err(Error::internal("the built-in provider has no service")),
    }
}

/// Runs a generation. `delta` gets each piece of text as it arrives; the request stops when `cancel` fires or
/// `timeout` passes.
#[allow(clippy::too_many_arguments)]
pub async fn generate(
    ctx: &Ctx,
    builtin: &Builtin,
    provider: &Provider,
    conn: &Conn,
    input: GenerateIn,
    timeout: Duration,
    cancel: &CancellationToken,
    mut delta: impl FnMut(&str) + Send,
) -> Result<GenerateOut> {
    match provider {
        Provider::Builtin => {
            let ep = endpoint(conn)?;
            models::generate_openai(builtin, &ep, &input, timeout, cancel, delta)
                .await
                .map_err(model_error)
        }
        Provider::Contributed { .. } => {
            let (service, def) = service_of(provider)?;
            let params = ProviderCall {
                request: &input.request,
                provider: &def.id,
                task: from_model_task(input.task),
                connection: &conn.id,
                model: Some(&input.model),
                system: input.system.as_deref(),
                messages: messages_value(&input.messages),
                schema: input.schema.as_ref(),
                schema_name: input.schema_name.as_deref(),
                max_tokens: input.max_tokens,
                temperature: input.temperature,
                audio: None,
                mime: None,
                language: None,
            };
            let work = async {
                let mut stream = Box::pin(
                    ctx.stream::<_, Chunk>(service, "generate", &params)
                        .await
                        .map_err(|e| ModelError::unavailable(e.message().to_string()))?,
                );
                let mut answer = None;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(Chunk::Delta { text }) => delta(&text),
                        Ok(Chunk::Result {
                            text,
                            object,
                            usage,
                            model,
                        }) => answer = Some((text, object, usage, model)),
                        Err(e) => return Err(from_sdk_error(e)),
                    }
                }
                answer.ok_or_else(|| {
                    ModelError::internal(format!("provider {} ended its answer without a result", def.id))
                })
            };
            let (text, object, usage, model) = until_grace(work, timeout, cancel).await?;
            let object = models::validate_provider_object(input.schema.as_ref(), object, &text)
                .map_err(model_error)?;
            Ok(GenerateOut {
                text,
                object,
                usage: usage.unwrap_or_default(),
                model: model.unwrap_or(input.model),
            })
        }
    }
}

/// An error of the contributor's service, with its code kept.
fn from_sdk_error(e: Error) -> ModelError {
    use models::ErrorCode;
    let code = match e.code() {
        "INVALID" => ErrorCode::Invalid,
        "NOT_FOUND" => ErrorCode::NotFound,
        "TIMEOUT" => ErrorCode::Timeout,
        "INTERNAL" => ErrorCode::Internal,
        _ => ErrorCode::Unavailable,
    };
    let mut m = ModelError::new(code, e.message().to_string());
    if let Some(d) = e.details() {
        m = m.with_details(d.clone());
    }
    m
}

async fn until_grace<T>(
    work: impl std::future::Future<Output = std::result::Result<T, ModelError>>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<T> {
    let _ = CANCEL_GRACE;
    models::until(work, timeout, cancel)
        .await
        .map_err(model_error)
}

#[allow(clippy::too_many_arguments)]
pub async fn transcribe(
    ctx: &Ctx,
    builtin: &Builtin,
    provider: &Provider,
    conn: &Conn,
    input: &TranscribeIn,
    audio: &[u8],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<TranscribeOut> {
    match provider {
        Provider::Builtin => {
            let ep = endpoint(conn)?;
            models::transcribe_openai(builtin, &ep, input, audio, timeout, cancel)
                .await
                .map_err(model_error)
        }
        Provider::Contributed { .. } => {
            let (service, def) = service_of(provider)?;
            let params = ProviderCall {
                request: &input.request,
                provider: &def.id,
                task: Task::Transcription,
                connection: &conn.id,
                model: Some(&input.model),
                system: None,
                messages: Vec::new(),
                schema: None,
                schema_name: None,
                max_tokens: None,
                temperature: None,
                audio: Some(base64::engine::general_purpose::STANDARD.encode(audio)),
                mime: Some(&input.mime),
                language: input.language.as_deref(),
            };
            let work = async {
                ctx.call::<_, Heard>(service, "transcribe", &params)
                    .await
                    .map_err(from_sdk_error)
            };
            let heard = until_grace(work, timeout, cancel).await?;
            Ok(TranscribeOut {
                text: heard.text.trim().to_string(),
                language: heard.language,
                seconds: heard.seconds,
                model: heard.model.unwrap_or_else(|| input.model.clone()),
            })
        }
    }
}

/// The models a connection's provider offers.
pub async fn models_for(
    ctx: &Ctx,
    builtin: &Builtin,
    provider: &Provider,
    conn: &Conn,
) -> Result<Vec<ModelInfo>> {
    match provider {
        Provider::Builtin => {
            let ep = endpoint(conn)?;
            let list = builtin.models(&ep).await.map_err(model_error)?;
            Ok(list.into_iter().map(from_model_info).collect())
        }
        Provider::Contributed { def, .. } => {
            let Ok((service, _)) = service_of(provider) else {
                return Ok(def.models.clone());
            };
            let params = ProviderCall {
                request: &uuid::Uuid::now_v7().to_string(),
                provider: &def.id,
                task: def.tasks.first().copied().unwrap_or(Task::Text),
                connection: &conn.id,
                model: None,
                system: None,
                messages: Vec::new(),
                schema: None,
                schema_name: None,
                max_tokens: None,
                temperature: None,
                audio: None,
                mime: None,
                language: None,
            };
            let ctx = ctx.clone();
            let asked = tokio::time::timeout(
                MODELS_TIMEOUT,
                ctx.call::<_, Value>(service, "models", &params),
            )
            .await;
            match asked {
                Ok(Ok(v)) => {
                    let list = v.get("models").cloned().unwrap_or(v);
                    let mut models: Vec<ModelInfo> =
                        serde_json::from_value(list).unwrap_or_default();
                    if models.is_empty() {
                        models = def.models.clone();
                    }
                    Ok(models)
                }
                Ok(Err(_)) | Err(_) if !def.models.is_empty() => Ok(def.models.clone()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err(Error::timeout("the provider did not list its models in time")),
            }
        }
    }
}

fn from_model_info(m: models::ModelInfo) -> ModelInfo {
    ModelInfo {
        id: m.id,
        title: m.title,
        tasks: m.tasks.map(|ts| ts.into_iter().map(from_model_task).collect()),
    }
}

/// The test of a built-in connection: ask the server for its models.
pub async fn test_builtin(builtin: &Builtin, values: &Map<String, Value>) -> (bool, String, Value) {
    let ep = match Endpoint::from_values(values) {
        Ok(ep) => ep,
        Err(_) => return (false, "The connection has no base URL.".into(), Value::Null),
    };
    match builtin.models(&ep).await {
        Err(e) => (false, e.message, Value::Null),
        Ok(list) if list.is_empty() => (
            true,
            "The server answered, but lists no models.".into(),
            json!({ "models": [] }),
        ),
        Ok(list) => {
            let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
            let shown = ids.iter().take(5).copied().collect::<Vec<_>>().join(", ");
            let more = if ids.len() > 5 {
                format!(" and {} more", ids.len() - 5)
            } else {
                String::new()
            };
            (
                true,
                format!(
                    "{} {}: {shown}{more}",
                    ids.len(),
                    if ids.len() == 1 { "model" } else { "models" }
                ),
                json!({ "models": ids }),
            )
        }
    }
}
