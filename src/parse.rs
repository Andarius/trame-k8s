// `kubectl get … -A -o json` List items → one cluster's workloads, nodes and their relations.
use super::model::{
    Capacity, ClusterView, Kind, NodeView, PodView, ServiceView, Usage, Workload, tech_of,
};
use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

const LOGO_ANNOTATION: &str = "trame.dev/logo";
const GROUP_ANNOTATION: &str = "trame.dev/group";
const ROLE_LABEL: &str = "node-role.kubernetes.io/";

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn text(v: &Value) -> Option<&str> {
    v.as_str()
}

fn num(v: &Value, fallback: i64) -> i64 {
    v.as_i64().unwrap_or(fallback)
}

fn ns_of(item: &Value) -> &str {
    item["metadata"]["namespace"].as_str().unwrap_or("")
}

fn name_of(item: &Value) -> &str {
    item["metadata"]["name"].as_str().unwrap_or("")
}

fn key(ns: &str, name: &str) -> String {
    format!("{ns}/{name}")
}

fn has_condition(item: &Value, kind: &str) -> bool {
    arr(&item["status"]["conditions"])
        .iter()
        .any(|c| c["type"] == kind && c["status"] == "True")
}

/// Kubernetes resource quantity → millicores (`milli`) or bytes; 0 when unreadable.
pub fn quantity(q: Option<&str>, milli: bool) -> i64 {
    let Some(q) = q.map(str::trim) else { return 0 };
    let split = q
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(q.len());
    let (digits, suffix) = q.split_at(split);
    let base = if let Some(exp) = suffix
        .strip_prefix('e')
        .filter(|e| !e.is_empty() && e.bytes().all(|c| c.is_ascii_digit()))
    {
        10f64.powi(exp.parse().unwrap_or(0))
    } else {
        match suffix {
            "n" => 1e-9,
            "u" => 1e-6,
            "m" => 1e-3,
            "" => 1.0,
            "k" | "K" => 1e3,
            "M" => 1e6,
            "G" => 1e9,
            "T" => 1e12,
            "Ki" => 1024.0,
            "Mi" => 1_048_576.0,
            "Gi" => 1_073_741_824.0,
            "Ti" => 1_099_511_627_776.0,
            _ => return 0,
        }
    };
    let Ok(n) = digits.parse::<f64>() else {
        return 0;
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a rounded quantity fits i64"
    )]
    let out = (n * base * if milli { 1000.0 } else { 1.0 }).round() as i64;
    out
}

fn template(item: &Value) -> &Value {
    if item["kind"] == "CronJob" {
        &item["spec"]["jobTemplate"]["spec"]["template"]
    } else {
        &item["spec"]["template"]
    }
}

fn pod_reason(pod: &Value) -> Option<String> {
    let status = &pod["status"];
    for cs in arr(&status["containerStatuses"]) {
        let waiting = text(&cs["state"]["waiting"]["reason"]).filter(|s| !s.is_empty());
        let last = text(&cs["lastState"]["terminated"]["reason"]).filter(|s| !s.is_empty());
        if let Some(waiting) = waiting.filter(|w| *w != "ContainerCreating") {
            return Some(match last.filter(|l| *l != "Completed") {
                Some(last) => format!("{waiting} · {last}"),
                None => waiting.to_owned(),
            });
        }
    }
    let conditions = arr(&status["conditions"]);
    if let Some(scheduled) = conditions.iter().find(|c| c["type"] == "PodScheduled") {
        if scheduled["status"] == "False" {
            return Some(
                text(&scheduled["message"])
                    .map(|m| m.chars().take(160).collect())
                    .or_else(|| text(&scheduled["reason"]).map(str::to_owned))
                    .unwrap_or_else(|| "Unschedulable".to_owned()),
            );
        }
    }
    (status["phase"] == "Failed").then(|| text(&status["reason"]).unwrap_or("Failed").to_owned())
}

fn requested(containers: &[Value], res: &str, milli: bool) -> i64 {
    containers
        .iter()
        .map(|c| quantity(text(&c["resources"]["requests"][res]), milli))
        .sum()
}

#[derive(Clone, Copy)]
struct PodUsage {
    cpu: i64,
    mem: i64,
}

fn pod_view(pod: &Value, usage: &HashMap<String, PodUsage>) -> PodView {
    let status = &pod["status"];
    let containers = arr(&pod["spec"]["containers"]);
    let used = usage.get(&key(ns_of(pod), name_of(pod)));
    PodView {
        name: name_of(pod).to_owned(),
        node: text(&pod["spec"]["nodeName"]).map(str::to_owned),
        phase: text(&status["phase"]).unwrap_or("Unknown").to_owned(),
        ready: has_condition(pod, "Ready"),
        restarts: arr(&status["containerStatuses"])
            .iter()
            .map(|cs| num(&cs["restartCount"], 0))
            .sum(),
        reason: pod_reason(pod),
        cpu: Usage {
            req: requested(containers, "cpu", true),
            used: used.map(|u| u.cpu),
        },
        mem: Usage {
            req: requested(containers, "memory", false),
            used: used.map(|u| u.mem),
        },
    }
}

// the workload a pod belongs to, through its ReplicaSet or Job when there is one
fn owner_of(pod: &Value, job_owners: &HashMap<String, String>) -> Option<(Kind, String)> {
    for r in arr(&pod["metadata"]["ownerReferences"]) {
        let name = text(&r["name"]).unwrap_or("");
        match text(&r["kind"]).unwrap_or("") {
            "ReplicaSet" => {
                let hash =
                    text(&pod["metadata"]["labels"]["pod-template-hash"]).filter(|h| !h.is_empty());
                let base = hash
                    .and_then(|h| name.strip_suffix(h)?.strip_suffix('-'))
                    .unwrap_or(name);
                return Some((Kind::Deployment, base.to_owned()));
            }
            "StatefulSet" => return Some((Kind::StatefulSet, name.to_owned())),
            "DaemonSet" => return Some((Kind::DaemonSet, name.to_owned())),
            "Job" => {
                return job_owners
                    .get(&key(ns_of(pod), name))
                    .map(|cron| (Kind::CronJob, cron.clone()));
            }
            _ => {}
        }
    }
    None
}

fn selects(selector: &serde_json::Map<String, Value>, labels: &Value) -> bool {
    selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

// matches an env value addressing this Service: `svc`, `svc.ns`, `svc.ns.svc[.cluster.local]`, as a host
fn address_re(svc: &str, svc_ns: &str, same_ns: bool) -> Option<Regex> {
    let host = format!(
        r"{}(\.{}(\.svc(\.cluster\.local)?)?)",
        regex::escape(svc),
        regex::escape(svc_ns)
    );
    Regex::new(&format!(
        r"(^|[/@=,;\s]){host}{}([:/,;\s]|$)",
        if same_ns { "?" } else { "" }
    ))
    .ok()
}

fn newest<'a>(dates: impl Iterator<Item = Option<&'a str>>) -> Option<String> {
    dates
        .flatten()
        .filter(|d| !d.is_empty())
        .max()
        .map(str::to_owned)
}

fn port_label(p: &Value) -> String {
    let port = match &p["port"] {
        Value::String(s) => s.clone(),
        Value::Null => "undefined".to_owned(),
        other => other.to_string(),
    };
    match text(&p["protocol"]).filter(|pr| !pr.is_empty() && *pr != "TCP") {
        Some(pr) => format!("{port}/{pr}"),
        None => port,
    }
}

fn expose(
    workloads: &mut [Workload],
    targets: &HashMap<String, Vec<usize>>,
    hosts: &[&str],
    svc_ns: &str,
    svc: Option<&str>,
) {
    let Some(selected) = svc
        .filter(|s| !s.is_empty())
        .and_then(|s| targets.get(&key(svc_ns, s)))
    else {
        return;
    };
    for &i in selected {
        for h in hosts {
            if !h.is_empty() && !workloads[i].hosts.iter().any(|x| x == h) {
                workloads[i].hosts.push((*h).to_owned());
            }
        }
    }
}

pub fn parse_cluster(context: &str, items: &[Value], polled_at: &str) -> ClusterView {
    let by_kind = |k: &'static str| items.iter().filter(move |i| i["kind"] == k);

    let mut job_owners = HashMap::new();
    let jobs: Vec<&Value> = by_kind("Job").collect();
    for job in &jobs {
        if let Some(cron) = arr(&job["metadata"]["ownerReferences"])
            .iter()
            .find(|r| r["kind"] == "CronJob")
        {
            job_owners.insert(
                key(ns_of(job), name_of(job)),
                text(&cron["name"]).unwrap_or("").to_owned(),
            );
        }
    }

    let pods: Vec<&Value> = by_kind("Pod")
        .filter(|p| p["status"]["phase"] != "Succeeded")
        .collect();
    // metrics-server's PodMetrics, when the API is served
    let mut usage = HashMap::new();
    for m in by_kind("PodMetrics") {
        let cs = arr(&m["containers"]);
        usage.insert(
            key(ns_of(m), name_of(m)),
            PodUsage {
                cpu: cs
                    .iter()
                    .map(|c| quantity(text(&c["usage"]["cpu"]), true))
                    .sum(),
                mem: cs
                    .iter()
                    .map(|c| quantity(text(&c["usage"]["memory"]), false))
                    .sum(),
            },
        );
    }
    let mut pods_of: HashMap<(Kind, String), Vec<&Value>> = HashMap::new();
    for pod in &pods {
        if let Some((kind, owner)) = owner_of(pod, &job_owners) {
            pods_of
                .entry((kind, key(ns_of(pod), &owner)))
                .or_default()
                .push(pod);
        }
    }

    let mut workloads = Vec::new();
    let mut labels_of = Vec::new();
    let mut env_of = Vec::new();
    for item in items {
        let Some(kind) = text(&item["kind"]).and_then(Kind::parse) else {
            continue;
        };
        let ns = ns_of(item);
        let name = name_of(item);
        let (spec, status) = (&item["spec"], &item["status"]);
        let tpl = template(item);
        let own = pods_of
            .get(&(kind, key(ns, name)))
            .map_or(&[][..], Vec::as_slice);
        let views: Vec<PodView> = own.iter().map(|p| pod_view(p, &usage)).collect();
        let created = || {
            own.iter()
                .map(|p| text(&p["metadata"]["creationTimestamp"]))
        };

        let mut failed = false;
        let (desired, ready, rolled_at) = match kind {
            Kind::DaemonSet => (
                num(&status["desiredNumberScheduled"], 0),
                num(&status["numberReady"], 0),
                newest(created()),
            ),
            Kind::CronJob => {
                let active = i64::try_from(arr(&status["active"]).len()).unwrap_or(i64::MAX);
                let desired = if spec["suspend"] == true {
                    0
                } else {
                    active.max(1)
                };
                let mut owned: Vec<&&Value> = jobs
                    .iter()
                    .filter(|j| {
                        job_owners
                            .get(&key(ns, name_of(j)))
                            .is_some_and(|c| c == name)
                    })
                    .collect();
                owned.sort_by(|a, b| {
                    let at = |j: &Value| {
                        text(&j["metadata"]["creationTimestamp"])
                            .unwrap_or("")
                            .to_owned()
                    };
                    at(b).cmp(&at(a))
                });
                failed = owned.first().is_some_and(|last| {
                    num(&last["status"]["failed"], 0) > 0
                        && num(&last["status"]["succeeded"], 0) == 0
                });
                (
                    desired,
                    desired,
                    text(&status["lastScheduleTime"]).map(str::to_owned),
                )
            }
            Kind::Deployment | Kind::StatefulSet => {
                let progressing = arr(&status["conditions"])
                    .iter()
                    .find(|c| c["type"] == "Progressing");
                let rolled = progressing
                    .and_then(|c| text(&c["lastUpdateTime"]))
                    .map(str::to_owned)
                    .or_else(|| newest(created()));
                (
                    num(&spec["replicas"], 1),
                    num(&status["readyReplicas"], 0),
                    rolled,
                )
            }
        };

        let containers = arr(&tpl["spec"]["containers"]);
        let mut images: Vec<String> = Vec::new();
        for image in containers
            .iter()
            .filter_map(|c| text(&c["image"]))
            .filter(|i| !i.is_empty())
        {
            if !images.iter().any(|x| x == image) {
                images.push(image.to_owned());
            }
        }
        let annotation = |k: &str| text(&item["metadata"]["annotations"][k]).map(str::to_owned);
        let logo_hint = annotation(LOGO_ANNOTATION);
        let tech = tech_of(logo_hint.as_deref(), &images);
        workloads.push(Workload {
            cluster: context.to_owned(),
            ns: ns.to_owned(),
            name: name.to_owned(),
            kind,
            desired,
            ready,
            images,
            rolled_at,
            services: Vec::new(),
            hosts: Vec::new(),
            deps: Vec::new(),
            reason: views
                .iter()
                .find(|p| !p.ready && p.reason.as_deref().is_some_and(|r| !r.is_empty()))
                .and_then(|p| p.reason.clone())
                .or_else(|| failed.then(|| "Last job failed".to_owned())),
            restarts: views.iter().map(|p| p.restarts).sum(),
            pods: views,
            failed,
            logo_hint,
            tech,
            logo: None,
            group_hint: annotation(GROUP_ANNOTATION),
            group: None,
        });
        labels_of.push(&tpl["metadata"]["labels"]);
        env_of.push(
            containers
                .iter()
                .flat_map(|c| {
                    arr(&c["env"])
                        .iter()
                        .filter_map(|e| text(&e["value"]))
                        .filter(|v| !v.is_empty())
                })
                .collect::<Vec<_>>(),
        );
    }

    // Service → the workloads it selects
    let mut targets: HashMap<String, Vec<usize>> = HashMap::new();
    let services: Vec<&Value> = by_kind("Service").collect();
    for svc in &services {
        let ns = ns_of(svc);
        let Some(selector) = svc["spec"]["selector"]
            .as_object()
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let view = ServiceView {
            name: name_of(svc).to_owned(),
            kind: text(&svc["spec"]["type"]).unwrap_or("ClusterIP").to_owned(),
            ports: arr(&svc["spec"]["ports"]).iter().map(port_label).collect(),
        };
        let selected: Vec<usize> = (0..workloads.len())
            .filter(|&i| {
                workloads[i].ns == ns
                    && workloads[i].kind != Kind::CronJob
                    && selects(selector, labels_of[i])
            })
            .collect();
        for &i in &selected {
            workloads[i].services.push(view.clone());
        }
        targets.insert(key(ns, name_of(svc)), selected);
    }

    // Ingress host → Service → workloads; a rule-less Ingress (e.g. Tailscale) names its hosts under tls
    for ing in by_kind("Ingress") {
        let ns = ns_of(ing);
        let rules = arr(&ing["spec"]["rules"]);
        let tls_hosts: Vec<&str> = arr(&ing["spec"]["tls"])
            .iter()
            .flat_map(|t| arr(&t["hosts"]).iter().filter_map(Value::as_str))
            .collect();
        let fallback =
            text(&ing["spec"]["defaultBackend"]["service"]["name"]).filter(|s| !s.is_empty());
        for rule in rules {
            let host = text(&rule["host"]).filter(|h| !h.is_empty());
            for path in arr(&rule["http"]["paths"]) {
                let hosts = host.map_or_else(|| tls_hosts.clone(), |h| vec![h]);
                expose(
                    &mut workloads,
                    &targets,
                    &hosts,
                    ns,
                    text(&path["backend"]["service"]["name"]),
                );
            }
        }
        if fallback.is_some() {
            let rule_hosts: Vec<&str> = rules
                .iter()
                .filter_map(|r| text(&r["host"]))
                .filter(|h| !h.is_empty())
                .collect();
            let hosts = if rule_hosts.is_empty() {
                tls_hosts.clone()
            } else {
                rule_hosts
            };
            expose(&mut workloads, &targets, &hosts, ns, fallback);
        }
    }
    // Gateway API: HTTPRoute hostnames → backendRefs (Services, possibly in another namespace)
    for route in by_kind("HTTPRoute") {
        let ns = ns_of(route);
        let hosts: Vec<&str> = arr(&route["spec"]["hostnames"])
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for rule in arr(&route["spec"]["rules"]) {
            for r in arr(&rule["backendRefs"]) {
                if text(&r["kind"]).unwrap_or("Service") == "Service" {
                    expose(
                        &mut workloads,
                        &targets,
                        &hosts,
                        text(&r["namespace"]).unwrap_or(ns),
                        text(&r["name"]),
                    );
                }
            }
        }
    }

    // env values naming a Service → dependency edges
    let mut res: HashMap<(usize, bool), Option<Regex>> = HashMap::new();
    for i in 0..workloads.len() {
        let values = &env_of[i];
        if values.is_empty() {
            continue;
        }
        let mut deps = BTreeSet::new();
        for (s, svc) in services.iter().enumerate() {
            let svc_ns = ns_of(svc);
            let Some(selected) = targets
                .get(&key(svc_ns, name_of(svc)))
                .filter(|t| !t.is_empty())
            else {
                continue;
            };
            let same = svc_ns == workloads[i].ns;
            let re = res
                .entry((s, same))
                .or_insert_with(|| address_re(name_of(svc), svc_ns, same));
            if !re
                .as_ref()
                .is_some_and(|re| values.iter().any(|v| re.is_match(v)))
            {
                continue;
            }
            for &t in selected {
                if t != i {
                    deps.insert(key(&workloads[t].ns, &workloads[t].name));
                }
            }
        }
        workloads[i].deps = deps.into_iter().collect();
    }

    let nodes = by_kind("Node")
        .map(|n| {
            let name = name_of(n);
            let alloc = &n["status"]["allocatable"];
            let on: Vec<&&Value> = pods
                .iter()
                .filter(|p| p["spec"]["nodeName"] == name && p["status"]["phase"] != "Failed")
                .collect();
            let req = |res: &str, milli: bool| {
                on.iter()
                    .map(|p| requested(arr(&p["spec"]["containers"]), res, milli))
                    .sum()
            };
            let used = |pick: fn(PodUsage) -> i64| {
                (!usage.is_empty()).then(|| {
                    on.iter()
                        .map(|p| {
                            usage
                                .get(&key(ns_of(p), name_of(p)))
                                .map_or(0, |u| pick(*u))
                        })
                        .sum()
                })
            };
            let mut roles: Vec<String> = n["metadata"]["labels"]
                .as_object()
                .into_iter()
                .flat_map(|l| l.keys())
                .filter_map(|k| k.strip_prefix(ROLE_LABEL).map(str::to_owned))
                .collect();
            roles.sort();
            NodeView {
                name: name.to_owned(),
                roles,
                ready: has_condition(n, "Ready"),
                cpu: Capacity {
                    alloc: quantity(text(&alloc["cpu"]), true),
                    req: req("cpu", true),
                    used: used(|u| u.cpu),
                },
                mem: Capacity {
                    alloc: quantity(text(&alloc["memory"]), false),
                    req: req("memory", false),
                    used: used(|u| u.mem),
                },
            }
        })
        .collect();
    let provider = by_kind("Node")
        .find_map(|n| text(&n["spec"]["providerID"]).filter(|p| !p.is_empty()))
        .and_then(|p| p.split("://").next())
        .filter(|p| !p.is_empty())
        .map(str::to_owned);

    workloads.sort_by(|a, b| a.ns.cmp(&b.ns).then_with(|| a.name.cmp(&b.name)));
    ClusterView {
        context: context.to_owned(),
        provider,
        error: None,
        polled_at: Some(polled_at.to_owned()),
        workloads,
        nodes,
        logo: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: &str = "2026-10-20T10:00:00Z";

    fn meta(name: &str, ns: &str, extra: &Value) -> Value {
        let mut m = json!({"name": name, "namespace": ns, "creationTimestamp": T});
        m.as_object_mut()
            .unwrap()
            .extend(extra.as_object().cloned().unwrap_or_default());
        m
    }

    fn tpl(app: &str, env: &[(&str, &str)], image: Option<&str>) -> Value {
        let env: Vec<Value> = env
            .iter()
            .map(|(n, v)| json!({"name": n, "value": v}))
            .collect();
        let image = image.map_or_else(|| format!("reg/{app}:v1"), str::to_owned);
        json!({"metadata": {"labels": {"app": app}}, "spec": {"containers": [{"image": image, "env": env, "resources": {"requests": {"cpu": "250m", "memory": "256Mi"}}}]}})
    }

    fn deploy(name: &str, env: &[(&str, &str)], replicas: i64, ready: i64) -> Value {
        json!({"kind": "Deployment", "metadata": meta(name, "app", &json!({})), "spec": {"replicas": replicas, "template": tpl(name, env, None)}, "status": {"readyReplicas": ready}})
    }

    fn service(name: &str, ns: &str) -> Value {
        json!({"kind": "Service", "metadata": meta(name, ns, &json!({})), "spec": {"selector": {"app": name}, "ports": [{"port": 80}]}})
    }

    fn pod(
        name: &str,
        owner: &Value,
        ns: &str,
        node: Option<&str>,
        hash: Option<&str>,
        status: Option<Value>,
    ) -> Value {
        let labels = hash.map_or_else(|| json!({}), |h| json!({"pod-template-hash": h}));
        json!({
            "kind": "Pod",
            "metadata": meta(name, ns, &json!({"ownerReferences": [owner], "labels": labels})),
            "spec": {"nodeName": node, "containers": [{"resources": {"requests": {"cpu": "500m", "memory": "1Gi"}}}]},
            "status": status.unwrap_or_else(|| json!({"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}], "containerStatuses": [{"restartCount": 0}]})),
        })
    }

    fn cluster() -> ClusterView {
        let rs = json!({"kind": "ReplicaSet", "name": "api-7d9f"});
        let items = vec![
            deploy(
                "api",
                &[
                    ("DATABASE_URL", "postgres://u:p@pg.data:5432/db"),
                    ("CACHE", "redis:6379"),
                    ("NOT_A_HOST", "pgx-driver"),
                    ("BROKER", "amqp://myqueue:5672"),
                ],
                2,
                1,
            ),
            json!({"kind": "StatefulSet", "metadata": meta("pg", "data", &json!({})), "spec": {"replicas": 1, "template": tpl("pg", &[], Some("ghcr.io/cloudnative-pg/postgresql:16.4"))}, "status": {"readyReplicas": 1}}),
            deploy("redis", &[], 1, 1),
            deploy("queue", &[], 1, 1),
            service("queue", "app"),
            json!({"kind": "DaemonSet", "metadata": meta("agent", "ops", &json!({})), "spec": {"template": tpl("agent", &[], None)}, "status": {"desiredNumberScheduled": 2, "numberReady": 2}}),
            json!({"kind": "CronJob", "metadata": meta("etl", "app", &json!({})), "spec": {"suspend": false, "jobTemplate": {"spec": {"template": tpl("etl", &[], None)}}}, "status": {"lastScheduleTime": T}}),
            json!({"kind": "Job", "metadata": meta("etl-29000", "app", &json!({"ownerReferences": [{"kind": "CronJob", "name": "etl"}]})), "status": {"failed": 1}}),
            service("api", "app"),
            service("pg", "data"),
            service("redis", "app"),
            json!({"kind": "Ingress", "metadata": meta("api", "app", &json!({})), "spec": {"rules": [{"host": "api.example.com", "http": {"paths": [{"backend": {"service": {"name": "api"}}}]}}]}}),
            json!({"kind": "Ingress", "metadata": meta("api-ts", "app", &json!({})), "spec": {"defaultBackend": {"service": {"name": "api"}}, "tls": [{"hosts": ["api-tailnet"]}]}}),
            json!({"kind": "HTTPRoute", "metadata": meta("pg-route", "gw", &json!({})), "spec": {"hostnames": ["pg.example.com"], "rules": [{"backendRefs": [{"name": "pg", "namespace": "data"}]}]}}),
            pod("api-7d9f-a", &rs, "app", Some("n1"), Some("7d9f"), None),
            pod(
                "api-7d9f-b",
                &rs,
                "app",
                Some("n1"),
                Some("7d9f"),
                Some(
                    json!({"phase": "Running", "conditions": [], "containerStatuses": [{"restartCount": 4, "state": {"waiting": {"reason": "CrashLoopBackOff"}}, "lastState": {"terminated": {"reason": "OOMKilled"}}}]}),
                ),
            ),
            pod(
                "pg-0",
                &json!({"kind": "StatefulSet", "name": "pg"}),
                "data",
                Some("n1"),
                None,
                None,
            ),
            pod(
                "etl-29000-x",
                &json!({"kind": "Job", "name": "etl-29000"}),
                "app",
                None,
                None,
                Some(
                    json!({"phase": "Pending", "conditions": [{"type": "PodScheduled", "status": "False", "message": "0/2 nodes are available: 2 Insufficient cpu."}]}),
                ),
            ),
            json!({"kind": "PodMetrics", "metadata": meta("api-7d9f-a", "app", &json!({})), "containers": [{"name": "api", "usage": {"cpu": "100m", "memory": "200Mi"}}, {"name": "side", "usage": {"cpu": "50m", "memory": "56Mi"}}]}),
            json!({"kind": "Node", "metadata": {"name": "n1", "labels": {"node-role.kubernetes.io/control-plane": "true", "node-role.kubernetes.io/etcd": "true"}}, "spec": {"providerID": "scaleway://instance/fr-par-1/abc"}, "status": {"allocatable": {"cpu": "4", "memory": "8Gi"}, "conditions": [{"type": "Ready", "status": "True"}]}}),
        ];
        parse_cluster("dev", &items, T)
    }

    fn find<'a>(c: &'a ClusterView, ns: &str, name: &str) -> &'a Workload {
        c.workloads
            .iter()
            .find(|w| w.ns == ns && w.name == name)
            .unwrap()
    }

    #[test]
    fn workloads_own_their_pods() {
        let c = cluster();
        let cases = [
            (
                "deployment owns its ReplicaSet pods",
                "app",
                "api",
                Kind::Deployment,
                2,
                1,
                4,
                false,
                Some("CrashLoopBackOff · OOMKilled"),
            ),
            (
                "statefulset",
                "data",
                "pg",
                Kind::StatefulSet,
                1,
                1,
                0,
                false,
                None,
            ),
            (
                "daemonset counts scheduled",
                "ops",
                "agent",
                Kind::DaemonSet,
                2,
                2,
                0,
                false,
                None,
            ),
            (
                "cronjob owns pods through its job; last job failed",
                "app",
                "etl",
                Kind::CronJob,
                1,
                1,
                0,
                true,
                Some("0/2 nodes are available: 2 Insufficient cpu."),
            ),
        ];
        for (id, ns, name, kind, desired, ready, restarts, failed, reason) in cases {
            let w = find(&c, ns, name);
            assert_eq!(
                (
                    w.kind,
                    w.desired,
                    w.ready,
                    w.restarts,
                    w.failed,
                    w.reason.as_deref(),
                    w.logo_hint.as_deref()
                ),
                (kind, desired, ready, restarts, failed, reason, None),
                "{id}"
            );
        }
    }

    #[test]
    fn hosts_come_from_ingresses_and_routes() {
        let c = cluster();
        for (id, ns, name, hosts) in [
            (
                "ingress rule host and rule-less tls host",
                "app",
                "api",
                &["api.example.com", "api-tailnet"][..],
            ),
            (
                "httproute in another namespace",
                "data",
                "pg",
                &["pg.example.com"][..],
            ),
            ("no route", "app", "redis", &[][..]),
        ] {
            assert_eq!(find(&c, ns, name).hosts, hosts, "{id}");
        }
    }

    #[test]
    fn env_values_that_address_a_service_become_deps() {
        assert_eq!(
            find(&cluster(), "app", "api").deps,
            ["app/redis", "data/pg"]
        );
    }

    #[test]
    fn nodes_and_pods_carry_requests_and_usage() {
        let c = cluster();
        assert_eq!(find(&c, "app", "etl").pods[0].node, None);
        let n = &c.nodes[0];
        assert_eq!(
            (n.ready, n.roles.clone()),
            (true, vec!["control-plane".to_owned(), "etcd".to_owned()])
        );
        assert_eq!(
            n.cpu,
            Capacity {
                alloc: 4000,
                req: 1500,
                used: Some(150)
            }
        );
        assert_eq!(
            n.mem,
            Capacity {
                alloc: 8 << 30,
                req: 3 << 30,
                used: Some(256 << 20)
            }
        );
        let pods = &find(&c, "app", "api").pods;
        assert_eq!(
            (&pods[0].cpu, &pods[0].mem),
            (
                &Usage {
                    req: 500,
                    used: Some(150)
                },
                &Usage {
                    req: 1 << 30,
                    used: Some(256 << 20)
                }
            )
        );
        assert_eq!((pods[1].cpu.used, pods[1].mem.used), (None, None));
        assert_eq!(c.provider.as_deref(), Some("scaleway"));
    }

    #[test]
    fn quantity_reads_kubernetes_units() {
        for (q, milli, want) in [
            (Some("250m"), true, 250),
            (Some("4"), true, 4000),
            (Some("0.5"), true, 500),
            (Some("1500000n"), true, 2),
            (Some("512Mi"), false, 512 << 20),
            (Some("1G"), false, 1_000_000_000),
            (Some("1e3"), false, 1000),
            (Some("lots"), false, 0),
            (Some("5Mi5"), false, 0),
            (None, true, 0),
        ] {
            assert_eq!(quantity(q, milli), want, "{q:?}");
        }
    }
}
