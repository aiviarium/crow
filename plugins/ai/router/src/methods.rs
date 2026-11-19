//! The methods of the `router` service, as declared in `../rookery/methods.json`.

use std::sync::Arc;

use base64::Engine;
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::budget::Limits as Budget;
use crate::conn::Conn;
use crate::models::{CancellationToken, MAX_AUDIO};
use crate::provider::{self, Provider};
use crate::router::{Router, caller_of, fmt_time, request_id, require_admin};
use crate::rules::{self, Caller};
use crate::sdk::{Chunks, Ctx, Error, Level, Query, Result, Rookery, field};
use crate::types::{
    DictateAudioParams, DictateAudioResult, DictateParams, GenerateParams, Generated, Limit, Limits,
    LimitsInfo, LimitsInfoUsersItem, Mapping, MappingInfo, MappingsParams, MappingsResult, ModelsParams,
    ModelsResult, ProvidersResult, RemoveMappingParams, RemoveMappingResult, Scope, SetLimitsParams,
    SetMappingParams, Task, TaskInfo, TasksParams, TasksResult, TestParams, TestResult, TranscribeParams,
    Transcribed, UsageParams, UsageParamsBy, UsageResult,
};

/// Registers every method and returns the router, for the provider watcher.
pub fn register(rk: &Rookery) -> Arc<Router> {
    let router = Router::new((**rk).clone());

    let r = router.clone();
    rk.method("tasks", move |ctx: Ctx, p: TasksParams| {
        let r = r.clone();
        async move { tasks(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.stream_method(
        "generate",
        move |ctx: Ctx, p: GenerateParams, out: Chunks<Value>| {
            let r = r.clone();
            async move { generate_stream(&r, &ctx, p, out).await }
        },
    );

    let r = router.clone();
    rk.method("complete", move |ctx: Ctx, p: GenerateParams| {
        let r = r.clone();
        async move { r.generate(&ctx, p, &ctx.cancellation(), |_| {}).await }
    });

    let r = router.clone();
    rk.method("transcribe", move |ctx: Ctx, p: TranscribeParams| {
        let r = r.clone();
        async move { transcribe(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.stream_method(
        "dictate",
        move |ctx: Ctx, p: DictateParams, out: Chunks<Value>| {
            let r = r.clone();
            async move { crate::dictation::dictate(r, ctx, p, out).await }
        },
    );

    let r = router.clone();
    rk.method("dictateAudio", move |ctx: Ctx, p: DictateAudioParams| {
        let r = r.clone();
        async move {
            crate::dictation::add_audio(&r, &ctx, &p.request, p.data.as_deref(), p.end.unwrap_or(false))?;
            Ok(DictateAudioResult::new())
        }
    });

    let r = router.clone();
    rk.method("mappings", move |ctx: Ctx, p: MappingsParams| {
        let r = r.clone();
        async move { mappings(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.method("setMapping", move |ctx: Ctx, p: SetMappingParams| {
        let r = r.clone();
        async move { set_mapping(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.method("removeMapping", move |ctx: Ctx, p: RemoveMappingParams| {
        let r = r.clone();
        async move { remove_mapping(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.method("providers", move |_ctx: Ctx, _p: Value| {
        let r = r.clone();
        async move {
            let providers = r.providers().await?;
            Ok(ProvidersResult {
                providers: providers.iter().map(Provider::info).collect(),
            })
        }
    });

    let r = router.clone();
    rk.method("models", move |ctx: Ctx, p: ModelsParams| {
        let r = r.clone();
        async move {
            Ok(ModelsResult {
                models: r.models(&ctx, p).await?,
            })
        }
    });

    let r = router.clone();
    rk.method("usage", move |ctx: Ctx, p: UsageParams| {
        let r = r.clone();
        async move { usage(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.method("limits", move |ctx: Ctx, _p: Value| {
        let r = r.clone();
        async move {
            require_admin(&ctx, "limits")?;
            limits_info(&r, &ctx).await
        }
    });

    let r = router.clone();
    rk.method("setLimits", move |ctx: Ctx, p: SetLimitsParams| {
        let r = r.clone();
        async move { set_limits(&r, &ctx, p).await }
    });

    let r = router.clone();
    rk.method("test", move |_ctx: Ctx, p: TestParams| {
        let r = r.clone();
        async move {
            // Support either Rookery `{ config, credential }` / `{ connection: { config, credential } }`
            // or `{ connection: { values: ... } }` shape.
            let mut values = p
                .connection
                .get("values")
                .or_else(|| p.connection.get("config"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            if let Some(cred) = p.connection.get("credential").and_then(|v| v.as_str())
                && !cred.is_empty()
            {
                values.insert("apiKey".into(), Value::String(cred.to_string()));
            }
            let (ok, message, details) = provider::test_builtin(&r.builtin, &values).await;
            Ok(TestResult { ok, message, details })
        }
    });

    router
}

// ── tasks and generation ─────────────────────────────────────────────────────────────────────────

async fn tasks(r: &Router, ctx: &Ctx, p: TasksParams) -> Result<TasksResult> {
    let caller = caller_of(ctx, p.space.as_deref());
    let mut tasks = Vec::new();
    for task in [Task::Text, Task::Fast, Task::Transcription] {
        tasks.push(match r.resolve(ctx, &caller, task).await? {
            Some(resolved) => resolved.info(),
            None => TaskInfo {
                task,
                available: false,
                scope: None,
                provider: None,
                model: None,
                destination: None,
                live: false,
                detects_language: false,
            },
        });
    }
    Ok(TasksResult { tasks })
}

async fn generate_stream(r: &Router, ctx: &Ctx, p: GenerateParams, out: Chunks<Value>) -> Result<()> {
    let cancel: CancellationToken = ctx.cancellation().child_token();
    let _stop = cancel.clone().drop_guard();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let work = r.generate(ctx, p, &cancel, move |text| {
        let _ = tx.send(text.to_string());
    });
    tokio::pin!(work);
    let done: Generated = loop {
        tokio::select! {
            biased;
            Some(text) = rx.recv() => {
                if out.send(&json!({ "type": "delta", "text": text })).await.is_err() {
                    cancel.cancel();
                    return Err(provider::cancelled());
                }
            }
            result = &mut work => break result?,
        }
    };
    while let Ok(text) = rx.try_recv() {
        out.send(&json!({ "type": "delta", "text": text })).await?;
    }
    out.send(&json!({ "type": "done", "generated": done })).await
}

async fn transcribe(r: &Router, ctx: &Ctx, p: TranscribeParams) -> Result<Transcribed> {
    let request = request_id(p.request.clone())?;
    let audio = base64::engine::general_purpose::STANDARD
        .decode(p.audio.as_bytes())
        .map_err(|e| Error::invalid(format!("audio is not base64: {e}")))?;
    if audio.len() > MAX_AUDIO {
        return Err(Error::invalid(format!(
            "audio is limited to {} MiB per request",
            MAX_AUDIO >> 20
        )));
    }
    let prep = r
        .prepare(ctx, Task::Transcription, p.space.as_deref(), p.plugin.as_deref())
        .await?;
    r.transcribe_clip(
        ctx,
        &prep,
        &request,
        &p.mime,
        p.language.as_deref(),
        &audio,
        None,
        &ctx.cancellation(),
    )
    .await
}

// ── mappings ─────────────────────────────────────────────────────────────────────────────────────

async fn mappings(r: &Router, ctx: &Ctx, p: MappingsParams) -> Result<MappingsResult> {
    let caller = caller_of(ctx, p.space.as_deref());
    let can_view_space = match caller.space {
        Some(space) if !caller.admin => ctx.access().require_space(space, Level::View).await.is_ok(),
        _ => caller.admin,
    };
    let mut q = Query::new().limit(500);
    if let Some(scope) = p.scope {
        q = q.filter(field("scope").eq(scope.as_str()));
    }
    let rows = r.svc.data::<Mapping>().find(q).await?.rows;
    let providers = r.providers().await?;
    let mut out = Vec::new();
    for m in rows.iter().filter(|m| rules::visible(m, &caller, can_view_space)) {
        if let Some(w) = r.wire(ctx, &providers, m).await? {
            out.push(w);
        }
    }
    out.sort_by(|a, b| {
        (a.task.as_str(), a.scope.as_str(), &a.space_id, &a.user_id).cmp(&(
            b.task.as_str(),
            b.scope.as_str(),
            &b.space_id,
            &b.user_id,
        ))
    });
    Ok(MappingsResult { mappings: out })
}

async fn writable(
    ctx: &Ctx,
    scope: Scope,
    space: Option<&str>,
    conn: Option<&Conn>,
) -> Result<rules::Target> {
    let caller = caller_of(ctx, space);
    let facts = conn.map(Conn::facts);
    let target = rules::target(scope, &caller, facts.as_ref())?;
    if let Some(space) = &target.manage_space {
        ctx.access().require_space(space, Level::Manage).await?;
    }
    Ok(target)
}

async fn set_mapping(r: &Router, ctx: &Ctx, p: SetMappingParams) -> Result<MappingInfo> {
    let conn = r
        .connection(ctx, &p.connection)
        .await?
        .ok_or_else(|| Error::not_found("no such connection"))?;
    let model = p.model.trim().to_string();
    if model.is_empty() || model.len() > 200 {
        return Err(Error::invalid(
            "a mapping needs a model name of 1 to 200 characters",
        ));
    }
    let providers = r.providers().await?;
    let provider = provider::for_type(&providers, &conn.kind).ok_or_else(|| {
        Error::invalid(format!(
            "connections of type {} are not a model provider",
            conn.kind
        ))
    })?;
    if !provider.tasks().contains(&p.task) {
        return Err(Error::invalid(format!(
            "provider {} cannot do the {} task",
            provider.id(),
            p.task.as_str()
        )));
    }
    let target = writable(ctx, p.scope, p.space.as_deref(), Some(&conn)).await?;
    let key = rules::key(p.task, p.scope, target.space.as_deref(), target.user.as_deref());
    let mut row = json!({
        "key": key,
        "task": p.task,
        "scope": p.scope,
        "connection": conn.id,
        "model": model,
        "live": p.live.unwrap_or(false),
    });
    if let Some(space) = &target.space {
        row["space"] = json!(space);
    }
    if let Some(user) = &target.user {
        row["user"] = json!(user);
    }
    let stored: Mapping = r.svc.data::<Mapping>().upsert(&row, &["key"]).await?;
    r.forget_settings();
    if p.scope != Scope::User {
        let _ = ctx
            .audit()
            .record(
                "ai.setMapping",
                Some(&conn.uri),
                Some(&json!({ "task": p.task, "scope": p.scope, "model": stored.model, "space": target.space })),
            )
            .await;
    }
    r.wire(ctx, &providers, &stored)
        .await?
        .ok_or_else(|| Error::not_found("the connection is gone"))
}

async fn remove_mapping(r: &Router, ctx: &Ctx, p: RemoveMappingParams) -> Result<RemoveMappingResult> {
    let target = writable(ctx, p.scope, p.space.as_deref(), None).await?;
    let key = rules::key(p.task, p.scope, target.space.as_deref(), target.user.as_deref());
    let data = r.svc.data::<Mapping>();
    let rows = data
        .find(Query::new().filter(field("key").eq(key.as_str())).limit(1))
        .await?
        .rows;
    if let Some(row) = rows.first() {
        data.delete(&row.id).await?;
        r.forget_settings();
        if p.scope != Scope::User {
            let _ = ctx
                .audit()
                .record(
                    "ai.removeMapping",
                    None,
                    Some(&json!({ "task": p.task, "scope": p.scope, "space": target.space })),
                )
                .await;
        }
    }
    Ok(RemoveMappingResult::new())
}

// ── limits and usage ─────────────────────────────────────────────────────────────────────────────

fn wire_limits(l: Budget) -> Limits {
    Limits {
        requests: l.requests.map(|n| n as u64),
        tokens: l.tokens.map(|n| n as u64),
        audio_seconds: l.audio_seconds.map(|n| n as u64),
    }
}

async fn limits_info(r: &Router, ctx: &Ctx) -> Result<LimitsInfo> {
    let rows = r.svc.data::<Limit>().find(Query::new().limit(1000)).await?.rows;
    let mut default = Limits::default();
    let mut users = Vec::new();
    for row in &rows {
        let limits = wire_limits(Budget::from(row));
        if row.user == "default" {
            default = limits;
        } else {
            users.push(LimitsInfoUsersItem {
                user_id: row.user.clone(),
                name: None,
                limits,
            });
        }
    }
    let _ = ctx;
    users.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    Ok(LimitsInfo { default, users })
}

async fn set_limits(r: &Router, ctx: &Ctx, p: SetLimitsParams) -> Result<LimitsInfo> {
    require_admin(ctx, "limits")?;
    let user = p.user.clone().unwrap_or_else(|| "default".into());
    if user.is_empty() || user.len() > 200 {
        return Err(Error::invalid("a user id of 1 to 200 characters"));
    }
    let data = r.svc.data::<Limit>();
    let empty = p.limits.requests.is_none() && p.limits.tokens.is_none() && p.limits.audio_seconds.is_none();
    let existing = data
        .find(Query::new().filter(field("user").eq(user.as_str())).limit(1))
        .await?
        .rows;
    if empty {
        if let Some(row) = existing.first() {
            data.delete(&row.id).await?;
        }
    } else {
        let row = json!({
            "user": user,
            "requests": p.limits.requests,
            "tokens": p.limits.tokens,
            "audioSeconds": p.limits.audio_seconds,
        });
        data.upsert(&row, &["user"]).await?;
    }
    r.forget_settings();
    let _ = ctx
        .audit()
        .record(
            "ai.setLimits",
            None,
            Some(&json!({ "user": user, "limits": p.limits })),
        )
        .await;
    limits_info(r, ctx).await
}

async fn usage(r: &Router, ctx: &Ctx, p: UsageParams) -> Result<UsageResult> {
    require_admin(ctx, "usage")?;
    let days = p.days.unwrap_or(30).clamp(1, 366) as i64;
    let since = OffsetDateTime::now_utc() - time::Duration::days(days);
    let by = match p.by {
        UsageParamsBy::User => "user",
        UsageParamsBy::Plugin => "plugin",
        UsageParamsBy::Task => "task",
        UsageParamsBy::Model => "model",
        UsageParamsBy::Day => "day",
    };
    let mut rows = r.usage_rows(by, since).await?;
    if by == "user" {
        for row in &mut rows {
            if !row.key.is_empty() {
                row.label = None;
            }
        }
    }
    Ok(UsageResult {
        rows,
        since: fmt_time(since),
    })
}

#[allow(dead_code)]
fn unused(_: Caller<'_>) {}
