//! Rookery app-service SDK for the `ai` router: inbound JSON-RPC / NDJSON server (`POST /rpc`)
//! and authenticated callbacks to Rookery (`POST /services/rpc`).
//!
//! Supports both a live HTTP connection via [`Rookery::connect`] / [`Rookery::new`] and an
//! in-memory [`RookeryBackend`] fake via [`Rookery::from_backend`] for unit tests.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures::{Stream, StreamExt};
pub use rookery_proto::facilities::{ConnectionInfo, ConnectionResolved, Scope as FacilityScope};
pub use rookery_proto::methods::Grant as Level;
pub use rookery_proto::{ErrorCode, Principal, PrincipalKind, RpcError, User};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
pub use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STREAM_LINE: usize = 8 * 1024 * 1024;

/// Service SDK error backed by `rookery_proto::RpcError`.
#[derive(Debug, Clone, PartialEq)]
pub struct Error(pub RpcError);

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for Error {}

impl From<RpcError> for Error {
    fn from(err: RpcError) -> Self {
        Self(err)
    }
}

impl From<Error> for RpcError {
    fn from(err: Error) -> Self {
        err.0
    }
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self(RpcError::new(code, message))
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self(RpcError::invalid(message))
    }

    pub fn unauthenticated(message: impl Into<String>) -> Self {
        Self(RpcError::unauthenticated(message))
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self(RpcError::forbidden(message))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self(RpcError::not_found(message))
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self(RpcError::conflict(message))
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self(RpcError::unavailable(message))
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self(RpcError::timeout(message))
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self(RpcError::internal(message))
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.0 = self.0.with_details(details);
        self
    }

    pub fn error_code(&self) -> ErrorCode {
        self.0.error_code()
    }

    pub fn code(&self) -> &'static str {
        self.0.error_code().as_str()
    }

    pub fn message(&self) -> &str {
        &self.0.message
    }

    pub fn details(&self) -> Option<&Value> {
        self.0.details()
    }

    pub fn is_not_found(&self) -> bool {
        self.error_code() == ErrorCode::NotFound
    }

    pub fn is_forbidden(&self) -> bool {
        self.error_code() == ErrorCode::Forbidden
    }
}

/// Configuration for a Rookery app-service process.
#[derive(Clone)]
pub struct Config {
    /// Base HTTP URL of the Rookery server (e.g. `http://127.0.0.1:7777`).
    pub rookery_url: String,
    /// Listen address for this app service's HTTP server (`POST /rpc`, `GET /healthz`).
    pub listen: String,
    /// Owning plugin id (`ai`).
    pub plugin_id: String,
    /// Service id (`ai/router` or `router`).
    pub service_id: String,
    /// Inbound bearer secret Rookery presents when calling `POST /rpc` on this service.
    pub inbound_secret: String,
    /// Distinct callback bearer secret this service presents on `POST /services/rpc`.
    pub callback_secret: String,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("rookery_url", &self.rookery_url)
            .field("listen", &self.listen)
            .field("plugin_id", &self.plugin_id)
            .field("service_id", &self.service_id)
            .field("inbound_secret", &"[redacted]")
            .field("callback_secret", &"[redacted]")
            .finish()
    }
}

impl Config {
    /// Reads configuration from standard Rookery app-service environment variables:
    /// - `ROOKERY_URL`
    /// - `ROOKERY_SERVICE_ID` (e.g. `ai/router` or `router`)
    /// - `ROOKERY_PLUGIN_ID` (optional; defaults to the prefix of `ROOKERY_SERVICE_ID` or `"ai"`)
    /// - `ROOKERY_SERVICE_SECRET` (inbound bearer token)
    /// - `ROOKERY_CALLBACK_SECRET` (distinct callback bearer token for `/services/rpc`)
    /// - `ROOKERY_SERVICE_LISTEN` / `ROOKERY_LISTEN` (defaults to `127.0.0.1:8080`)
    pub fn from_env() -> Result<Self> {
        let rookery_url = std::env::var("ROOKERY_URL").unwrap_or_default();
        let service_id = std::env::var("ROOKERY_SERVICE_ID").unwrap_or_default();
        let plugin_id = std::env::var("ROOKERY_PLUGIN_ID")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| service_id.split_once('/').map(|(p, _)| p.to_owned()))
            .unwrap_or_else(|| "ai".into());
        let inbound_secret = std::env::var("ROOKERY_SERVICE_SECRET").unwrap_or_default();
        let callback_secret = std::env::var("ROOKERY_CALLBACK_SECRET").unwrap_or_default();
        let listen = std::env::var("ROOKERY_SERVICE_LISTEN")
            .or_else(|_| std::env::var("ROOKERY_LISTEN"))
            .unwrap_or_else(|_| "127.0.0.1:8080".into());
        let cfg = Self {
            rookery_url,
            listen,
            plugin_id,
            service_id,
            inbound_secret,
            callback_secret,
        };
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<()> {
        if self.rookery_url.trim().is_empty() {
            return Err(Error::invalid("ROOKERY_URL is required"));
        }
        if self.service_id.trim().is_empty() {
            return Err(Error::invalid("ROOKERY_SERVICE_ID is required"));
        }
        if self.inbound_secret.trim().is_empty() {
            return Err(Error::invalid("ROOKERY_SERVICE_SECRET is required"));
        }
        if self.callback_secret.trim().is_empty() {
            return Err(Error::invalid("ROOKERY_CALLBACK_SECRET is required"));
        }
        if self.inbound_secret == self.callback_secret {
            return Err(Error::invalid(
                "ROOKERY_CALLBACK_SECRET must differ from ROOKERY_SERVICE_SECRET",
            ));
        }
        Ok(())
    }
}

fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub trait Collection {
    const NAME: &'static str;
}

#[derive(Debug, Clone, Serialize)]
pub struct Filter(pub Value);

impl Filter {
    pub fn all_of(filters: impl IntoIterator<Item = Filter>) -> Self {
        let items: Vec<Value> = filters.into_iter().map(|f| f.0).collect();
        Self(json!({ "and": items }))
    }

    pub fn any_of(filters: impl IntoIterator<Item = Filter>) -> Self {
        let items: Vec<Value> = filters.into_iter().map(|f| f.0).collect();
        Self(json!({ "or": items }))
    }
}

pub struct FieldRef {
    name: &'static str,
}

pub fn field(name: &'static str) -> FieldRef {
    FieldRef { name }
}

impl FieldRef {
    pub fn eq(self, value: impl Serialize) -> Filter {
        Filter(json!({ self.name: { "eq": value } }))
    }

    pub fn is_in<S: Serialize>(self, values: impl IntoIterator<Item = S>) -> Filter {
        let vals: Vec<Value> = values
            .into_iter()
            .filter_map(|v| serde_json::to_value(v).ok())
            .collect();
        Filter(json!({ self.name: { "in": vals } }))
    }
}

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub filter: Option<Filter>,
    pub limit: Option<usize>,
}

impl Query {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn filter(mut self, filter: Filter) -> Self {
        self.filter = Some(filter);
        self
    }

    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = Some(limit);
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FindResult<T> {
    pub rows: Vec<T>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Contribution<T> {
    pub plugin: String,
    pub value: T,
    #[serde(default)]
    pub service: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct EntityTextItem {
    pub uri: String,
    #[serde(default)]
    pub title: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct EntityTexts {
    pub texts: Vec<EntityTextItem>,
}

/// Backend operations provided by the Rookery service SDK runtime (or an in-memory fake in tests).
pub trait RookeryBackend: Send + Sync + 'static {
    fn find<'a>(&'a self, collection: &'a str, query: Query) -> BoxFuture<'a, Result<Vec<Value>>>;
    fn insert<'a>(&'a self, collection: &'a str, row: Value) -> BoxFuture<'a, Result<Value>>;
    fn upsert<'a>(
        &'a self,
        collection: &'a str,
        row: Value,
        conflict_keys: &'a [&'a str],
    ) -> BoxFuture<'a, Result<Value>>;
    fn delete<'a>(&'a self, collection: &'a str, id: &'a str) -> BoxFuture<'a, Result<()>>;
    fn aggregate<'a>(
        &'a self,
        collection: &'a str,
        spec: Value,
    ) -> BoxFuture<'a, Result<Vec<Value>>>;

    fn connection_resolve<'a>(
        &'a self,
        principal: &'a Principal,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<ConnectionResolved>>> {
        let _ = (principal, id);
        Box::pin(async move { Ok(None) })
    }

    fn connection_resolve_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<ConnectionResolved>>> {
        let _ = call_id;
        self.connection_resolve(principal, id)
    }

    fn access_filter<'a>(
        &'a self,
        principal: &'a Principal,
        resources: &'a [&'a str],
        level: Level,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        let _ = (principal, resources, level);
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn access_filter_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        resources: &'a [&'a str],
        level: Level,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        let _ = call_id;
        self.access_filter(principal, resources, level)
    }

    fn access_require_space<'a>(
        &'a self,
        principal: &'a Principal,
        space: &'a str,
        level: Level,
    ) -> BoxFuture<'a, Result<()>> {
        let _ = (principal, space, level);
        Box::pin(async move { Ok(()) })
    }

    fn access_require_space_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        space: &'a str,
        level: Level,
    ) -> BoxFuture<'a, Result<()>> {
        let _ = call_id;
        self.access_require_space(principal, space, level)
    }

    fn extensions_list<'a>(
        &'a self,
        point: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Contribution<Value>>>>;
    fn extensions_changed<'a>(
        &'a self,
        point: &'a str,
    ) -> BoxFuture<'a, Result<BoxStream<Result<()>>>>;

    fn call_service<'a>(
        &'a self,
        principal: &'a Principal,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value>> {
        let _ = (principal, service, method, params);
        Box::pin(async move { Err(Error::not_found("service not found")) })
    }

    fn call_service_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value>> {
        let _ = call_id;
        self.call_service(principal, service, method, params)
    }

    fn stream_service<'a>(
        &'a self,
        principal: &'a Principal,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<BoxStream<Result<Value>>>> {
        let _ = (principal, service, method, params);
        Box::pin(async move { Err(Error::not_found("stream not found")) })
    }

    fn stream_service_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<BoxStream<Result<Value>>>> {
        let _ = call_id;
        self.stream_service(principal, service, method, params)
    }

    fn entities_text<'a>(
        &'a self,
        principal: &'a Principal,
        uris: &'a [&'a str],
    ) -> BoxFuture<'a, Result<EntityTexts>> {
        let _ = (principal, uris);
        Box::pin(async move { Ok(EntityTexts { texts: Vec::new() }) })
    }

    fn entities_text_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        uris: &'a [&'a str],
        max_chars: Option<usize>,
    ) -> BoxFuture<'a, Result<EntityTexts>> {
        let _ = (call_id, max_chars);
        self.entities_text(principal, uris)
    }

    fn audit_record<'a>(
        &'a self,
        principal: &'a Principal,
        action: &'a str,
        resource: Option<&'a str>,
        details: Option<Value>,
    ) -> BoxFuture<'a, Result<()>> {
        let _ = (principal, action, resource, details);
        Box::pin(async move { Ok(()) })
    }

    fn audit_record_for<'a>(
        &'a self,
        principal: &'a Principal,
        call_id: Option<&'a str>,
        action: &'a str,
        resource: Option<&'a str>,
        details: Option<Value>,
    ) -> BoxFuture<'a, Result<()>> {
        let _ = call_id;
        self.audit_record(principal, action, resource, details)
    }

    fn serve(&self) -> BoxFuture<'_, Result<()>>;
}

/// Real HTTP callback backend talking to `POST <rookery_url>/services/rpc`.
pub struct HttpBackend {
    http: reqwest::Client,
    endpoint: String,
    callback_secret: String,
    plugin_id: String,
}

impl HttpBackend {
    pub fn new(config: &Config) -> Self {
        let base = config.rookery_url.trim_end_matches('/');
        Self {
            http: reqwest::Client::new(),
            endpoint: format!("{base}/services/rpc"),
            callback_secret: config.callback_secret.clone(),
            plugin_id: config.plugin_id.clone(),
        }
    }

    fn with_plugin(&self, collection: &str, mut params: Value) -> Value {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("collection".into(), Value::String(collection.to_owned()));
            if !self.plugin_id.is_empty() {
                obj.entry("plugin")
                    .or_insert_with(|| Value::String(self.plugin_id.clone()));
            }
        }
        params
    }

    async fn call_raw(
        &self,
        method: &str,
        params: Value,
        call_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value> {
        let mut body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        if let Some(cid) = call_id.filter(|s| !s.is_empty()) {
            body["callId"] = Value::String(cid.to_owned());
        }
        let resp = self
            .http
            .post(&self.endpoint)
            .timeout(timeout)
            .header(header::CONTENT_TYPE, "application/json")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", self.callback_secret),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::unavailable(format!("{}: {e}", self.endpoint)))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| Error::unavailable(format!("{}: {e}", self.endpoint)))?;
        let parsed: Value = serde_json::from_str(&text).map_err(|e| {
            Error::unavailable(format!(
                "{} answered HTTP {status} with non-JSON: {e}",
                self.endpoint
            ))
        })?;
        if let Some(error) = parsed.get("error") {
            let err = serde_json::from_value::<RpcError>(error.clone())
                .unwrap_or_else(|_| RpcError::internal(error.to_string()));
            return Err(Error(err));
        }
        if !(200..300).contains(&status) {
            return Err(Error::unavailable(format!(
                "Rookery callback returned HTTP {status}"
            )));
        }
        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn stream_raw(
        &self,
        method: &str,
        params: Value,
        call_id: Option<&str>,
        timeout: Duration,
    ) -> Result<BoxStream<Result<Value>>> {
        let mut body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
            "stream": true,
        });
        if let Some(cid) = call_id.filter(|s| !s.is_empty()) {
            body["callId"] = Value::String(cid.to_owned());
        }
        let resp = self
            .http
            .post(&self.endpoint)
            .timeout(timeout)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/x-ndjson, application/json")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", self.callback_secret),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::unavailable(format!("{}: {e}", self.endpoint)))?;
        let status = resp.status().as_u16();
        let is_ndjson = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.contains("ndjson"));
        if !is_ndjson {
            let text = resp.text().await.unwrap_or_default();
            let err = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("error").cloned())
                .and_then(|e| serde_json::from_value::<RpcError>(e).ok())
                .unwrap_or_else(|| {
                    RpcError::unavailable(format!("Rookery callback stream returned HTTP {status}"))
                });
            return Err(Error(err));
        }
        let endpoint = self.endpoint.clone();
        let mut byte_stream = resp.bytes_stream();
        let (tx, rx) = mpsc::channel::<Result<Value>>(16);
        tokio::spawn(async move {
            let mut pending = Vec::<u8>::new();
            while let Some(chunk) = byte_stream.next().await {
                let bytes = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = tx
                            .send(Err(Error::unavailable(format!("{endpoint}: {e}"))))
                            .await;
                        return;
                    }
                };
                pending.extend_from_slice(&bytes);
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = pending.drain(..=end).collect();
                    let Ok(msg) = serde_json::from_slice::<Value>(&line[..end]) else {
                        continue;
                    };
                    if let Some(error) = msg.get("error") {
                        let err = serde_json::from_value::<RpcError>(error.clone())
                            .unwrap_or_else(|_| RpcError::internal(error.to_string()));
                        let _ = tx.send(Err(Error(err))).await;
                        return;
                    }
                    let Some(item) = msg.get("result").cloned() else {
                        return;
                    };
                    if tx.send(Ok(item)).await.is_err() {
                        return;
                    }
                }
                if pending.len() > MAX_STREAM_LINE {
                    let _ = tx
                        .send(Err(Error::unavailable(
                            "callback stream line exceeded limit",
                        )))
                        .await;
                    return;
                }
            }
        });
        let stream = futures::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        });
        Ok(Box::pin(stream))
    }
}

fn split_service<'a>(default_plugin: &'a str, service: &'a str) -> (&'a str, &'a str) {
    match service.split_once('/') {
        Some((plugin, svc)) if !plugin.is_empty() && !svc.is_empty() => (plugin, svc),
        _ => (default_plugin, service),
    }
}

impl RookeryBackend for HttpBackend {
    fn find<'a>(&'a self, collection: &'a str, query: Query) -> BoxFuture<'a, Result<Vec<Value>>> {
        Box::pin(async move {
            let mut params = json!({});
            if let Some(f) = query.filter {
                params["where"] = f.0;
            }
            if let Some(l) = query.limit {
                params["limit"] = json!(l);
            }
            let v = self
                .call_raw(
                    "data.find",
                    self.with_plugin(collection, params),
                    None,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await?;
            Ok(v.get("rows")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default())
        })
    }

    fn insert<'a>(&'a self, collection: &'a str, row: Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let v = self
                .call_raw(
                    "data.insert",
                    self.with_plugin(collection, json!({ "values": row })),
                    None,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await?;
            Ok(v.get("row").cloned().unwrap_or(v))
        })
    }

    fn upsert<'a>(
        &'a self,
        collection: &'a str,
        row: Value,
        conflict_keys: &'a [&'a str],
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let v = self
                .call_raw(
                    "data.upsert",
                    self.with_plugin(collection, json!({ "values": row, "on": conflict_keys })),
                    None,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await?;
            Ok(v.get("row").cloned().unwrap_or(v))
        })
    }

    fn delete<'a>(&'a self, collection: &'a str, id: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.call_raw(
                "data.delete",
                self.with_plugin(collection, json!({ "id": id })),
                None,
                DEFAULT_CALL_TIMEOUT,
            )
            .await?;
            Ok(())
        })
    }

    fn aggregate<'a>(
        &'a self,
        collection: &'a str,
        spec: Value,
    ) -> BoxFuture<'a, Result<Vec<Value>>> {
        Box::pin(async move {
            let v = self
                .call_raw(
                    "data.aggregate",
                    self.with_plugin(collection, spec),
                    None,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await?;
            Ok(v.get("rows")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default())
        })
    }

    fn connection_resolve_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<ConnectionResolved>>> {
        Box::pin(async move {
            match self
                .call_raw(
                    "connections.resolve",
                    json!({ "id": id }),
                    call_id,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await
            {
                Ok(v) => serde_json::from_value::<ConnectionResolved>(v)
                    .map(Some)
                    .map_err(|e| Error::internal(format!("bad connections.resolve: {e}"))),
                Err(e) if e.is_not_found() => Ok(None),
                Err(e) if e.is_forbidden() => {
                    // Connections of another plugin's type (such as `model-anthropic.api`) cannot
                    // have their secret resolved by `ai`, so read their public metadata via
                    // `connections.get` and let the owning provider service resolve the secret.
                    match self
                        .call_raw(
                            "connections.get",
                            json!({ "id": id }),
                            call_id,
                            DEFAULT_CALL_TIMEOUT,
                        )
                        .await
                    {
                        Ok(v) => {
                            let connection =
                                serde_json::from_value::<ConnectionInfo>(v).map_err(|e| {
                                    Error::internal(format!("bad connections.get: {e}"))
                                })?;
                            Ok(Some(ConnectionResolved {
                                connection,
                                credential: None,
                            }))
                        }
                        Err(e2) if e2.is_not_found() || e2.is_forbidden() => Ok(None),
                        Err(e2) => Err(e2),
                    }
                }
                Err(e) => Err(e),
            }
        })
    }

    fn access_filter_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        resources: &'a [&'a str],
        level: Level,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let v = self
                .call_raw(
                    "access.filter",
                    json!({ "resources": resources, "level": level }),
                    call_id,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await?;
            let list = v
                .get("resources")
                .cloned()
                .unwrap_or_else(|| Value::Array(vec![]));
            serde_json::from_value(list)
                .map_err(|e| Error::internal(format!("bad access.filter: {e}")))
        })
    }

    fn access_require_space_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        space: &'a str,
        level: Level,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let resource = if space.starts_with("space://") {
                space.to_owned()
            } else {
                format!("space://{space}")
            };
            self.call_raw(
                "access.require",
                json!({ "resource": resource, "level": level }),
                call_id,
                DEFAULT_CALL_TIMEOUT,
            )
            .await?;
            Ok(())
        })
    }

    fn extensions_list<'a>(
        &'a self,
        point: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Contribution<Value>>>> {
        Box::pin(async move {
            let v = self
                .call_raw(
                    "extensions.list",
                    json!({ "point": point }),
                    None,
                    DEFAULT_CALL_TIMEOUT,
                )
                .await?;
            let list = v
                .get("contributions")
                .cloned()
                .unwrap_or_else(|| Value::Array(vec![]));
            serde_json::from_value(list)
                .map_err(|e| Error::internal(format!("bad extensions.list: {e}")))
        })
    }

    fn extensions_changed<'a>(
        &'a self,
        point: &'a str,
    ) -> BoxFuture<'a, Result<BoxStream<Result<()>>>> {
        let point = point.to_owned();
        Box::pin(async move {
            let _ = point;
            // Poll-invalidation stream: yields an event every 10s so the router refreshes its
            // provider cache over HTTP without holding a persistent WebSocket.
            let stream = futures::stream::unfold((), |()| async move {
                tokio::time::sleep(Duration::from_secs(10)).await;
                Some((Ok(()), ()))
            });
            Ok(Box::pin(stream) as BoxStream<Result<()>>)
        })
    }

    fn call_service_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let (plugin, svc) = split_service(&self.plugin_id, service);
            self.call_raw(
                "services.call",
                json!({
                    "plugin": plugin,
                    "service": svc,
                    "method": method,
                    "params": params,
                }),
                call_id,
                Duration::from_secs(300),
            )
            .await
        })
    }

    fn stream_service_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<BoxStream<Result<Value>>>> {
        Box::pin(async move {
            let (plugin, svc) = split_service(&self.plugin_id, service);
            self.stream_raw(
                "services.stream",
                json!({
                    "plugin": plugin,
                    "service": svc,
                    "method": method,
                    "params": params,
                }),
                call_id,
                Duration::from_secs(300),
            )
            .await
        })
    }

    fn entities_text_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        uris: &'a [&'a str],
        max_chars: Option<usize>,
    ) -> BoxFuture<'a, Result<EntityTexts>> {
        Box::pin(async move {
            let mut params = json!({ "uris": uris });
            if let Some(max) = max_chars {
                params["maxChars"] = json!(max);
            }
            let v = self
                .call_raw("entities.text", params, call_id, DEFAULT_CALL_TIMEOUT)
                .await?;
            serde_json::from_value(v)
                .map_err(|e| Error::internal(format!("bad entities.text: {e}")))
        })
    }

    fn audit_record_for<'a>(
        &'a self,
        _principal: &'a Principal,
        call_id: Option<&'a str>,
        action: &'a str,
        resource: Option<&'a str>,
        details: Option<Value>,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut params = json!({ "action": action });
            if let Some(r) = resource {
                params["resource"] = Value::String(r.to_owned());
            }
            if let Some(d) = details {
                params["details"] = d;
            }
            self.call_raw("audit.record", params, call_id, DEFAULT_CALL_TIMEOUT)
                .await?;
            Ok(())
        })
    }

    fn serve(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { Ok(()) })
    }
}

/// Service-level client acting as the plugin's service principal.
#[derive(Clone)]
pub struct Client {
    backend: Arc<dyn RookeryBackend>,
    principal: Principal,
}

impl Client {
    pub fn from_backend(backend: Arc<dyn RookeryBackend>, service_id: impl Into<String>) -> Self {
        Self {
            backend,
            principal: Principal {
                kind: PrincipalKind::Plugin,
                id: service_id.into(),
            },
        }
    }

    pub fn data<T: Collection>(&self) -> TypedCollection<'_, T> {
        TypedCollection {
            backend: &*self.backend,
            name: T::NAME,
            _marker: PhantomData,
        }
    }

    pub fn collection(&self, name: &'static str) -> RawCollection<'_> {
        RawCollection {
            backend: &*self.backend,
            name,
        }
    }

    pub fn extensions(&self) -> ExtensionsClient<'_> {
        ExtensionsClient {
            backend: &*self.backend,
        }
    }

    pub fn backend(&self) -> &Arc<dyn RookeryBackend> {
        &self.backend
    }

    pub fn principal(&self) -> &Principal {
        &self.principal
    }
}

pub struct TypedCollection<'a, T> {
    backend: &'a dyn RookeryBackend,
    name: &'static str,
    _marker: PhantomData<T>,
}

impl<'a, T: DeserializeOwned> TypedCollection<'a, T> {
    pub async fn find(&self, query: Query) -> Result<FindResult<T>> {
        let values = self.backend.find(self.name, query).await?;
        let mut rows = Vec::with_capacity(values.len());
        for v in values {
            let row = serde_json::from_value(v)
                .map_err(|e| Error::internal(format!("invalid row in {}: {e}", self.name)))?;
            rows.push(row);
        }
        Ok(FindResult { rows })
    }

    pub async fn upsert(&self, row: &Value, conflict_keys: &[&str]) -> Result<T> {
        let v = self
            .backend
            .upsert(self.name, row.clone(), conflict_keys)
            .await?;
        serde_json::from_value(v)
            .map_err(|e| Error::internal(format!("invalid upserted row in {}: {e}", self.name)))
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.backend.delete(self.name, id).await
    }
}

pub struct RawCollection<'a> {
    backend: &'a dyn RookeryBackend,
    name: &'static str,
}

impl<'a> RawCollection<'a> {
    pub async fn insert(&self, row: &Value) -> Result<Value> {
        self.backend.insert(self.name, row.clone()).await
    }

    pub async fn aggregate(&self, spec: &Value) -> Result<Vec<Value>> {
        self.backend.aggregate(self.name, spec.clone()).await
    }
}

pub struct ExtensionsClient<'a> {
    backend: &'a dyn RookeryBackend,
}

impl<'a> ExtensionsClient<'a> {
    pub async fn list<T: DeserializeOwned>(&self, point: &str) -> Result<Vec<Contribution<T>>> {
        let list = self.backend.extensions_list(point).await?;
        let mut out = Vec::with_capacity(list.len());
        for item in list {
            let service = item.service.or_else(|| {
                item.value
                    .get("service")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| {
                        if s.contains('/') {
                            s.to_owned()
                        } else {
                            format!("{}/{s}", item.plugin)
                        }
                    })
            });
            let value = serde_json::from_value::<T>(item.value)
                .map_err(|e| Error::internal(format!("invalid contribution on {point}: {e}")))?;
            out.push(Contribution {
                plugin: item.plugin,
                value,
                service,
            });
        }
        Ok(out)
    }

    pub async fn changed(&self, point: &str) -> Result<BoxStream<Result<()>>> {
        self.backend.extensions_changed(point).await
    }
}

/// Per-request call context, carrying caller identity, `callId`, cancellation, deadline, and facility clients.
#[derive(Clone)]
pub struct Ctx {
    backend: Arc<dyn RookeryBackend>,
    call_id: Option<String>,
    principal: Principal,
    user: Option<User>,
    space: Option<String>,
    deadline: Option<Duration>,
    cancel: CancellationToken,
}

impl Ctx {
    pub fn new(
        backend: Arc<dyn RookeryBackend>,
        principal: Principal,
        user: Option<User>,
        space: Option<String>,
    ) -> Self {
        Self {
            backend,
            call_id: None,
            principal,
            user,
            space,
            deadline: None,
            cancel: CancellationToken::new(),
        }
    }

    pub fn with_call_id(mut self, call_id: impl Into<String>) -> Self {
        let cid = call_id.into();
        if !cid.is_empty() {
            self.call_id = Some(cid);
        }
        self
    }

    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = Some(deadline);
        self
    }

    pub fn with_cancel(mut self, cancel: CancellationToken) -> Self {
        self.cancel = cancel;
        self
    }

    pub fn call_id(&self) -> Option<&str> {
        self.call_id.as_deref()
    }

    pub fn principal(&self) -> &Principal {
        &self.principal
    }

    pub fn user(&self) -> Option<&User> {
        self.user.as_ref()
    }

    pub fn space(&self) -> Option<&str> {
        self.space.as_deref()
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn time_left(&self) -> Duration {
        self.deadline.unwrap_or(Duration::from_secs(300))
    }

    pub async fn cancelled(&self) {
        self.cancel.cancelled().await;
    }

    pub fn connections(&self) -> ConnectionsClient<'_> {
        ConnectionsClient { ctx: self }
    }

    pub fn access(&self) -> AccessClient<'_> {
        AccessClient { ctx: self }
    }

    pub fn audit(&self) -> AuditClient<'_> {
        AuditClient { ctx: self }
    }

    pub fn entities(&self) -> EntitiesClient<'_> {
        EntitiesClient { ctx: self }
    }

    pub async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        service: &str,
        method: &str,
        params: &P,
    ) -> Result<R> {
        let p = serde_json::to_value(params).map_err(|e| Error::invalid(e.to_string()))?;
        let res = self
            .backend
            .call_service_for(&self.principal, self.call_id(), service, method, p)
            .await?;
        serde_json::from_value(res)
            .map_err(|e| Error::internal(format!("bad response from {service}.{method}: {e}")))
    }

    pub async fn stream<P: Serialize, R: DeserializeOwned + Send + 'static>(
        &self,
        service: &str,
        method: &str,
        params: &P,
    ) -> Result<BoxStream<Result<R>>> {
        let p = serde_json::to_value(params).map_err(|e| Error::invalid(e.to_string()))?;
        let s = self
            .backend
            .stream_service_for(&self.principal, self.call_id(), service, method, p)
            .await?;
        let mapped = s.map(move |item| {
            item.and_then(|v| {
                serde_json::from_value::<R>(v)
                    .map_err(|e| Error::internal(format!("bad stream chunk: {e}")))
            })
        });
        Ok(Box::pin(mapped))
    }
}

pub struct ConnectionsClient<'a> {
    ctx: &'a Ctx,
}

impl<'a> ConnectionsClient<'a> {
    pub async fn get(&self, id: &str) -> Result<Option<ConnectionResolved>> {
        self.ctx
            .backend
            .connection_resolve_for(&self.ctx.principal, self.ctx.call_id(), id)
            .await
    }
}

pub struct AccessClient<'a> {
    ctx: &'a Ctx,
}

impl<'a> AccessClient<'a> {
    pub async fn filter(&self, resources: &[&str], level: Level) -> Result<Vec<String>> {
        self.ctx
            .backend
            .access_filter_for(&self.ctx.principal, self.ctx.call_id(), resources, level)
            .await
    }

    pub async fn require_space(&self, space: &str, level: Level) -> Result<()> {
        self.ctx
            .backend
            .access_require_space_for(&self.ctx.principal, self.ctx.call_id(), space, level)
            .await
    }
}

pub struct AuditClient<'a> {
    ctx: &'a Ctx,
}

impl<'a> AuditClient<'a> {
    pub async fn record(
        &self,
        action: &str,
        resource: Option<&str>,
        details: Option<&Value>,
    ) -> Result<()> {
        self.ctx
            .backend
            .audit_record_for(
                &self.ctx.principal,
                self.ctx.call_id(),
                action,
                resource,
                details.cloned(),
            )
            .await
    }
}

pub struct EntitiesClient<'a> {
    ctx: &'a Ctx,
}

impl<'a> EntitiesClient<'a> {
    pub async fn text(&self, uris: &[&str], max_chars: Option<usize>) -> Result<EntityTexts> {
        self.ctx
            .backend
            .entities_text_for(&self.ctx.principal, self.ctx.call_id(), uris, max_chars)
            .await
    }
}

/// Sender for streaming RPC chunks.
#[derive(Clone)]
pub struct Chunks<T> {
    tx: mpsc::UnboundedSender<T>,
}

impl<T> Chunks<T> {
    pub fn channel() -> (Self, mpsc::UnboundedReceiver<T>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    pub async fn send(&self, value: &T) -> Result<()>
    where
        T: Clone,
    {
        self.tx
            .send(value.clone())
            .map_err(|_| Error::unavailable("the stream caller disconnected"))
    }
}

type MethodHandler = Arc<dyn Fn(Ctx, Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
type StreamHandler =
    Arc<dyn Fn(Ctx, Value, Chunks<Value>) -> BoxFuture<'static, Result<()>> + Send + Sync>;

struct Inner {
    config: Option<Config>,
    client: Client,
    methods: RwLock<HashMap<String, MethodHandler>>,
    streams: RwLock<HashMap<String, StreamHandler>>,
}

/// App-service host handle (mirrors `plans/design.md`'s `rookery_sdk::Rookery`).
#[derive(Clone)]
pub struct Rookery {
    inner: Arc<Inner>,
}

impl std::ops::Deref for Rookery {
    type Target = Client;
    fn deref(&self) -> &Self::Target {
        &self.inner.client
    }
}

impl Rookery {
    pub fn from_backend(backend: Arc<dyn RookeryBackend>, service_id: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Inner {
                config: None,
                client: Client::from_backend(backend, service_id),
                methods: RwLock::default(),
                streams: RwLock::default(),
            }),
        }
    }

    pub fn new(config: Config) -> Result<Self> {
        config.validate()?;
        let backend: Arc<dyn RookeryBackend> = Arc::new(HttpBackend::new(&config));
        let client = Client::from_backend(backend, config.service_id.clone());
        Ok(Self {
            inner: Arc::new(Inner {
                config: Some(config),
                client,
                methods: RwLock::default(),
                streams: RwLock::default(),
            }),
        })
    }

    /// Connects to the Rookery server using `ROOKERY_URL`, `ROOKERY_SERVICE_ID`,
    /// `ROOKERY_SERVICE_SECRET`, `ROOKERY_CALLBACK_SECRET`, and optional `ROOKERY_SERVICE_LISTEN`.
    pub async fn connect() -> Result<Self> {
        Self::new(Config::from_env()?)
    }

    pub fn config(&self) -> Option<&Config> {
        self.inner.config.as_ref()
    }

    pub fn method<P, R, F, Fut>(&self, name: &'static str, handler: F)
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize + Send + 'static,
        F: Fn(Ctx, P) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R>> + Send + 'static,
    {
        let h: MethodHandler = Arc::new(move |ctx, raw| {
            let parsed = serde_json::from_value::<P>(raw);
            match parsed {
                Ok(p) => {
                    let fut = handler(ctx, p);
                    Box::pin(async move {
                        let out = fut.await?;
                        serde_json::to_value(out).map_err(|e| Error::internal(e.to_string()))
                    })
                }
                Err(e) => {
                    Box::pin(async move { Err(Error::invalid(format!("invalid params: {e}"))) })
                }
            }
        });
        self.inner
            .methods
            .write()
            .unwrap()
            .insert(name.to_owned(), h);
    }

    pub fn stream_method<P, F, Fut>(&self, name: &'static str, handler: F)
    where
        P: DeserializeOwned + Send + 'static,
        F: Fn(Ctx, P, Chunks<Value>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let h: StreamHandler = Arc::new(move |ctx, raw, out| {
            let parsed = serde_json::from_value::<P>(raw);
            match parsed {
                Ok(p) => Box::pin(handler(ctx, p, out)),
                Err(e) => {
                    Box::pin(async move { Err(Error::invalid(format!("invalid params: {e}"))) })
                }
            }
        });
        self.inner
            .streams
            .write()
            .unwrap()
            .insert(name.to_owned(), h);
    }

    pub async fn dispatch(&self, ctx: Ctx, method: &str, params: Value) -> Result<Value> {
        let handler = self
            .inner
            .methods
            .read()
            .unwrap()
            .get(method)
            .cloned()
            .ok_or_else(|| Error::not_found(format!("unknown method {method}")))?;
        handler(ctx, params).await
    }

    pub async fn dispatch_stream(
        &self,
        ctx: Ctx,
        method: &str,
        params: Value,
        out: Chunks<Value>,
    ) -> Result<()> {
        let handler = self
            .inner
            .streams
            .read()
            .unwrap()
            .get(method)
            .cloned()
            .ok_or_else(|| Error::not_found(format!("unknown stream method {method}")))?;
        handler(ctx, params, out).await
    }

    pub fn registered_methods(&self) -> Vec<String> {
        let mut names: Vec<String> = self.inner.methods.read().unwrap().keys().cloned().collect();
        names.extend(self.inner.streams.read().unwrap().keys().cloned());
        names
    }

    /// Axum router serving `POST /rpc` and `GET /healthz`.
    pub fn router(&self) -> Router {
        Router::new()
            .route("/rpc", post(handle_rpc))
            .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
            .with_state(self.inner.clone())
    }

    /// Serves inbound RPC requests on an existing listener until `shutdown` resolves.
    pub async fn serve_on(
        &self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        axum::serve(listener, self.router())
            .with_graceful_shutdown(shutdown)
            .await
            .map_err(|e| Error::internal(format!("service HTTP server failed: {e}")))
    }

    pub async fn serve(&self) -> Result<()> {
        let Some(cfg) = &self.inner.config else {
            return self.inner.client.backend.serve().await;
        };
        let listener = TcpListener::bind(&cfg.listen)
            .await
            .map_err(|e| Error::unavailable(format!("failed to bind {}: {e}", cfg.listen)))?;
        tracing::info!(
            listen = %cfg.listen,
            service = %cfg.service_id,
            "rookery app service listening"
        );
        self.serve_on(listener, shutdown_signal()).await
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboundCtx {
    #[serde(default)]
    call_id: String,
    #[serde(default)]
    user: Option<User>,
    #[serde(default)]
    principal: Option<Principal>,
    #[serde(default)]
    space: Option<String>,
    #[serde(default)]
    deadline: Option<i64>,
}

#[derive(Deserialize)]
struct InboundRequest {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default = "empty_obj")]
    params: Value,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    ctx: Option<InboundCtx>,
}

fn empty_obj() -> Value {
    json!({})
}

fn rpc_response(status: StatusCode, id: Value, res: Result<Value>) -> Response {
    let body = match res {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error.0 }),
    };
    (status, axum::Json(body)).into_response()
}

struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn deadline_duration(deadline_ms: Option<i64>) -> Duration {
    let Some(ms) = deadline_ms else {
        return Duration::from_secs(300);
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let left = (ms - now_ms).max(1) as u64;
    Duration::from_millis(left)
}

async fn handle_rpc(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(cfg) = &inner.config else {
        return rpc_response(
            StatusCode::SERVICE_UNAVAILABLE,
            Value::Null,
            Err(Error::unavailable("service has no HTTP config")),
        );
    };
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::trim)
    else {
        return rpc_response(
            StatusCode::UNAUTHORIZED,
            Value::Null,
            Err(Error::unauthenticated("missing service bearer token")),
        );
    };
    if !secret_eq(token, &cfg.inbound_secret) {
        return rpc_response(
            StatusCode::UNAUTHORIZED,
            Value::Null,
            Err(Error::unauthenticated("invalid service bearer token")),
        );
    };
    let req: InboundRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(e) => {
            return rpc_response(
                StatusCode::BAD_REQUEST,
                Value::Null,
                Err(Error::invalid(format!("invalid JSON-RPC request: {e}"))),
            );
        }
    };
    let cancel = CancellationToken::new();
    let ictx = req.ctx.unwrap_or(InboundCtx {
        call_id: String::new(),
        user: None,
        principal: None,
        space: None,
        deadline: None,
    });
    let principal = ictx
        .principal
        .unwrap_or_else(|| inner.client.principal().clone());
    let ctx = Ctx::new(
        inner.client.backend.clone(),
        principal,
        ictx.user,
        ictx.space,
    )
    .with_call_id(ictx.call_id)
    .with_deadline(deadline_duration(ictx.deadline))
    .with_cancel(cancel.clone());

    if req.stream {
        let handler = inner.streams.read().unwrap().get(&req.method).cloned();
        let Some(handler) = handler else {
            return rpc_response(
                StatusCode::OK,
                req.id,
                Err(Error::not_found(format!(
                    "unknown stream method {}",
                    req.method
                ))),
            );
        };
        let (chunks, rx) = Chunks::<Value>::channel();
        let (err_tx, err_rx) = tokio::sync::oneshot::channel::<Error>();
        tokio::spawn(async move {
            if let Err(err) = handler(ctx, req.params, chunks).await {
                let _ = err_tx.send(err);
            }
        });
        let id = req.id;
        let guard = Arc::new(CancelOnDrop(cancel));
        let stream = futures::stream::unfold(
            (rx, Some(err_rx), false, id, guard),
            |(mut rx, mut err_rx, done, id, guard)| async move {
                if done {
                    return None;
                }
                if let Some(chunk) = rx.recv().await {
                    let mut line = serde_json::to_vec(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": chunk,
                    }))
                    .unwrap_or_default();
                    line.push(b'\n');
                    return Some((
                        Ok::<_, std::io::Error>(axum::body::Bytes::from(line)),
                        (rx, err_rx, false, id, guard),
                    ));
                }
                let final_json = match err_rx.take() {
                    Some(rx_err) => match rx_err.await {
                        Ok(err) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": err.0,
                        }),
                        Err(_) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                        }),
                    },
                    None => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                    }),
                };
                let mut line = serde_json::to_vec(&final_json).unwrap_or_default();
                line.push(b'\n');
                Some((
                    Ok(axum::body::Bytes::from(line)),
                    (rx, None, true, id, guard),
                ))
            },
        );
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/x-ndjson")],
            Body::from_stream(stream),
        )
            .into_response();
    }
    let handler = inner.methods.read().unwrap().get(&req.method).cloned();
    let Some(handler) = handler else {
        return rpc_response(
            StatusCode::OK,
            req.id,
            Err(Error::not_found(format!("unknown method {}", req.method))),
        );
    };
    let _drop_cancel = CancelOnDrop(cancel);
    let res = handler(ctx, req.params).await;
    rpc_response(StatusCode::OK, req.id, res)
}

pub fn principal_uri(p: &Principal) -> String {
    p.uri()
}
