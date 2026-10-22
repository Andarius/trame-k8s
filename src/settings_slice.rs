// The plugin's settings slice: what may be saved, and how logos and groups resolve from it.
use super::model::{Snapshot, Workload, image_icon, is_slug, matches_key, provider_icon};
use serde_json::{Map, Value, json};

const MAX_LOGOS: usize = 300;
const MAX_GROUPS: usize = 50;
const MAX_PATTERNS: usize = 100;
const ROUTE: &str = "/api/plugins/k8s";

#[derive(Clone, Debug, PartialEq)]
pub struct K8sSettings {
    pub contexts: Vec<String>, // kube contexts to poll; empty polls nothing
    pub poll_seconds: u64,
    pub kubectl: String,
    pub auto_logos: bool,                   // guess logos from image names
    pub logos: Vec<(String, String)>,       // key or pattern → slug or https URL, in written order
    pub groups: Vec<(String, Vec<String>)>, // group → patterns shaped like logo keys
}

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

// passed to kubectl as one argv entry; the leading-dash ban keeps a name from reading as a flag
fn is_context(v: &str) -> bool {
    let ok = |c: u8| word(c) || b".@:/".contains(&c);
    let b = v.as_bytes();
    (1..=253).contains(&b.len()) && ok(b[0]) && b[1..].iter().all(|&c| ok(c) || c == b'-')
}

fn is_kubectl(v: &str) -> bool {
    v == "kubectl"
        || v.strip_prefix('/').is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|c| word(c) || b"./-".contains(&c))
        })
}

// logo keys and group patterns share one shape
fn is_pattern(v: &str) -> bool {
    (1..=300).contains(&v.len()) && v.bytes().all(|c| word(c) || b".@:/*-".contains(&c))
}

fn is_group(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=40).contains(&b.len())
        && word(b[0])
        && b[1..].iter().all(|&c| word(c) || b" .-".contains(&c))
}

pub fn is_https_url(v: &str) -> bool {
    reqwest::Url::parse(v).is_ok_and(|u| u.scheme() == "https")
}

fn dedupe<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        if !out.iter().any(|x| x == v) {
            out.push(v.to_owned());
        }
    }
    out
}

/// Allowlisted patch: fields absent from `raw` are left as they are.
pub fn sanitize(raw: &Value) -> Value {
    let mut out = Map::new();
    if let Some(list) = raw["contexts"].as_array() {
        out.insert(
            "contexts".into(),
            json!(dedupe(
                list.iter()
                    .filter_map(Value::as_str)
                    .filter(|c| is_context(c))
            )),
        );
    }
    if let Some(n) = raw["pollSeconds"].as_f64() {
        #[allow(clippy::cast_possible_truncation, reason = "clamped to 15..=3600")]
        let n = n.round().clamp(15.0, 3600.0) as i64;
        out.insert("pollSeconds".into(), json!(n));
    }
    if let Some(k) = raw["kubectl"].as_str().filter(|k| is_kubectl(k)) {
        out.insert("kubectl".into(), json!(k));
    }
    if let Some(b) = raw["autoLogos"].as_bool() {
        out.insert("autoLogos".into(), json!(b));
    }
    if let Some(logos) = raw["logos"].as_object() {
        let kept: Map<String, Value> = logos
            .iter()
            .filter(|(k, v)| {
                is_pattern(k) && v.as_str().is_some_and(|v| is_slug(v) || is_https_url(v))
            })
            .take(MAX_LOGOS)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        out.insert("logos".into(), Value::Object(kept));
    }
    if let Some(groups) = raw["groups"].as_object() {
        let kept: Map<String, Value> = groups
            .iter()
            .filter(|(g, _)| is_group(g))
            .filter_map(|(g, ps)| {
                let ps = dedupe(
                    ps.as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|p| is_pattern(p)),
                );
                let ps: Vec<String> = ps.into_iter().take(MAX_PATTERNS).collect();
                (!ps.is_empty()).then(|| (g.clone(), json!(ps)))
            })
            .take(MAX_GROUPS)
            .collect();
        out.insert("groups".into(), Value::Object(kept));
    }
    Value::Object(out)
}

/// A stored slice read back with defaults; anything malformed falls back instead of failing the poll.
pub fn read(slice: &Value) -> K8sSettings {
    let s = sanitize(slice);
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    K8sSettings {
        contexts: strings(&s["contexts"]),
        poll_seconds: s["pollSeconds"].as_u64().unwrap_or(60),
        kubectl: s["kubectl"].as_str().unwrap_or("kubectl").to_owned(),
        auto_logos: s["autoLogos"].as_bool().unwrap_or(true),
        logos: s["logos"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect(),
        groups: s["groups"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(g, ps)| (g.clone(), strings(ps)))
            .collect(),
    }
}

// encodeURIComponent
fn encode(v: &str) -> String {
    v.bytes()
        .map(|c| {
            if c.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&c) {
                (c as char).to_string()
            } else {
                format!("%{c:02X}")
            }
        })
        .collect()
}

// a slug is served from the icon cache; a URL only through its settings key, so the proxy fetches nothing else
fn logo_url(key: &str, value: &str) -> String {
    if is_slug(value) {
        format!("{ROUTE}/icon/{value}")
    } else {
        format!("{ROUTE}/logo?key={}", encode(key))
    }
}

impl K8sSettings {
    pub fn logo(&self, key: &str) -> Option<&str> {
        self.logos
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }
}

// an exact key wins over a pattern; patterns apply in their written order
pub fn workload_logo(w: &Workload, s: &K8sSettings) -> Option<String> {
    for k in [
        format!("{}/{}/{}", w.cluster, w.ns, w.name),
        format!("{}/{}", w.ns, w.name),
        w.name.clone(),
    ] {
        if let Some(v) = s.logo(&k) {
            return Some(logo_url(&k, v));
        }
    }
    if let Some((k, v)) = s
        .logos
        .iter()
        .find(|(k, _)| k.contains('*') && matches_key(&w.cluster, &w.ns, &w.name, k))
    {
        return Some(logo_url(k, v));
    }
    // the annotation lives in the cluster: a slug only, never a URL the host would fetch
    if let Some(hint) = w.logo_hint.as_deref().filter(|h| is_slug(h)) {
        return Some(format!("{ROUTE}/icon/{hint}"));
    }
    s.auto_logos
        .then(|| image_icon(&w.images))
        .flatten()
        .map(|slug| format!("{ROUTE}/icon/{slug}"))
}

// first group with a matching pattern wins, then the annotation
pub fn workload_group(w: &Workload, s: &K8sSettings) -> Option<String> {
    s.groups
        .iter()
        .find(|(_, ps)| {
            ps.iter()
                .any(|p| matches_key(&w.cluster, &w.ns, &w.name, p))
        })
        .map(|(g, _)| g.clone())
        .or_else(|| w.group_hint.clone().filter(|h| is_group(h)))
}

pub fn with_settings(snap: &Snapshot, s: &K8sSettings) -> Snapshot {
    let mut out = snap.clone();
    for c in &mut out.clusters {
        let auto = if s.auto_logos {
            provider_icon(c.provider.as_deref())
        } else {
            None
        };
        c.logo = match (s.logo(&c.context), auto) {
            (Some(own), _) => Some(logo_url(&c.context, own)),
            (None, Some(slug)) => Some(format!("{ROUTE}/icon/{slug}")),
            (None, None) => None,
        };
        for w in &mut c.workloads {
            w.logo = workload_logo(w, s);
            w.group = workload_group(w, s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::model::Kind;
    use super::*;

    // contexts and the kubectl path become argv entries: nothing may read as a flag or carry arguments
    #[test]
    fn sanitize_allowlists_each_field() {
        let cases = [
            (
                json!({"contexts": ["saas-dev", "admin@k8s-par-prd", "saas-dev"]}),
                json!({"contexts": ["saas-dev", "admin@k8s-par-prd"]}),
            ),
            (
                json!({"contexts": ["--kubeconfig=/tmp/x", "-n", "ok"]}),
                json!({"contexts": ["ok"]}),
            ),
            (json!({"contexts": ["a b"]}), json!({"contexts": []})),
            (json!({"kubectl": "kubectl --kubeconfig=/x"}), json!({})),
            (json!({"kubectl": "./kubectl"}), json!({})),
            (
                json!({"kubectl": "/usr/local/bin/kubectl"}),
                json!({"kubectl": "/usr/local/bin/kubectl"}),
            ),
            (json!({"pollSeconds": 1}), json!({"pollSeconds": 15})),
            (json!({"pollSeconds": 90.6}), json!({"pollSeconds": 91})),
            (json!({"enabled": true, "token": "x"}), json!({})),
            (
                json!({"logos": {"api": "fastapi", "web": "https://cdn.test/web.svg", "bad": "http://cdn.test/x.svg", "evil": "file:///etc/passwd", "a b": "react"}}),
                json!({"logos": {"api": "fastapi", "web": "https://cdn.test/web.svg"}}),
            ),
            (
                json!({"groups": {"ai": ["langfuse*", "a b", "llm-*", "llm-*"], "-x": ["web"], "empty": ["?"], "data": "pg"}}),
                json!({"groups": {"ai": ["langfuse*", "llm-*"]}}),
            ),
        ];
        for (raw, want) in cases {
            assert_eq!(sanitize(&raw), want, "{raw}");
        }
    }

    fn w() -> Workload {
        Workload {
            cluster: "dev".into(),
            ns: "app".into(),
            name: "api".into(),
            kind: Kind::Deployment,
            desired: 1,
            ready: 1,
            images: vec!["reg/api:v1".into()],
            rolled_at: None,
            services: vec![],
            hosts: vec![],
            deps: vec![],
            pods: vec![],
            reason: None,
            restarts: 0,
            failed: false,
            logo_hint: None,
            tech: vec![],
            logo: None,
            group_hint: None,
            group: None,
        }
    }

    #[test]
    fn workload_logo_resolution_order() {
        let images = |i: &str| Workload {
            images: vec![i.into()],
            ..w()
        };
        let hint = |h: &str| Workload {
            logo_hint: Some(h.into()),
            ..w()
        };
        let cases = [
            (
                "most specific override wins",
                w(),
                json!({"api": "react", "app/api": "fastapi", "dev/app/api": "python"}),
                Some("/api/plugins/k8s/icon/python"),
            ),
            (
                "URL override goes through its key",
                w(),
                json!({"api": "https://cdn.test/a.svg"}),
                Some("/api/plugins/k8s/logo?key=api"),
            ),
            (
                "pattern with as many segments",
                w(),
                json!({"app/a*": "https://cdn.test/a.svg"}),
                Some("/api/plugins/k8s/logo?key=app%2Fa*"),
            ),
            (
                "pattern in another namespace",
                w(),
                json!({"other/*": "react"}),
                None,
            ),
            (
                "exact key wins over an earlier pattern",
                w(),
                json!({"a*": "react", "api": "fastapi"}),
                Some("/api/plugins/k8s/icon/fastapi"),
            ),
            (
                "annotation slug",
                hint("fastapi"),
                json!({}),
                Some("/api/plugins/k8s/icon/fastapi"),
            ),
            (
                "annotation URL ignored",
                hint("https://evil.test/x.svg"),
                json!({}),
                None,
            ),
            (
                "guessed from the image",
                images("ghcr.io/cloudnative-pg/postgresql:16"),
                json!({}),
                Some("/api/plugins/k8s/icon/postgresql"),
            ),
            (
                "tag does not decide",
                images("reg/backend:postgres-16"),
                json!({}),
                None,
            ),
        ];
        for (id, wl, logos, want) in cases {
            assert_eq!(
                workload_logo(&wl, &read(&json!({"logos": logos}))).as_deref(),
                want,
                "{id}"
            );
        }
    }

    #[test]
    fn workload_group_resolution_order() {
        let at = |cluster: &str, ns: &str, name: &str| Workload {
            cluster: cluster.into(),
            ns: ns.into(),
            name: name.into(),
            ..w()
        };
        let hinted = |name: &str| Workload {
            group_hint: Some("infra".into()),
            ..at("dev", "app", name)
        };
        let cases = [
            (
                "name glob",
                at("dev", "app", "langfuse-web"),
                json!({"ai": ["langfuse*"]}),
                Some("ai"),
            ),
            (
                "glob stays within its segment",
                at("dev", "langfuse", "web"),
                json!({"ai": ["langfuse*"]}),
                None,
            ),
            (
                "whole namespace",
                at("dev", "ml", "trainer"),
                json!({"ai": ["ml/*"]}),
                Some("ai"),
            ),
            (
                "context-scoped pattern",
                at("prod", "app", "api"),
                json!({"core": ["dev/*/api"]}),
                None,
            ),
            (
                "dots are literal",
                at("dev", "app", "llmxapi"),
                json!({"ai": ["llm.api"]}),
                None,
            ),
            (
                "first group wins",
                at("dev", "app", "litellm"),
                json!({"ai": ["litellm"], "proxy": ["lite*"]}),
                Some("ai"),
            ),
            (
                "settings beat the annotation",
                hinted("litellm"),
                json!({"ai": ["litellm"]}),
                Some("ai"),
            ),
            (
                "annotation as fallback",
                hinted("api"),
                json!({}),
                Some("infra"),
            ),
        ];
        for (id, wl, groups, want) in cases {
            assert_eq!(
                workload_group(&wl, &read(&json!({"groups": groups}))).as_deref(),
                want,
                "{id}"
            );
        }
    }
}
