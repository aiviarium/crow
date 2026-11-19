//! The router: resolves a task to a connection and a model for the caller, enforces the budget, calls the
//! provider and records usage. Everything it knows lives in collections and connections; the only state
//! it keeps is a cache of the providers (until `extensions.changed.ai.providers`) and the dictations in progress.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::budget::{self, Limits, Used};
use crate::conn::Conn;
use crate::models::{
    self, CancellationToken, ContextItem, GENERATE_TIMEOUT, GenerateIn, Message, Role, TRANSCRIBE_TIMEOUT,
    TranscribeIn,
};
use crate::provider::{self, BUILTIN_TYPE, Builtin, Def, POINT, Provider};
use crate::rules::{self, Caller};
use crate::sdk::{Client, Ctx, Error, Filter, Level, Query, Result, field};
use crate::transport::SharedTransport;
use crate::types::{
    GenerateParams, Generated, Limit, Mapping, MappingInfo, MappingScope, MessageRole, ModelInfo,
    ModelsParams, Scope, Task, TaskInfo, TokenUsage, Transcribed, UsageRow,
};

pub const USAGE_COLLECTION: &str = "usage";

/// The state of the router, shared by every call.
pub struct Router {
    /// Acts as the plugin's service principal.
    pub svc: Client,
    pub builtin: Builtin,
    providers: RwLock<Option<Arc<Vec<Provider>>>>,
    generation: AtomicU64,
    pub dictations: Mutex<HashMap<String, Arc<crate::dictation::Dictation>>>,
    rows: Mutex<HashMap<String, (Instant, Vec<Mapping>)>>,
    limits: Mutex<HashMap<String, (Instant, Limits)>>,
}

const CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Resolved {
    pub task: Task,
    pub scope: Scope,
    pub conn: Conn,
    pub provider: Provider,
    pub model: String,
    pub live: bool,
}

impl Resolved {
    pub fn info(&self) -> TaskInfo {
        let (destination, _) = self.provider.destination(&self.conn);
        TaskInfo {
            task: self.task,
            available: true,
            scope: Some(self.scope),
            provider: Some(self.provider.id()),
            model: Some(self.model.clone()),
            destination: Some(destination),
            live: self.task == Task::Transcription
                && self.live
                && matches!(self.provider, Provider::Builtin),
            detects_language: self.provider.detects_language(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Who {
    pub user: Option<String>,
    pub principal: String,
    pub plugin: String,
}

impl Who {
    pub fn of(ctx: &Ctx, claimed: Option<&str>) -> Who {
        Who {
            user: ctx.user().map(|u| u.id.clone()),
            principal: ctx.principal().uri(),
            plugin: claimed
                .filter(|p| !p.is_empty() && p.len() <= 100)
                .unwrap_or("crow")
                .to_string(),
        }
    }
}

pub struct Prepared {
    pub resolved: Resolved,
    pub who: Who,
}

pub fn caller_of<'a>(ctx: &'a Ctx, space: Option<&'a str>) -> Caller<'a> {
    Caller {
        user: ctx.user().map(|u| u.id.as_str()),
        admin: ctx.user().is_some_and(|u| u.admin),
        space: space.or(ctx.space()),
    }
}

pub fn require_admin(ctx: &Ctx, what: &str) -> Result<()> {
    if ctx.user().is_some_and(|u| u.admin) {
        Ok(())
    } else {
        Err(Error::forbidden(format!("only admins see {what}")))
    }
}

pub fn request_id(given: Option<String>) -> Result<String> {
    models::request_id(given).map_err(provider::model_error)
}

fn to_messages(p: &GenerateParams) -> Vec<Message> {
    let mut messages: Vec<Message> = p
        .messages
        .iter()
        .flatten()
        .map(|m| Message {
            role: match m.role {
                MessageRole::User => Role::User,
                MessageRole::Assistant => Role::Assistant,
            },
            content: m.content.clone(),
        })
        .collect();
    if let Some(prompt) = &p.prompt {
        messages.push(Message {
            role: Role::User,
            content: prompt.clone(),
        });
    }
    messages
}

impl Router {
    pub fn new(svc: Client) -> Arc<Router> {
        Self::with_transport(svc, SharedTransport::default())
    }

    pub fn with_transport(svc: Client, transport: SharedTransport) -> Arc<Router> {
        Arc::new(Router {
            svc,
            builtin: Builtin::new(transport),
            providers: RwLock::new(None),
            generation: AtomicU64::new(0),
            dictations: Mutex::new(HashMap::new()),
            rows: Mutex::new(HashMap::new()),
            limits: Mutex::new(HashMap::new()),
        })
    }

    pub async fn providers(&self) -> Result<Arc<Vec<Provider>>> {
        if let Some(p) = self.providers.read().unwrap().clone() {
            return Ok(p);
        }
        let generation = self.generation.load(Ordering::Acquire);
        let list = self.svc.extensions().list::<Def>(POINT).await?;
        let p = Arc::new(provider::from_contributions(list));
        if self.generation.load(Ordering::Acquire) == generation {
            *self.providers.write().unwrap() = Some(p.clone());
        }
        Ok(p)
    }

    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        *self.providers.write().unwrap() = None;
    }

    pub fn watch(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let router = self.clone();
        tokio::spawn(async move {
            loop {
                match router.svc.extensions().changed(POINT).await {
                    Ok(mut feed) => {
                        router.invalidate();
                        while let Some(ev) = feed.next().await {
                            if ev.is_ok() {
                                router.invalidate();
                            }
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "subscribing to the provider contributions failed"),
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        })
    }

    pub fn forget_settings(&self) {
        self.rows.lock().unwrap().clear();
        self.limits.lock().unwrap().clear();
    }

    async fn mapping_rows(&self, task: Task, caller: &Caller<'_>) -> Result<Vec<Mapping>> {
        let key = format!(
            "{}|{}|{}",
            task.as_str(),
            caller.space.unwrap_or_default(),
            caller.user.unwrap_or_default()
        );
        if let Some((at, rows)) = self.rows.lock().unwrap().get(&key)
            && at.elapsed() < CACHE_TTL
        {
            return Ok(rows.clone());
        }
        let rows = self.read_mapping_rows(task, caller).await?;
        self.rows
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), rows.clone()));
        Ok(rows)
    }

    async fn read_mapping_rows(&self, task: Task, caller: &Caller<'_>) -> Result<Vec<Mapping>> {
        let mut any = vec![field("scope").eq("global")];
        if let Some(space) = caller.space {
            any.push(Filter::all_of([
                field("scope").eq("space"),
                field("space").eq(space),
            ]));
        }
        if let Some(user) = caller.user {
            any.push(Filter::all_of([
                field("scope").eq("user"),
                field("user").eq(user),
            ]));
        }
        let filter = Filter::all_of([field("task").eq(task.as_str()), Filter::any_of(any)]);
        Ok(self
            .svc
            .data::<Mapping>()
            .find(Query::new().filter(filter).limit(20))
            .await?
            .rows)
    }

    pub async fn connection(&self, ctx: &Ctx, id: &str) -> Result<Option<Conn>> {
        match ctx.connections().get(id).await {
            Ok(Some(c)) => Ok(Some(Conn::from_resolved(c, ctx.user().map(|u| u.id.as_str())))),
            Ok(None) => Ok(None),
            Err(e) if e.is_not_found() || e.is_forbidden() => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn resolve(&self, ctx: &Ctx, caller: &Caller<'_>, task: Task) -> Result<Option<Resolved>> {
        let (providers, rows) = tokio::try_join!(self.providers(), self.mapping_rows(task, caller))?;
        for m in rules::candidates(rows, caller, task) {
            let free = caller.admin || (caller.user.is_none() && m.scope == MappingScope::Global);
            let uri = format!("connection://{}", m.connection);
            let (conn, allowed) = tokio::try_join!(self.connection(ctx, &m.connection), async {
                if free {
                    Ok(true)
                } else {
                    Ok(!ctx.access().filter(&[&uri], Level::Use).await?.is_empty())
                }
            })?;
            let Some(conn) = conn else {
                continue;
            };
            if !rules::usable(caller, m.scope, allowed) {
                continue;
            }
            let Some(p) = provider::for_type(&providers, &conn.kind) else {
                continue;
            };
            if !p.tasks().contains(&task) {
                continue;
            }
            return Ok(Some(Resolved {
                task,
                scope: rules::scope_of(m.scope),
                provider: p.clone(),
                model: m.model.clone(),
                live: m.live.unwrap_or(false),
                conn,
            }));
        }
        Ok(None)
    }

    pub async fn prepare(
        &self,
        ctx: &Ctx,
        task: Task,
        space: Option<&str>,
        plugin: Option<&str>,
    ) -> Result<Prepared> {
        let caller = caller_of(ctx, space);
        let resolved = self.resolve(ctx, &caller, task).await?.ok_or_else(|| {
            Error::unavailable(format!(
                "no model is set up for the {} task; an admin maps it under Admin › Models",
                task.as_str()
            ))
            .with_details(json!({ "task": task }))
        })?;
        let who = Who::of(ctx, plugin);
        self.check_budget(&who, task).await?;
        Ok(Prepared { resolved, who })
    }

    pub async fn limits_for(&self, user: &str) -> Result<Limits> {
        if let Some((at, limits)) = self.limits.lock().unwrap().get(user)
            && at.elapsed() < CACHE_TTL
        {
            return Ok(*limits);
        }
        let limits = self.read_limits(user).await?;
        self.limits
            .lock()
            .unwrap()
            .insert(user.to_string(), (Instant::now(), limits));
        Ok(limits)
    }

    async fn read_limits(&self, user: &str) -> Result<Limits> {
        let rows = self
            .svc
            .data::<Limit>()
            .find(Query::new().filter(field("user").is_in([user, "default"])).limit(2))
            .await?
            .rows;
        let own = rows.iter().find(|r| r.user == user);
        let default = rows.iter().find(|r| r.user == "default");
        Ok(budget::effective(own, default))
    }

    pub async fn used_today(&self, user: &str, now: OffsetDateTime) -> Result<Used> {
        let since = fmt_time(budget::start_of_day(now));
        let rows = self
            .svc
            .collection(USAGE_COLLECTION)
            .aggregate(&json!({
                "where": { "and": [{ "user": { "eq": user } }, { "at": { "gte": since } }] },
                "measures": {
                    "requests": { "count": true },
                    "inTokens": { "sum": "inputTokens" },
                    "outTokens": { "sum": "outputTokens" },
                    "audio": { "sum": "audioSeconds" },
                },
            }))
            .await?;
        let row = rows.first().cloned().unwrap_or(Value::Null);
        let num = |k: &str| row.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        Ok(Used {
            requests: num("requests") as i64,
            tokens: (num("inTokens") + num("outTokens")) as i64,
            audio_seconds: num("audio"),
        })
    }

    pub async fn check_budget(&self, who: &Who, task: Task) -> Result<()> {
        let Some(user) = &who.user else { return Ok(()) };
        let limits = self.limits_for(user).await?;
        if limits.is_empty() {
            return Ok(());
        }
        let now = OffsetDateTime::now_utc();
        let used = self.used_today(user, now).await?;
        budget::check(&limits, &used, task, now)
    }

    pub async fn record(
        &self,
        who: &Who,
        r: &Resolved,
        model: &str,
        usage: &TokenUsage,
        started: Instant,
        error: Option<&Error>,
    ) {
        let row = json!({
            "at": fmt_time(OffsetDateTime::now_utc()),
            "user": who.user,
            "principal": who.principal,
            "plugin": who.plugin,
            "task": r.task,
            "provider": r.provider.id(),
            "model": model,
            "connection": r.conn.id,
            "inputTokens": usage.input_tokens,
            "outputTokens": usage.output_tokens,
            "audioSeconds": usage.audio_seconds,
            "ok": error.is_none(),
            "error": error.map(|e| format!("{}: {}", e.code(), e.message())),
            "durationMs": started.elapsed().as_millis().min(i32::MAX as u128) as i64,
        });
        if let Err(e) = self.svc.collection(USAGE_COLLECTION).insert(&row).await {
            tracing::warn!(error = %e, "recording model service usage failed");
        }
    }

    pub async fn generate(
        &self,
        ctx: &Ctx,
        p: GenerateParams,
        cancel: &CancellationToken,
        delta: impl FnMut(&str) + Send,
    ) -> Result<Generated> {
        let messages = to_messages(&p);
        if messages.is_empty() && p.system.as_deref().is_none_or(str::is_empty) {
            return Err(Error::invalid(
                "a generation needs messages, a prompt or a system prompt",
            ));
        }
        let request = request_id(p.request.clone())?;
        let started = Instant::now();
        let prep = self
            .prepare(ctx, p.task, p.space.as_deref(), p.plugin.as_deref())
            .await?;
        let r = &prep.resolved;
        let system = match p.context.as_deref() {
            Some(uris) if !uris.is_empty() => {
                let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                let texts = ctx.entities().text(&refs, None).await?;
                let items: Vec<ContextItem> = texts
                    .texts
                    .into_iter()
                    .map(|t| ContextItem {
                        uri: t.uri,
                        title: t.title,
                        text: t.text,
                    })
                    .collect();
                models::with_context(p.system.clone(), &items)
            }
            _ => p.system.clone(),
        };
        let input = GenerateIn {
            request: request.clone(),
            task: provider::to_model_task(p.task),
            model: r.model.clone(),
            system,
            messages,
            schema: p
                .schema
                .as_ref()
                .map(|s| Value::Object(s.clone().into_iter().collect())),
            schema_name: p.schema_name.clone(),
            max_tokens: p.max_tokens.map(|n| n as u32),
            temperature: p.temperature.map(|t| t as f32),
        };
        let out = provider::generate(
            ctx,
            &self.builtin,
            &r.provider,
            &r.conn,
            input,
            time_left(ctx, GENERATE_TIMEOUT),
            cancel,
            delta,
        )
        .await;
        match out {
            Ok(o) => {
                let usage = TokenUsage {
                    input_tokens: o.usage.input_tokens,
                    output_tokens: o.usage.output_tokens,
                    audio_seconds: o.usage.audio_seconds,
                };
                self.record(&prep.who, r, &o.model, &usage, started, None).await;
                Ok(Generated {
                    request,
                    text: o.text,
                    object: o.object.unwrap_or(Value::Null),
                    model: o.model,
                    provider: r.provider.id(),
                    usage,
                })
            }
            Err(e) => {
                self.record(&prep.who, r, &r.model, &no_usage(), started, Some(&e))
                    .await;
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn transcribe_clip(
        &self,
        ctx: &Ctx,
        prep: &Prepared,
        request: &str,
        mime: &str,
        language: Option<&str>,
        audio: &[u8],
        seconds: Option<f64>,
        cancel: &CancellationToken,
    ) -> Result<Transcribed> {
        if audio.is_empty() {
            return Err(Error::invalid("no audio arrived"));
        }
        let started = Instant::now();
        let r = &prep.resolved;
        let input = TranscribeIn {
            request: request.into(),
            model: r.model.clone(),
            mime: mime.into(),
            language: models::normalize_language(language),
        };
        let out = provider::transcribe(
            ctx,
            &self.builtin,
            &r.provider,
            &r.conn,
            &input,
            audio,
            time_left(ctx, TRANSCRIBE_TIMEOUT),
            cancel,
        )
        .await;
        let (usage, model, error) = match &out {
            Ok(o) => (
                TokenUsage {
                    audio_seconds: o.seconds.or(seconds),
                    ..no_usage()
                },
                o.model.clone(),
                None,
            ),
            Err(e) => (
                TokenUsage {
                    audio_seconds: seconds,
                    ..no_usage()
                },
                r.model.clone(),
                Some(e),
            ),
        };
        self.record(&prep.who, r, &model, &usage, started, error).await;
        let o = out?;
        Ok(Transcribed {
            request: request.into(),
            text: o.text,
            language: o.language,
            seconds: o.seconds.or(seconds),
            model: o.model,
            provider: r.provider.id(),
        })
    }

    pub async fn wire(&self, ctx: &Ctx, providers: &[Provider], m: &Mapping) -> Result<Option<MappingInfo>> {
        let Some(conn) = self.connection(ctx, &m.connection).await? else {
            return Ok(None);
        };
        let provider = provider::for_type(providers, &conn.kind);
        let (destination, local) = match provider {
            Some(p) => p.destination(&conn),
            None => (format!("no provider for {}", conn.kind), false),
        };
        Ok(Some(MappingInfo {
            task: rules::task_of(m.task),
            scope: rules::scope_of(m.scope),
            space_id: m.space.clone(),
            user_id: m.user.clone(),
            connection: conn.id.clone(),
            connection_name: conn.name.clone(),
            connection_type: conn.kind.clone(),
            provider: provider.map(Provider::id).unwrap_or_default(),
            model: m.model.clone(),
            live: m.live.unwrap_or(false),
            destination,
            local,
            updated_at: fmt_time(m.updated_at),
        }))
    }

    pub async fn models(&self, ctx: &Ctx, p: ModelsParams) -> Result<Vec<ModelInfo>> {
        let conn = self
            .connection(ctx, &p.connection)
            .await?
            .ok_or_else(|| Error::not_found("no such connection"))?;
        if ctx.access().filter(&[&conn.uri], Level::Use).await?.is_empty() {
            return Err(Error::forbidden("you may not use this connection"));
        }
        let providers = self.providers().await?;
        let provider = provider::for_type(&providers, &conn.kind).ok_or_else(|| {
            Error::invalid(format!(
                "connections of type {} are not a model provider",
                conn.kind
            ))
        })?;
        provider::models_for(ctx, &self.builtin, provider, &conn).await
    }

    pub async fn usage_rows(&self, by: &str, since: OffsetDateTime) -> Result<Vec<UsageRow>> {
        let key = match by {
            "day" => json!({ "field": "at", "by": "day" }),
            other => json!(other),
        };
        let group = by;
        let rows = self
            .svc
            .collection(USAGE_COLLECTION)
            .aggregate(&json!({
                "where": { "at": { "gte": fmt_time(since) } },
                "groupBy": [key, "ok"],
                "measures": {
                    "requests": { "count": true },
                    "inTokens": { "sum": "inputTokens" },
                    "outTokens": { "sum": "outputTokens" },
                    "audio": { "sum": "audioSeconds" },
                },
                "limit": 1000,
            }))
            .await?;
        let field_name = if group == "day" { "at" } else { group };
        let mut out: Vec<UsageRow> = Vec::new();
        for row in rows {
            let key = match row.get(field_name) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => String::new(),
                Some(v) => v.to_string(),
            };
            let ok = row.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let num = |k: &str| row.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let requests = num("requests") as i64;
            let at = out.iter().position(|r| r.key == key);
            let target = match at {
                Some(i) => &mut out[i],
                None => {
                    out.push(UsageRow {
                        key,
                        label: None,
                        requests: 0,
                        errors: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        audio_seconds: 0.0,
                    });
                    out.last_mut().expect("just pushed")
                }
            };
            target.requests += requests;
            if !ok {
                target.errors += requests;
            }
            target.input_tokens += num("inTokens") as i64;
            target.output_tokens += num("outTokens") as i64;
            target.audio_seconds += num("audio");
        }
        out.sort_by(|a, b| {
            if group == "day" {
                a.key.cmp(&b.key)
            } else {
                b.requests.cmp(&a.requests).then(a.key.cmp(&b.key))
            }
        });
        Ok(out)
    }
}

pub fn no_usage() -> TokenUsage {
    TokenUsage {
        input_tokens: None,
        output_tokens: None,
        audio_seconds: None,
    }
}

pub fn fmt_time(t: OffsetDateTime) -> String {
    t.to_offset(time::UtcOffset::UTC)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn time_left(ctx: &Ctx, limit: Duration) -> Duration {
    ctx.time_left().min(limit)
}

pub fn builtin_type() -> &'static str {
    BUILTIN_TYPE
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rookery_proto::facilities::{ConnectionInfo, ConnectionResolved, Scope as FacilityScope};
    use rookery_proto::{Principal, PrincipalKind, User};
    use serde_json::{Value, json};

    use super::*;
    use crate::models::{Transport, TransportError, TransportRequest, TransportResponse};
    use crate::sdk::{BoxFuture, BoxStream, Contribution, EntityTexts, RookeryBackend};
    use crate::transport::SharedTransport;

    struct FakeBackend {
        mappings: Mutex<Vec<Value>>,
        usage: Mutex<Vec<Value>>,
        connections: Mutex<Vec<ConnectionResolved>>,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                mappings: Mutex::new(vec![json!({
                    "id": "m1",
                    "updatedAt": "2026-11-14T12:00:00Z",
                    "key": "text|global||",
                    "task": "text",
                    "scope": "global",
                    "connection": "c-openai",
                    "model": "gpt-4o-mini",
                    "live": false,
                })]),
                usage: Mutex::new(Vec::new()),
                connections: Mutex::new(vec![ConnectionResolved {
                    connection: ConnectionInfo {
                        id: "c-openai".into(),
                        kind: "ai.openai-compatible".into(),
                        name: "Local Ollama".into(),
                        scope: FacilityScope::Global,
                        config: json!({ "baseUrl": "http://127.0.0.1:11434/v1" }),
                        has_credential: true,
                        updated_at: "2026-11-14T12:00:00Z".into(),
                    },
                    credential: Some("sk-fake-secret".into()),
                }]),
            }
        }
    }

    impl RookeryBackend for FakeBackend {
        fn find<'a>(&'a self, collection: &'a str, _query: Query) -> BoxFuture<'a, Result<Vec<Value>>> {
            Box::pin(async move {
                match collection {
                    "mappings" => Ok(self.mappings.lock().unwrap().clone()),
                    _ => Ok(Vec::new()),
                }
            })
        }

        fn insert<'a>(&'a self, collection: &'a str, row: Value) -> BoxFuture<'a, Result<Value>> {
            Box::pin(async move {
                if collection == "usage" {
                    self.usage.lock().unwrap().push(row.clone());
                }
                Ok(row)
            })
        }

        fn upsert<'a>(
            &'a self,
            _collection: &'a str,
            row: Value,
            _keys: &'a [&'a str],
        ) -> BoxFuture<'a, Result<Value>> {
            Box::pin(async move { Ok(row) })
        }

        fn delete<'a>(&'a self, _collection: &'a str, _id: &'a str) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move { Ok(()) })
        }

        fn aggregate<'a>(&'a self, _collection: &'a str, _spec: Value) -> BoxFuture<'a, Result<Vec<Value>>> {
            Box::pin(async move { Ok(Vec::new()) })
        }

        fn connection_resolve<'a>(
            &'a self,
            _principal: &'a Principal,
            id: &'a str,
        ) -> BoxFuture<'a, Result<Option<ConnectionResolved>>> {
            Box::pin(async move {
                Ok(self
                    .connections
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|c| c.connection.id == id)
                    .cloned())
            })
        }

        fn access_filter<'a>(
            &'a self,
            _principal: &'a Principal,
            resources: &'a [&'a str],
            _level: Level,
        ) -> BoxFuture<'a, Result<Vec<String>>> {
            Box::pin(async move { Ok(resources.iter().map(|s| (*s).to_string()).collect()) })
        }

        fn access_require_space<'a>(
            &'a self,
            _principal: &'a Principal,
            _space: &'a str,
            _level: Level,
        ) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move { Ok(()) })
        }

        fn extensions_list<'a>(&'a self, _point: &'a str) -> BoxFuture<'a, Result<Vec<Contribution<Value>>>> {
            Box::pin(async move { Ok(Vec::new()) })
        }

        fn extensions_changed<'a>(&'a self, _point: &'a str) -> BoxFuture<'a, Result<BoxStream<Result<()>>>> {
            Box::pin(async move { Ok(Box::pin(futures::stream::empty()) as BoxStream<Result<()>>) })
        }

        fn call_service<'a>(
            &'a self,
            _principal: &'a Principal,
            service: &'a str,
            method: &'a str,
            _params: Value,
        ) -> BoxFuture<'a, Result<Value>> {
            Box::pin(async move { Err(Error::not_found(format!("no service {service}.{method}"))) })
        }

        fn stream_service<'a>(
            &'a self,
            _principal: &'a Principal,
            service: &'a str,
            method: &'a str,
            _params: Value,
        ) -> BoxFuture<'a, Result<BoxStream<Result<Value>>>> {
            Box::pin(async move { Err(Error::not_found(format!("no stream {service}.{method}"))) })
        }

        fn entities_text<'a>(
            &'a self,
            _principal: &'a Principal,
            _uris: &'a [&'a str],
        ) -> BoxFuture<'a, Result<EntityTexts>> {
            Box::pin(async move { Ok(EntityTexts { texts: Vec::new() }) })
        }

        fn audit_record<'a>(
            &'a self,
            _principal: &'a Principal,
            _action: &'a str,
            _resource: Option<&'a str>,
            _details: Option<Value>,
        ) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move { Ok(()) })
        }

        fn serve(&self) -> BoxFuture<'_, Result<()>> {
            Box::pin(async move { Ok(()) })
        }
    }

    struct FakeHttp;

    impl Transport for FakeHttp {
        fn send<'a>(
            &'a self,
            request: TransportRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = std::result::Result<TransportResponse, TransportError>> + Send + 'a>,
        > {
            Box::pin(async move {
                assert!(
                    request
                        .headers
                        .iter()
                        .any(|(k, v)| k == "authorization" && v == "Bearer sk-fake-secret")
                );
                let sse = concat!(
                    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
                    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"content\":\"Crow\"}}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                    "data: [DONE]\n\n"
                );
                Ok(TransportResponse::from_bytes(
                    200,
                    vec![("content-type".into(), "text/event-stream".into())],
                    sse,
                ))
            })
        }
    }

    #[tokio::test]
    async fn resolves_streams_generation_and_records_usage_against_fake_backend() {
        let backend = Arc::new(FakeBackend::new());
        let client = Client::from_backend(backend.clone(), "ai.router");
        let router = Router::with_transport(client, SharedTransport(Arc::new(FakeHttp)));
        let ctx = Ctx::new(
            backend.clone(),
            Principal {
                kind: PrincipalKind::User,
                id: "u1".into(),
            },
            Some(User {
                id: "u1".into(),
                name: "Ada".into(),
                email: None,
                admin: false,
            }),
            None,
        );

        let mut deltas = String::new();
        let out = router
            .generate(
                &ctx,
                GenerateParams {
                    task: Task::Text,
                    prompt: Some("hi".into()),
                    plugin: Some("notes".into()),
                    ..Default::default()
                },
                &CancellationToken::new(),
                |chunk| deltas.push_str(chunk),
            )
            .await
            .expect("generate succeeds");

        assert_eq!(deltas, "Hello Crow");
        assert_eq!(out.text, "Hello Crow");
        assert_eq!(out.provider, "openai-compatible");
        assert_eq!(out.usage.input_tokens, Some(5));
        assert_eq!(out.usage.output_tokens, Some(2));

        let usage = backend.usage.lock().unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0]["plugin"], "notes");
        assert_eq!(usage[0]["ok"], true);
    }
}
