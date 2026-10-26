// Kubernetes plugin: workloads per kube context, polled with the local kubectl.
// Live state is a module-level snapshot fed by the plugin's own loop; nothing reaches the database.
use crate::plugins::api::{Native, Plugin, RouteFuture, json_response, settings};
use axum::{
    body::{Body, Bytes},
    http::Request,
    response::{IntoResponse, Response},
};
use model::{ClusterView, Snapshot, unhealthy};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

mod kube;
mod model;
mod parse;
mod settings_slice;

pub const ID: &str = "k8s";
// keep in step with version.ts (version_test.ts checks it)
const VERSION: &str = "0.2.0";
const REPO: &str = "Getsoren/trame-k8s";
const ICON_CDN: &str = "https://cdn.simpleicons.org";
const MAX_LOGO_BYTES: usize = 512 * 1024;

#[derive(Clone)]
struct Logo {
    body: Bytes,
    content_type: String,
}

static SNAPSHOT: LazyLock<Mutex<Snapshot>> = LazyLock::new(Mutex::default);
// held for the length of a poll: a second caller waits for it instead of polling again
static POLLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LOGOS: LazyLock<Mutex<HashMap<String, Option<Logo>>>> = LazyLock::new(Mutex::default);
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
});
static DARK_FILL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"(?i)fill="#([0-9a-f]{6})""##).unwrap());

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn settings_of(native: &Native) -> settings_slice::K8sSettings {
    settings_slice::read(&settings::plugin(&native.settings, ID))
}

async fn poll(native: &Native) {
    let Ok(_running) = POLLING.try_lock() else {
        drop(POLLING.lock().await);
        return;
    };
    let s = settings_of(native);
    let previous: HashMap<String, ClusterView> = lock(&SNAPSHOT)
        .clusters
        .iter()
        .map(|c| (c.context.clone(), c.clone()))
        .collect();
    let clusters = futures_util::future::join_all(s.contexts.iter().map(|context| {
        let (kubectl, previous) = (&s.kubectl, &previous);
        async move {
            match kube::fetch_cluster(kubectl, context).await {
                Ok(cluster) => cluster,
                // keep the last good state on screen, flagged, rather than blanking a cluster on one bad poll
                Err(error) => match previous.get(context) {
                    Some(last) => ClusterView {
                        error: Some(error),
                        ..last.clone()
                    },
                    None => ClusterView {
                        context: context.clone(),
                        provider: None,
                        error: Some(error),
                        polled_at: None,
                        workloads: Vec::new(),
                        nodes: Vec::new(),
                        logo: None,
                    },
                },
            }
        }
    }))
    .await;
    *lock(&SNAPSHOT) = Snapshot {
        clusters,
        polled_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        configured: !s.contexts.is_empty(),
    };
}

fn state_view(native: &Native) -> Response {
    let view = settings_slice::with_settings(&lock(&SNAPSHOT), &settings_of(native));
    json_response(
        200,
        serde_json::to_value(view).unwrap_or_else(|_| json!({})),
    )
}

async fn fetch_logo(url: &str) -> Option<Logo> {
    let mut res = CLIENT.get(url).send().await.ok()?;
    let content_type = res.headers().get("content-type")?.to_str().ok()?.to_owned();
    if !res.status().is_success() || !content_type.starts_with("image/") {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.ok()? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_LOGO_BYTES {
            return None;
        }
    }
    Some(Logo {
        body: body.into(),
        content_type,
    })
}

// near-black brand colours vanish on the dark canvas: ask the CDN for a light grey instead
fn is_dark(svg: &str) -> bool {
    let Some(hex) = DARK_FILL.captures(svg).map(|c| c[1].to_owned()) else {
        return false;
    };
    let channel = |i: usize| f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)) / 255.0;
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4) < 0.25
}

async fn cached(key: String, fetch: impl Future<Output = Option<Logo>>) -> Option<Logo> {
    if let Some(hit) = lock(&LOGOS).get(&key) {
        return hit.clone();
    }
    let got = fetch.await;
    lock(&LOGOS).insert(key, got.clone());
    got
}

async fn icon(slug: &str) -> Option<Logo> {
    cached(format!("icon:{slug}"), async {
        let got = fetch_logo(&format!("{ICON_CDN}/{slug}")).await?;
        if is_dark(&String::from_utf8_lossy(&got.body)) {
            return Some(
                fetch_logo(&format!("{ICON_CDN}/{slug}/a9b2c3"))
                    .await
                    .unwrap_or(got),
            );
        }
        Some(got)
    })
    .await
}

fn image(got: Option<Logo>) -> Response {
    match got {
        Some(logo) => (
            [
                ("content-type", logo.content_type),
                ("cache-control", "max-age=86400".to_owned()),
            ],
            logo.body,
        )
            .into_response(),
        None => json_response(404, json!({"error": "no logo"})),
    }
}

fn query_param(req: &Request<Body>, name: &str) -> String {
    let query = req.uri().query().unwrap_or("");
    reqwest::Url::parse(&format!("http://local/?{query}"))
        .ok()
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        })
        .unwrap_or_default()
}

pub struct K8s;
pub static PLUGIN: K8s = K8s;

impl Plugin for K8s {
    fn id(&self) -> &'static str {
        ID
    }
    fn label(&self) -> &'static str {
        "Kubernetes"
    }
    fn glyph(&self) -> &'static str {
        "⎈"
    }
    fn description(&self) -> &'static str {
        "Workloads per cluster, from your kubeconfig contexts"
    }
    fn version(&self) -> Option<(&'static str, &'static str)> {
        Some((VERSION, REPO))
    }
    fn badge(&self, _slice: &Value) -> Option<u64> {
        let n = lock(&SNAPSHOT)
            .clusters
            .iter()
            .flat_map(|c| &c.workloads)
            .filter(|w| unhealthy(w))
            .count();
        (n > 0).then_some(n as u64)
    }
    fn ungated(&self, sub: &str) -> bool {
        sub == "/contexts"
    }
    // no secrets in this slice: the default settings_view echoes it as the TypeScript host did
    fn sanitize(&self, raw: &Value, _current: &Value) -> Value {
        settings_slice::sanitize(raw)
    }
    fn start(&'static self, native: Native) -> Option<tokio::task::JoinHandle<()>> {
        Some(tokio::spawn(async move {
            loop {
                if settings::plugin(&native.settings, ID)["enabled"] == true {
                    poll(&native).await;
                }
                tokio::time::sleep(Duration::from_secs(settings_of(&native).poll_seconds)).await;
            }
        }))
    }
    fn on_enabled(&'static self, native: &Native) {
        let native = native.clone();
        tokio::spawn(async move { poll(&native).await });
    }
    fn route(&'static self, native: Native, sub: String, req: Request<Body>) -> RouteFuture {
        Box::pin(async move {
            let get = req.method() == "GET";
            match (sub.as_str(), req.method().as_str()) {
                ("/state", "GET") => state_view(&native),
                ("/refresh", "POST") => {
                    poll(&native).await;
                    state_view(&native)
                }
                ("/contexts", "GET") => {
                    match kube::list_contexts(&settings_of(&native).kubectl).await {
                        Ok(contexts) => json_response(200, json!({"contexts": contexts})),
                        Err(error) => json_response(200, json!({"contexts": [], "error": error})),
                    }
                }
                ("/logo", "GET") => {
                    let key = query_param(&req, "key");
                    let target = settings_of(&native).logo(&key).map(str::to_owned);
                    match target.filter(|t| settings_slice::is_https_url(t)) {
                        Some(target) => {
                            image(cached(format!("url:{target}"), fetch_logo(&target)).await)
                        }
                        None => json_response(404, json!({"error": "no logo"})),
                    }
                }
                (path, _) => match path
                    .strip_prefix("/icon/")
                    .filter(|s| get && !s.is_empty() && !s.contains('/'))
                {
                    Some(slug) if model::is_slug(slug) => image(icon(slug).await),
                    Some(_) => json_response(400, json!({"error": "bad slug"})),
                    None => json_response(404, json!({"error": "not found"})),
                },
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_fills_ask_for_the_grey_variant() {
        for (svg, want) in [
            (r##"<svg fill="#000000"/>"##, true),
            (r##"<svg FILL="#1A1A1A"/>"##, true),
            (r##"<svg fill="#4169E1"/>"##, false),
            (r#"<svg fill="red"/>"#, false),
        ] {
            assert_eq!(is_dark(svg), want, "{svg}");
        }
    }
}
