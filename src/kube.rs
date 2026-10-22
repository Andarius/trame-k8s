// kubectl I/O: one `get` per context, and the contexts the local kubeconfig knows.
use super::{model::ClusterView, parse::parse_cluster};
use crate::plugins::api::blocking;
use serde_json::Value;
use std::{process::Stdio, time::Duration};

const KINDS: &str =
    "deployments,statefulsets,daemonsets,cronjobs,jobs,pods,services,ingresses,nodes";
const ROUTES: &str = "httproutes.gateway.networking.k8s.io";
const METRICS: &str = "pods.metrics.k8s.io";
const TIMEOUT: Duration = Duration::from_secs(30);

// the last stderr line, or the exit status when kubectl said nothing
fn failure(stderr: &[u8], status: std::process::ExitStatus) -> String {
    let err = String::from_utf8_lossy(stderr);
    let last: String = err
        .trim()
        .lines()
        .last()
        .unwrap_or("")
        .chars()
        .take(300)
        .collect();
    if last.is_empty() {
        status
            .code()
            .map_or_else(|| format!("exit {status}"), |c| format!("exit {c}"))
    } else {
        last
    }
}

async fn run(argv: &[&str]) -> Result<Vec<u8>, String> {
    let child = tokio::process::Command::new(argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot run {}: {e}", argv[0]))?;
    // dropping the timed-out future kills the child
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{} timed out after {}s", argv[0], TIMEOUT.as_secs()))?
        .map_err(|e| format!("{}: {e}", argv[0]))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(failure(&out.stderr, out.status))
    }
}

pub async fn list_contexts(kubectl: &str) -> Result<Vec<String>, String> {
    let out = run(&[kubectl, "config", "get-contexts", "-o", "name"]).await?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect())
}

async fn get(kubectl: &str, context: &str, kinds: &str) -> Result<Vec<u8>, String> {
    let ctx = format!("--context={context}");
    run(&[
        kubectl,
        &ctx,
        "get",
        kinds,
        "--all-namespaces",
        "-o",
        "json",
        "--request-timeout=20s",
    ])
    .await
}

fn items(bytes: &[u8]) -> Result<Vec<Value>, String> {
    let mut list: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("kubectl output: {e}"))?;
    Ok(match list["items"].take() {
        Value::Array(items) => items,
        _ => Vec::new(),
    })
}

pub async fn fetch_cluster(kubectl: &str, context: &str) -> Result<ClusterView, String> {
    // separate calls: a cluster without the Gateway API CRDs or metrics-server fails them, and that must not fail the poll
    let (core, routes, metrics) = tokio::join!(
        get(kubectl, context, KINDS),
        get(kubectl, context, ROUTES),
        get(kubectl, context, METRICS),
    );
    let core = core?;
    let context = context.to_owned();
    // parsing a large cluster is CPU work: keep it off the async workers
    blocking(move || {
        let mut all = items(&core)?;
        for extra in [routes, metrics].into_iter().flatten() {
            all.extend(items(&extra).unwrap_or_default());
        }
        let polled_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(parse_cluster(&context, &all, &polled_at))
    })
    .await
    .map_err(|e| format!("parse: {e}"))?
}
