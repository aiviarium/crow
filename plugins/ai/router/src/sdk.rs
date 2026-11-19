//! Rookery app-service SDK shim built on `rookery-proto`.
//!
//! Rookery's M2 app-service SDK (`rookery-sdk`, see `plans/design.md` § "Write a plugin's app service")
//! is not yet implemented in `rookery/`. This module binds `rookery_proto` wire types (`RpcError`,
//! `ErrorCode`, `User`, `Principal`, `PrincipalKind`, `Grant`, `ConnectionResolved`) to the backend
//! traits the AI router uses, so every pure & async flow compiles and tests cleanly against a fake
//! backend while keeping the exact migration path to `rookery-sdk` documented in `../API.md`.

use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::Stream;
pub use rookery_proto::facilities::{ConnectionInfo, ConnectionResolved, Scope as FacilityScope};
pub use rookery_proto::methods::Grant as Level;
pub use rookery_proto::{ErrorCode, Principal, PrincipalKind, RpcError, User};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;
pub use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

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

#[derive(Debug, Clone, PartialEq)]
pub struct Contribution<T> {
    pub plugin: String,
    pub value: T,
    pub service: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityTextItem {
    pub uri: String,
    pub title: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
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
    fn aggregate<'a>(&'a self, collection: &'a str, spec: Value) -> BoxFuture<'a, Result<Vec<Value>>>;

    fn connection_resolve<'a>(
        &'a self,
        principal: &'a Principal,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<ConnectionResolved>>>;

    fn access_filter<'a>(
        &'a self,
        principal: &'a Principal,
        resources: &'a [&'a str],
        level: Level,
    ) -> BoxFuture<'a, Result<Vec<String>>>;

    fn access_require_space<'a>(
        &'a self,
        principal: &'a Principal,
        space: &'a str,
        level: Level,
    ) -> BoxFuture<'a, Result<()>>;

    fn extensions_list<'a>(&'a self, point: &'a str) -> BoxFuture<'a, Result<Vec<Contribution<Value>>>>;
    fn extensions_changed<'a>(&'a self, point: &'a str) -> BoxFuture<'a, Result<BoxStream<Result<()>>>>;

    fn call_service<'a>(
        &'a self,
        principal: &'a Principal,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value>>;

    fn stream_service<'a>(
        &'a self,
        principal: &'a Principal,
        service: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<BoxStream<Result<Value>>>>;

    fn entities_text<'a>(
        &'a self,
        principal: &'a Principal,
        uris: &'a [&'a str],
    ) -> BoxFuture<'a, Result<EntityTexts>>;

    fn audit_record<'a>(
        &'a self,
        principal: &'a Principal,
        action: &'a str,
        resource: Option<&'a str>,
        details: Option<Value>,
    ) -> BoxFuture<'a, Result<()>>;

    fn serve(&self) -> BoxFuture<'_, Result<()>>;
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
        let v = self.backend.upsert(self.name, row.clone(), conflict_keys).await?;
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
            let value = serde_json::from_value(item.value)
                .map_err(|e| Error::internal(format!("invalid contribution on {point}: {e}")))?;
            out.push(Contribution {
                plugin: item.plugin,
                value,
                service: item.service,
            });
        }
        Ok(out)
    }

    pub async fn changed(&self, point: &str) -> Result<BoxStream<Result<()>>> {
        self.backend.extensions_changed(point).await
    }
}

/// Per-request call context, carrying caller identity, cancellation, deadline, and facility clients.
#[derive(Clone)]
pub struct Ctx {
    backend: Arc<dyn RookeryBackend>,
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
            principal,
            user,
            space,
            deadline: None,
            cancel: CancellationToken::new(),
        }
    }

    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = Some(deadline);
        self
    }

    pub fn with_cancel(mut self, cancel: CancellationToken) -> Self {
        self.cancel = cancel;
        self
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
            .call_service(&self.principal, service, method, p)
            .await?;
        serde_json::from_value(res).map_err(|e| Error::internal(format!("bad response from {service}.{method}: {e}")))
    }

    pub async fn stream<P: Serialize, R: DeserializeOwned + Send + 'static>(
        &self,
        service: &str,
        method: &str,
        params: &P,
    ) -> Result<BoxStream<Result<R>>> {
        use futures::StreamExt;
        let p = serde_json::to_value(params).map_err(|e| Error::invalid(e.to_string()))?;
        let s = self
            .backend
            .stream_service(&self.principal, service, method, p)
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
            .connection_resolve(&self.ctx.principal, id)
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
            .access_filter(&self.ctx.principal, resources, level)
            .await
    }

    pub async fn require_space(&self, space: &str, level: Level) -> Result<()> {
        self.ctx
            .backend
            .access_require_space(&self.ctx.principal, space, level)
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
            .audit_record(&self.ctx.principal, action, resource, details.cloned())
            .await
    }
}

pub struct EntitiesClient<'a> {
    ctx: &'a Ctx,
}

impl<'a> EntitiesClient<'a> {
    pub async fn text(&self, uris: &[&str], _max_chars: Option<usize>) -> Result<EntityTexts> {
        self.ctx.backend.entities_text(&self.ctx.principal, uris).await
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

/// App-service host handle (mirrors `plans/design.md`'s `rookery_sdk::Rookery`).
pub struct Rookery {
    client: Client,
    methods: Mutex<Vec<(&'static str, MethodHandler)>>,
    streams: Mutex<Vec<(&'static str, StreamHandler)>>,
}

impl std::ops::Deref for Rookery {
    type Target = Client;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl Rookery {
    pub fn from_backend(backend: Arc<dyn RookeryBackend>, service_id: impl Into<String>) -> Self {
        Self {
            client: Client::from_backend(backend, service_id),
            methods: Mutex::new(Vec::new()),
            streams: Mutex::new(Vec::new()),
        }
    }

    /// Connects to the Rookery server using `ROOKERY_URL`, `ROOKERY_SERVICE_ID`,
    /// `ROOKERY_SERVICE_SECRET`, and optional `ROOKERY_REPLICA`.
    pub async fn connect() -> Result<Self> {
        let url = std::env::var("ROOKERY_URL").unwrap_or_default();
        let service_id = std::env::var("ROOKERY_SERVICE_ID").unwrap_or_default();
        let secret = std::env::var("ROOKERY_SERVICE_SECRET").unwrap_or_default();
        let _replica = std::env::var("ROOKERY_REPLICA").ok();
        if url.is_empty() || service_id.is_empty() || secret.is_empty() {
            return Err(Error::unavailable(
                "ROOKERY_URL, ROOKERY_SERVICE_ID, and ROOKERY_SERVICE_SECRET are required to connect to Rookery",
            ));
        }
        Err(Error::unavailable(format!(
            "cannot connect to {url}: Rookery M2 app-service transport (rookery-sdk) is not implemented yet"
        )))
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
                Err(e) => Box::pin(async move { Err(Error::invalid(format!("invalid params: {e}"))) }),
            }
        });
        self.methods.lock().unwrap().push((name, h));
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
                Err(e) => Box::pin(async move { Err(Error::invalid(format!("invalid params: {e}"))) }),
            }
        });
        self.streams.lock().unwrap().push((name, h));
    }

    pub async fn dispatch(&self, ctx: Ctx, method: &str, params: Value) -> Result<Value> {
        let handler = self
            .methods
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| *n == method)
            .map(|(_, h)| h.clone())
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
            .streams
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| *n == method)
            .map(|(_, h)| h.clone())
            .ok_or_else(|| Error::not_found(format!("unknown stream method {method}")))?;
        handler(ctx, params, out).await
    }

    pub fn registered_methods(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.methods.lock().unwrap().iter().map(|(n, _)| *n).collect();
        names.extend(self.streams.lock().unwrap().iter().map(|(n, _)| *n));
        names
    }

    pub async fn serve(&self) -> Result<()> {
        self.client.backend.serve().await
    }
}

pub fn principal_uri(p: &Principal) -> String {
    p.uri()
}
