//! The HTTP transport of the built-in provider: `reqwest` behind `models::Transport`, streaming bodies
//! chunk by chunk, so that dropping a request drops the connection to the model API.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;

use crate::models::{HttpMethod, Transport, TransportError, TransportRequest, TransportResponse};

#[derive(Clone)]
pub struct ReqwestTransport {
    http: reqwest::Client,
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("crow-ai/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("an HTTP client");
        Self { http }
    }
}

impl Transport for ReqwestTransport {
    fn send<'a>(
        &'a self,
        request: TransportRequest,
    ) -> Pin<Box<dyn Future<Output = Result<TransportResponse, TransportError>> + Send + 'a>> {
        Box::pin(async move {
            let method = match request.method {
                HttpMethod::Get => reqwest::Method::GET,
                HttpMethod::Post => reqwest::Method::POST,
            };
            let mut builder = self.http.request(method, &request.url);
            for (k, v) in &request.headers {
                builder = builder.header(k, v);
            }
            if !request.body.is_empty() {
                builder = builder.body(request.body);
            }
            let resp = builder.send().await.map_err(map_error)?;
            let status = resp.status().as_u16();
            let headers = resp
                .headers()
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|val| (k.as_str().to_string(), val.to_string()))
                })
                .collect();
            let stream = resp.bytes_stream().map(|item| item.map_err(map_error));
            Ok(TransportResponse {
                status,
                headers,
                body: Box::pin(stream),
            })
        })
    }
}

/// Shared dynamic HTTP transport so `Router` uses `ReqwestTransport` in production and fakes in tests.
#[derive(Clone)]
pub struct SharedTransport(pub Arc<dyn Transport>);

impl Default for SharedTransport {
    fn default() -> Self {
        Self(Arc::new(ReqwestTransport::default()))
    }
}

impl Transport for SharedTransport {
    fn send<'a>(
        &'a self,
        request: TransportRequest,
    ) -> Pin<Box<dyn Future<Output = Result<TransportResponse, TransportError>> + Send + 'a>> {
        self.0.send(request)
    }
}

fn map_error(e: reqwest::Error) -> TransportError {
    if e.is_timeout() {
        TransportError::Timeout
    } else {
        TransportError::other(e.to_string())
    }
}
