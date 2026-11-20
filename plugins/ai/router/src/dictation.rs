//! Dictation: audio arrives in `dictateAudio` calls (the client cannot stream bytes to a service), the
//! `dictate` stream reads it, shows partial text where the mapping is live, and ends with the whole clip's
//! text. The sessions are in memory on this replica; the audio is dropped when the request ends.

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, mpsc};

use crate::models::{
    self, CancellationToken, LIVE_EVERY, LIVE_MIN_BYTES, MAX_AUDIO, MAX_RECORDING,
    TRANSCRIBE_TIMEOUT, TranscribeIn,
};
use crate::provider;
use crate::router::{Router, request_id};
use crate::sdk::{Chunks, Ctx, Error, Result};
use crate::types::{DictateParams, Task};

/// What `dictateAudio` hands to the reader.
pub enum Piece {
    Data(Vec<u8>),
    End,
}

/// One dictation in progress.
pub struct Dictation {
    /// Who may add audio: the caller that opened it, or that sent the first audio.
    pub owner: String,
    pub tx: mpsc::UnboundedSender<Piece>,
    rx: AsyncMutex<Option<mpsc::UnboundedReceiver<Piece>>>,
    pub created: Instant,
}

impl Router {
    /// The dictation for a request, made on first touch by either call: the audio may arrive before the
    /// stream is read.
    pub fn dictation(&self, request: &str, owner: &str) -> Result<Arc<Dictation>> {
        let mut map = self.dictations.lock().unwrap();
        // A session nobody read and nobody ended does not live forever.
        map.retain(|_, d| d.created.elapsed() < MAX_RECORDING + Duration::from_secs(60));
        if let Some(d) = map.get(request) {
            if d.owner != owner {
                return Err(Error::forbidden("this dictation belongs to someone else"));
            }
            return Ok(d.clone());
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let d = Arc::new(Dictation {
            owner: owner.to_string(),
            tx,
            rx: AsyncMutex::new(Some(rx)),
            created: Instant::now(),
        });
        map.insert(request.to_string(), d.clone());
        Ok(d)
    }

    pub fn end_dictation(&self, request: &str) {
        self.dictations.lock().unwrap().remove(request);
    }
}

pub fn owner_of(ctx: &Ctx) -> String {
    ctx.principal().uri()
}

/// `dictateAudio`.
pub fn add_audio(
    router: &Router,
    ctx: &Ctx,
    request: &str,
    data: Option<&str>,
    end: bool,
) -> Result<()> {
    let d = router.dictation(request, &owner_of(ctx))?;
    if let Some(data) = data.filter(|d| !d.is_empty()) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|e| Error::invalid(format!("data is not base64: {e}")))?;
        d.tx.send(Piece::Data(bytes))
            .map_err(|_| Error::not_found("the dictation has ended"))?;
    }
    if end {
        let _ = d.tx.send(Piece::End);
    }
    Ok(())
}

/// `dictate`: reads the audio until it ends, sends `partial` events where the mapping is live, then the
/// `transcribed` event.
pub async fn dictate(
    router: Arc<Router>,
    ctx: Ctx,
    p: DictateParams,
    out: Chunks<Value>,
) -> Result<()> {
    let request = request_id(Some(p.request.clone()))?;
    let session = router.dictation(&request, &owner_of(&ctx))?;
    let result = run(&router, &ctx, &p, &request, &session, &out).await;
    router.end_dictation(&request);
    result
}

async fn run(
    router: &Arc<Router>,
    ctx: &Ctx,
    p: &DictateParams,
    request: &str,
    session: &Dictation,
    out: &Chunks<Value>,
) -> Result<()> {
    let prep = router
        .prepare(
            ctx,
            Task::Transcription,
            p.space.as_deref(),
            p.plugin.as_deref(),
        )
        .await?;
    let live = prep.resolved.info().live;
    let mut rx = session
        .rx
        .lock()
        .await
        .take()
        .ok_or_else(|| Error::invalid("this dictation is already being read"))?;

    let cancel = CancellationToken::new();
    let _stop = cancel.clone().drop_guard();
    let mut audio: Vec<u8> = Vec::new();
    let mut first: Option<Instant> = None;
    let opened = Instant::now();
    let mut ticker = tokio::time::interval(LIVE_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut partial: Option<tokio::task::JoinHandle<Result<String>>> = None;
    let mut partial_at = 0usize;
    let mut last_partial = String::new();
    let ended = ctx.cancelled();
    tokio::pin!(ended);

    let outcome: Result<()> = loop {
        tokio::select! {
            item = rx.recv() => match item {
                Some(Piece::Data(d)) => {
                    first.get_or_insert_with(Instant::now);
                    if audio.len() + d.len() > MAX_AUDIO {
                        break Err(Error::invalid(format!("audio is limited to {} MiB per request", MAX_AUDIO >> 20)));
                    }
                    audio.extend_from_slice(&d);
                }
                Some(Piece::End) => break Ok(()),
                None => break Err(provider::cancelled()),
            },
            _ = ticker.tick(), if live && partial.is_none() && audio.len() >= partial_at + LIVE_MIN_BYTES => {
                partial_at = audio.len();
                let clip = audio.clone();
                let router = router.clone();
                let ctx = ctx.clone();
                let r = prep.resolved.clone();
                let input = TranscribeIn {
                    request: request.to_string(),
                    model: r.model.clone(),
                    mime: p.mime.clone(),
                    language: models::normalize_language(p.language.as_deref()),
                };
                let cancel = cancel.clone();
                partial = Some(tokio::spawn(async move {
                    provider::transcribe(&ctx, &router.builtin, &r.provider, &r.conn, &input, &clip, TRANSCRIBE_TIMEOUT, &cancel)
                        .await
                        .map(|t| t.text)
                }));
            },
            done = async { partial.as_mut().expect("guarded").await }, if partial.is_some() => {
                partial = None;
                match done {
                    Ok(Ok(text)) if !text.is_empty() && text != last_partial => {
                        last_partial = text.clone();
                        if out.send(&json!({ "type": "partial", "text": text })).await.is_err() {
                            break Err(provider::cancelled());
                        }
                    }
                    Ok(Err(e)) => tracing::debug!(error = %e, "live transcription failed"),
                    _ => {}
                }
            },
            _ = &mut ended => break Err(provider::cancelled()),
            _ = tokio::time::sleep(MAX_RECORDING.saturating_sub(opened.elapsed())) => {
                break Err(Error::invalid(format!("a dictation records at most {} minutes", MAX_RECORDING.as_secs() / 60)));
            }
        }
    };
    if let Some(h) = partial.take() {
        h.abort();
    }
    outcome?;
    let seconds = first.map(|f| f.elapsed().as_secs_f64());
    let heard = router
        .transcribe_clip(
            ctx,
            &prep,
            request,
            &p.mime,
            p.language.as_deref(),
            &audio,
            seconds,
            &cancel,
        )
        .await?;
    drop(audio);
    out.send(&json!({ "type": "transcribed", "transcribed": heard }))
        .await
}
