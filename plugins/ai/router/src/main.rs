use ai_router::sdk::Rookery;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("ROOKERY_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let result = async {
        let rk = Rookery::connect().await?;
        let router = ai_router::register(&rk);
        let watcher = router.watch();
        let served = rk.serve().await;
        watcher.abort();
        served
    }
    .await;
    if let Err(e) = result {
        tracing::error!(error = %e, "the ai router stopped");
        std::process::exit(1);
    }
}
