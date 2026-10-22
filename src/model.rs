// Snapshot shapes the panel reads (mirrors model.ts), and the matching rules shared with it.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub enum Kind {
    Deployment,
    StatefulSet,
    DaemonSet,
    CronJob,
}

impl Kind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "Deployment" => Some(Self::Deployment),
            "StatefulSet" => Some(Self::StatefulSet),
            "DaemonSet" => Some(Self::DaemonSet),
            "CronJob" => Some(Self::CronJob),
            _ => None,
        }
    }
}

// `use` is null without metrics-server
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Usage {
    pub req: i64,
    #[serde(rename = "use")]
    pub used: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Capacity {
    pub alloc: i64,
    pub req: i64,
    #[serde(rename = "use")]
    pub used: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PodView {
    pub name: String,
    pub node: Option<String>,
    pub phase: String,
    pub ready: bool,
    pub restarts: i64,
    pub reason: Option<String>,
    pub cpu: Usage,
    pub mem: Usage,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ServiceView {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub ports: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workload {
    pub cluster: String,
    pub ns: String,
    pub name: String,
    pub kind: Kind,
    pub desired: i64,
    pub ready: i64,
    pub images: Vec<String>,
    pub rolled_at: Option<String>,
    pub services: Vec<ServiceView>,
    pub hosts: Vec<String>,
    pub deps: Vec<String>,
    pub pods: Vec<PodView>,
    pub reason: Option<String>,
    pub restarts: i64,
    pub failed: bool,
    pub logo_hint: Option<String>,
    pub tech: Vec<String>, // the tool it runs and its kinds, for `tech:`
    pub logo: Option<String>,
    pub group_hint: Option<String>,
    pub group: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodeView {
    pub name: String,
    pub roles: Vec<String>,
    pub ready: bool,
    pub cpu: Capacity,
    pub mem: Capacity,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterView {
    pub context: String,
    pub provider: Option<String>,
    pub error: Option<String>,
    pub polled_at: Option<String>,
    pub workloads: Vec<Workload>,
    pub nodes: Vec<NodeView>,
    pub logo: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub clusters: Vec<ClusterView>,
    pub polled_at: Option<String>,
    pub configured: bool,
}

// health() of model.ts is "deg" or "down"
pub fn unhealthy(w: &Workload) -> bool {
    if w.desired == 0 {
        return false;
    }
    if w.kind == Kind::CronJob {
        return w.failed;
    }
    w.ready < w.desired
}

// image repo → simple-icons slug; first match wins, so specific patterns come first
const IMAGE_ICONS: &[(&[&str], &str)] = &[
    (&["ingress-nginx", "nginx"], "nginx"),
    (&["argoproj", "argocd"], "argo"),
    (
        &["cloudnative-pg", "postgres", "pgbouncer", "timescale"],
        "postgresql",
    ),
    (&["redis", "valkey"], "redis"),
    (&["grafana", "loki", "tempo", "mimir", "alloy"], "grafana"),
    (
        &[
            "prometheus",
            "alertmanager",
            "node-exporter",
            "kube-state-metrics",
        ],
        "prometheus",
    ),
    (&["cert-manager", "jetstack"], "letsencrypt"),
    (&["traefik"], "traefikproxy"),
    (&["rabbitmq"], "rabbitmq"),
    (&["mongo"], "mongodb"),
    (&["mariadb"], "mariadb"),
    (&["mysql"], "mysql"),
    (&["elasticsearch"], "elasticsearch"),
    (&["kibana"], "kibana"),
    (&["minio"], "minio"),
    (&["vault"], "vault"),
    (&["keycloak"], "keycloak"),
    (&["clickhouse"], "clickhouse"),
    (&["temporal"], "temporal"),
    (&["sentry"], "sentry"),
    (&["n8n"], "n8n"),
    (&["metabase"], "metabase"),
    (&["nats"], "natsdotio"),
    (&["kafka"], "apachekafka"),
    (&["qdrant"], "qdrant"),
    (&["meilisearch"], "meilisearch"),
    (&["opentelemetry", "otel"], "opentelemetry"),
    (&["fluent-bit", "fluentbit"], "fluentbit"),
    (&["cilium"], "cilium"),
    (&["istio"], "istio"),
    (&["linkerd"], "linkerd"),
    (
        &[
            "coredns",
            "metrics-server",
            "kube-proxy",
            "registry.k8s.io",
            "k8s.gcr.io",
            "kubectl",
        ],
        "kubernetes",
    ),
];

// the repo part only: a tag like `:postgres-16` must not decide the logo
fn repo_of(image: &str) -> String {
    let image = image.split('@').next().unwrap_or("");
    let last = image.rfind('/').map_or(0, |i| i + 1);
    let image = image[last..]
        .find(':')
        .map_or(image, |i| &image[..last + i]);
    image.to_lowercase()
}

pub fn image_icon(images: &[String]) -> Option<&'static str> {
    images.iter().map(|i| repo_of(i)).find_map(|repo| {
        IMAGE_ICONS
            .iter()
            .find(|(needles, _)| needles.iter().any(|n| repo.contains(n)))
            .map(|(_, slug)| *slug)
    })
}

// simple-icons slug → what kind of tech it is, for `tech:db` and the like
const TECH_KINDS: &[(&str, &[&str])] = &[
    ("postgresql", &["db", "sql"]),
    ("mysql", &["db", "sql"]),
    ("mariadb", &["db", "sql"]),
    ("clickhouse", &["db", "sql"]),
    ("mongodb", &["db", "nosql"]),
    ("redis", &["db", "cache"]),
    ("elasticsearch", &["db", "search"]),
    ("qdrant", &["db", "vector"]),
    ("meilisearch", &["search"]),
    ("minio", &["storage"]),
    ("rabbitmq", &["queue"]),
    ("natsdotio", &["queue"]),
    ("apachekafka", &["queue"]),
    ("grafana", &["monitoring"]),
    ("prometheus", &["monitoring"]),
    ("opentelemetry", &["monitoring"]),
    ("fluentbit", &["monitoring"]),
    ("sentry", &["monitoring"]),
    ("kibana", &["monitoring"]),
    ("nginx", &["proxy"]),
    ("traefikproxy", &["proxy"]),
    ("istio", &["mesh"]),
    ("linkerd", &["mesh"]),
    ("cilium", &["network"]),
    ("argo", &["cd"]),
    ("vault", &["security"]),
    ("keycloak", &["security", "auth"]),
    ("letsencrypt", &["security"]),
    ("temporal", &["workflow"]),
    ("n8n", &["workflow"]),
    ("metabase", &["bi"]),
    ("kubernetes", &["k8s"]),
];

// the tool a workload runs (its annotation, else a guess from its images), then its kinds
pub fn tech_of(logo_hint: Option<&str>, images: &[String]) -> Vec<String> {
    let Some(slug) = logo_hint.or_else(|| image_icon(images)) else {
        return Vec::new();
    };
    let kinds = TECH_KINDS
        .iter()
        .find(|(s, _)| *s == slug)
        .map_or(&[][..], |(_, k)| k);
    std::iter::once(slug)
        .chain(kinds.iter().copied())
        .map(str::to_owned)
        .collect()
}

pub fn provider_icon(provider: Option<&str>) -> Option<&'static str> {
    Some(match provider? {
        "scaleway" => "scaleway",
        "gce" => "googlecloud",
        "hcloud" => "hetzner",
        "ovhcloud" => "ovh",
        "digitalocean" => "digitalocean",
        "k3s" => "k3s",
        "kind" => "kubernetes",
        _ => return None,
    })
}

// `*` matches a run of characters within one `/` segment; everything else is literal
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((b'*', rest)) => {
            let run = text.iter().position(|&c| c == b'/').unwrap_or(text.len());
            (0..=run).any(|i| glob(rest, &text[i..]))
        }
        Some((c, rest)) => text.first() == Some(c) && glob(rest, &text[1..]),
    }
}

// a settings key or pattern (`name`, `ns/name`, `context/ns/name`) against the workload's key with as many segments
pub fn matches_key(cluster: &str, ns: &str, name: &str, pattern: &str) -> bool {
    let key = match pattern.split('/').count() {
        1 => name.to_owned(),
        2 => format!("{ns}/{name}"),
        3 => format!("{cluster}/{ns}/{name}"),
        _ => return false,
    };
    glob(pattern.as_bytes(), key.as_bytes())
}

pub fn is_slug(v: &str) -> bool {
    (1..=60).contains(&v.len())
        && v.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_of_drops_tag_and_digest_only() {
        for (image, want) in [
            ("reg/backend:postgres-16", "reg/backend"),
            ("localhost:5000/Redis", "localhost:5000/redis"),
            ("ghcr.io/x/pg@sha256:abc", "ghcr.io/x/pg"),
        ] {
            assert_eq!(repo_of(image), want, "{image}");
        }
    }

    #[test]
    fn tech_of_prefers_the_annotation_then_adds_kinds() {
        let images = |i: &str| vec![i.to_owned()];
        for (hint, image, want) in [
            (
                None,
                "bitnami/postgresql:16",
                vec!["postgresql", "db", "sql"],
            ),
            (Some("rabbitmq"), "redis:7", vec!["rabbitmq", "queue"]),
            (Some("custom"), "redis:7", vec!["custom"]),
            (None, "reg/api:v1", vec![]),
        ] {
            assert_eq!(tech_of(hint, &images(image)), want, "{image}");
        }
    }

    #[test]
    fn matches_key_keeps_globs_within_a_segment() {
        for (pattern, want) in [
            ("api", true),
            ("a*", true),
            ("app/*", true),
            ("*", true),
            ("dev/*/api", true),
            ("app/a*i", true),
            ("ap", false),
            ("other/*", false),
            ("a/b/c/d", false),
            ("a.i", false),
        ] {
            assert_eq!(matches_key("dev", "app", "api", pattern), want, "{pattern}");
        }
    }
}
