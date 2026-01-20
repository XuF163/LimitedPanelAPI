use anyhow::Result;
use base64::engine::general_purpose;
use base64::Engine;
use clap::Args as ClapArgs;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use std::collections::{HashMap, HashSet};
use tokio::io::{AsyncReadExt, BufReader};
use url::Url;

#[derive(ClapArgs, Debug, Clone)]
pub struct Args {
  /// Read subscription text from stdin.
  #[arg(long, default_value_t = false)]
  pub stdin: bool,

  /// Subscription text provided directly as an argument. Prefer --stdin for large inputs.
  #[arg(long)]
  pub text: Option<String>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct CanonicalNode {
  #[serde(rename = "type")]
  pub type_: String,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub tag: Option<String>,

  pub host: String,
  pub port: u16,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub password: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub alterId: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub security: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub net: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tls: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sni: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub allowInsecure: Option<bool>,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub encryption: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub flow: Option<String>,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub wsHost: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub wsPath: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub grpcServiceName: Option<String>,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub clash: Option<YamlValue>,
}

fn to_opt_string(s: &str) -> Option<String> {
  let t = s.trim();
  if t.is_empty() {
    None
  } else {
    Some(t.to_string())
  }
}

fn to_bool(v: &str) -> bool {
  let s = v.trim().to_lowercase();
  matches!(s.as_str(), "1" | "true" | "yes" | "y" | "on")
}

fn percent_decode_to_string(s: &str) -> String {
  match percent_decode_str(s).decode_utf8() {
    Ok(cow) => cow.to_string(),
    Err(_) => s.to_string(),
  }
}

fn looks_like_clash_yaml(raw: &str) -> bool {
  for line in raw.lines() {
    let t = line.trim_start();
    if t.starts_with("proxies:") || t.starts_with("proxy-groups:") {
      return true;
    }
  }
  false
}

fn looks_like_base64(text: &str) -> bool {
  let s = text.trim();
  if s.is_empty() {
    return false;
  }
  if s.to_lowercase().starts_with("http://") || s.to_lowercase().starts_with("https://") {
    return false;
  }
  if s.len() < 16 {
    return false;
  }
  for c in s.chars() {
    if c.is_whitespace() {
      continue;
    }
    if c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_') {
      continue;
    }
    return false;
  }
  true
}

fn decode_base64_to_utf8(s: &str) -> Option<String> {
  let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
  if cleaned.is_empty() {
    return None;
  }
  let mut candidates = Vec::with_capacity(2);
  candidates.push(cleaned.clone());
  let rem = cleaned.len() % 4;
  if rem != 0 {
    candidates.push(format!("{cleaned}{}", "=".repeat(4 - rem)));
  }

  for cand in candidates {
    for engine in [&general_purpose::STANDARD, &general_purpose::URL_SAFE] {
      if let Ok(bytes) = engine.decode(&cand) {
        if let Ok(txt) = String::from_utf8(bytes) {
          if !txt.trim().is_empty() {
            return Some(txt);
          }
        }
      }
    }
  }
  None
}

fn node_key(n: &CanonicalNode) -> String {
  let ident = n
    .id
    .as_deref()
    .filter(|s| !s.trim().is_empty())
    .or(n.password.as_deref().filter(|s| !s.trim().is_empty()))
    .or(n.method.as_deref().filter(|s| !s.trim().is_empty()))
    .unwrap_or("");
  format!("{}|{}|{}|{}", n.type_, n.host, n.port, ident)
}

fn dedupe_nodes(nodes: Vec<CanonicalNode>) -> Vec<CanonicalNode> {
  let mut seen = HashSet::<String>::new();
  let mut out = Vec::new();
  for n in nodes {
    let k = node_key(&n);
    if k.is_empty() || seen.contains(&k) {
      continue;
    }
    seen.insert(k);
    out.push(n);
  }
  out
}

fn json_get_str(obj: &JsonValue, key: &str) -> String {
  let v = obj.get(key);
  if let Some(s) = v.and_then(|x| x.as_str()) {
    return s.trim().to_string();
  }
  if let Some(n) = v.and_then(|x| x.as_i64()) {
    return n.to_string();
  }
  if let Some(b) = v.and_then(|x| x.as_bool()) {
    return if b { "true".to_string() } else { "false".to_string() };
  }
  String::new()
}

fn json_get_i64(obj: &JsonValue, key: &str) -> Option<i64> {
  let v = obj.get(key)?;
  if let Some(n) = v.as_i64() {
    return Some(n);
  }
  if let Some(s) = v.as_str() {
    return s.trim().parse::<i64>().ok();
  }
  None
}

fn json_get_u16(obj: &JsonValue, key: &str) -> Option<u16> {
  let v = obj.get(key)?;
  if let Some(n) = v.as_u64() {
    if n <= u16::MAX as u64 {
      return Some(n as u16);
    }
    return None;
  }
  if let Some(n) = v.as_i64() {
    if n > 0 && n <= u16::MAX as i64 {
      return Some(n as u16);
    }
    return None;
  }
  if let Some(s) = v.as_str() {
    if let Ok(n) = s.trim().parse::<u16>() {
      return Some(n);
    }
  }
  None
}

fn parse_vmess_uri(uri: &str) -> Option<CanonicalNode> {
  let raw = uri.trim();
  let b64 = raw.trim_start_matches("vmess://").trim();
  let json_text = decode_base64_to_utf8(b64)?;
  let obj: JsonValue = serde_json::from_str(&json_text).ok()?;

  let host = {
    let add = json_get_str(&obj, "add");
    if !add.is_empty() {
      add
    } else {
      json_get_str(&obj, "host")
    }
  };
  let port = json_get_u16(&obj, "port")?;
  let id = json_get_str(&obj, "id");
  if host.is_empty() || port == 0 || id.is_empty() {
    return None;
  }
  let tag = {
    let ps = json_get_str(&obj, "ps");
    if !ps.is_empty() {
      ps
    } else {
      format!("vmess:{host}:{port}")
    }
  };

  let security = {
    let scy = json_get_str(&obj, "scy");
    if !scy.is_empty() {
      scy
    } else {
      let cipher = json_get_str(&obj, "cipher");
      if !cipher.is_empty() {
        cipher
      } else {
        "auto".to_string()
      }
    }
  };
  let net = {
    let n = json_get_str(&obj, "net");
    if !n.is_empty() {
      n
    } else {
      "tcp".to_string()
    }
  };
  let tls = json_get_str(&obj, "tls");
  let sni = {
    let s = json_get_str(&obj, "sni");
    if !s.is_empty() {
      s
    } else {
      json_get_str(&obj, "serverName")
    }
  };
  let allow_insecure = {
    let keys = ["allowInsecure", "allow_insecure", "skipCertVerify", "skip-cert-verify"];
    let mut v = None;
    for k in keys {
      let s = json_get_str(&obj, k);
      if !s.is_empty() {
        v = Some(to_bool(&s));
        break;
      }
    }
    v
  };
  let ws_host = json_get_str(&obj, "host");
  let ws_path = json_get_str(&obj, "path");

  Some(CanonicalNode {
    type_: "vmess".to_string(),
    tag: Some(tag),
    host,
    port,
    id: Some(id),
    password: None,
    method: None,
    alterId: json_get_i64(&obj, "aid"),
    security: to_opt_string(&security),
    net: to_opt_string(&net),
    tls: to_opt_string(&tls),
    sni: to_opt_string(&sni),
    allowInsecure: allow_insecure,
    encryption: None,
    flow: None,
    wsHost: to_opt_string(&ws_host),
    wsPath: to_opt_string(&ws_path),
    grpcServiceName: None,
    clash: None,
  })
}

#[derive(Debug)]
struct UriCommon {
  type_: String,
  tag: String,
  host: String,
  port: u16,
  user: String,
  _password: String,
  params: HashMap<String, String>,
}

fn parse_uri_common(uri: &str) -> Option<UriCommon> {
  let u = Url::parse(uri).ok()?;
  let type_ = u.scheme().to_lowercase();
  let tag = u
    .fragment()
    .map(percent_decode_to_string)
    .unwrap_or_default()
    .trim()
    .to_string();
  let host = u.host_str().unwrap_or("").trim().to_string();
  let port = u.port().unwrap_or(0);
  let user = percent_decode_to_string(u.username()).trim().to_string();
  let password = u
    .password()
    .map(percent_decode_to_string)
    .unwrap_or_default()
    .trim()
    .to_string();
  let mut params = HashMap::new();
  for (k, v) in u.query_pairs() {
    params.insert(k.to_string(), v.to_string());
  }
  Some(UriCommon {
    type_,
    tag,
    host,
    port,
    user,
    _password: password,
    params,
  })
}

fn parse_vless_uri(uri: &str) -> Option<CanonicalNode> {
  let u = parse_uri_common(uri)?;
  if u.type_ != "vless" {
    return None;
  }
  if u.host.is_empty() || u.port == 0 || u.user.is_empty() {
    return None;
  }
  let net = u
    .params
    .get("type")
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .unwrap_or("tcp")
    .to_string();
  let security = u.params.get("security").map(|s| s.trim()).unwrap_or("").to_string();
  let sni = u
    .params
    .get("sni")
    .or(u.params.get("serverName"))
    .map(|s| s.trim())
    .unwrap_or("")
    .to_string();
  let allow_insecure = u
    .params
    .get("allowInsecure")
    .or(u.params.get("allow_insecure"))
    .or(u.params.get("insecure"))
    .map(|s| to_bool(s));
  let ws_host = u.params.get("host").map(|s| s.trim()).unwrap_or("").to_string();
  let ws_path = u.params.get("path").map(|s| s.trim()).unwrap_or("").to_string();
  let grpc_service_name = u
    .params
    .get("serviceName")
    .map(|s| s.trim())
    .unwrap_or("")
    .to_string();

  let encryption = u
    .params
    .get("encryption")
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .unwrap_or("none")
    .to_string();
  let flow = u.params.get("flow").map(|s| s.trim()).unwrap_or("").to_string();

  Some(CanonicalNode {
    type_: "vless".to_string(),
    tag: Some(if u.tag.is_empty() {
      format!("vless:{}:{}", u.host, u.port)
    } else {
      u.tag
    }),
    host: u.host,
    port: u.port,
    id: Some(u.user),
    password: None,
    method: None,
    alterId: None,
    security: None,
    net: to_opt_string(&net),
    tls: to_opt_string(&security),
    sni: to_opt_string(&sni),
    allowInsecure: allow_insecure,
    encryption: to_opt_string(&encryption),
    flow: to_opt_string(&flow),
    wsHost: to_opt_string(&ws_host),
    wsPath: to_opt_string(&ws_path),
    grpcServiceName: to_opt_string(&grpc_service_name),
    clash: None,
  })
}

fn parse_trojan_uri(uri: &str) -> Option<CanonicalNode> {
  let u = parse_uri_common(uri)?;
  if u.type_ != "trojan" {
    return None;
  }
  if u.host.is_empty() || u.port == 0 || u.user.is_empty() {
    return None;
  }
  let net = u
    .params
    .get("type")
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .unwrap_or("tcp")
    .to_string();
  let security = u
    .params
    .get("security")
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .unwrap_or("tls")
    .to_string();
  let sni = u
    .params
    .get("sni")
    .or(u.params.get("peer"))
    .map(|s| s.trim())
    .unwrap_or("")
    .to_string();
  let allow_insecure = u
    .params
    .get("allowInsecure")
    .or(u.params.get("allow_insecure"))
    .or(u.params.get("insecure"))
    .map(|s| to_bool(s));
  let ws_host = u.params.get("host").map(|s| s.trim()).unwrap_or("").to_string();
  let ws_path = u.params.get("path").map(|s| s.trim()).unwrap_or("").to_string();
  let grpc_service_name = u
    .params
    .get("serviceName")
    .map(|s| s.trim())
    .unwrap_or("")
    .to_string();

  Some(CanonicalNode {
    type_: "trojan".to_string(),
    tag: Some(if u.tag.is_empty() {
      format!("trojan:{}:{}", u.host, u.port)
    } else {
      u.tag
    }),
    host: u.host,
    port: u.port,
    id: None,
    password: Some(u.user),
    method: None,
    alterId: None,
    security: None,
    net: to_opt_string(&net),
    tls: to_opt_string(&security),
    sni: to_opt_string(&sni),
    allowInsecure: allow_insecure,
    encryption: None,
    flow: None,
    wsHost: to_opt_string(&ws_host),
    wsPath: to_opt_string(&ws_path),
    grpcServiceName: to_opt_string(&grpc_service_name),
    clash: None,
  })
}

fn parse_ss_uri(uri: &str) -> Option<CanonicalNode> {
  let raw = uri.trim();
  let no_scheme = raw.trim_start_matches("ss://");
  let mut parts = no_scheme.splitn(2, '#');
  let before_hash = parts.next().unwrap_or("");
  let hash = parts.next().unwrap_or("");
  let tag = percent_decode_to_string(hash).trim().to_string();

  // strip plugin params
  let main = before_hash.split('?').next().unwrap_or("").trim();
  if main.is_empty() {
    return None;
  }

  let (creds_part, host_part) = if let Some((a, b)) = main.split_once('@') {
    (a.to_string(), b.to_string())
  } else {
    let decoded = decode_base64_to_utf8(main)?;
    let (a, b) = decoded.split_once('@')?;
    (a.to_string(), b.to_string())
  };

  let (method, password) = if let Some((m, p)) = creds_part.split_once(':') {
    (m.to_string(), p.to_string())
  } else {
    let decoded = decode_base64_to_utf8(&creds_part)?;
    let (m, p) = decoded.split_once(':')?;
    (m.to_string(), p.to_string())
  };

  let (host, port_raw) = host_part.split_once(':')?;
  let host = host.trim().to_string();
  let port: u16 = port_raw.trim().parse().ok()?;
  if host.is_empty() || port == 0 {
    return None;
  }

  Some(CanonicalNode {
    type_: "ss".to_string(),
    tag: Some(if tag.is_empty() {
      format!("ss:{host}:{port}")
    } else {
      tag
    }),
    host,
    port,
    id: None,
    password: to_opt_string(&password),
    method: to_opt_string(&method),
    alterId: None,
    security: None,
    net: None,
    tls: None,
    sni: None,
    allowInsecure: None,
    encryption: None,
    flow: None,
    wsHost: None,
    wsPath: None,
    grpcServiceName: None,
    clash: None,
  })
}

fn parse_node_from_uri_line(line: &str) -> Option<CanonicalNode> {
  let s = line.trim();
  if s.is_empty() {
    return None;
  }
  let lower = s.to_lowercase();
  if lower.starts_with("vmess://") {
    return parse_vmess_uri(s);
  }
  if lower.starts_with("vless://") {
    return parse_vless_uri(s);
  }
  if lower.starts_with("trojan://") {
    return parse_trojan_uri(s);
  }
  if lower.starts_with("ss://") {
    return parse_ss_uri(s);
  }
  None
}

fn y_map_get<'a>(m: &'a serde_yaml::Mapping, key: &str) -> Option<&'a YamlValue> {
  for (k, v) in m {
    if let Some(ks) = k.as_str() {
      if ks == key {
        return Some(v);
      }
    }
  }
  None
}

fn y_str(v: Option<&YamlValue>) -> String {
  if let Some(x) = v {
    if let Some(s) = x.as_str() {
      return s.trim().to_string();
    }
    if let Some(n) = x.as_i64() {
      return n.to_string();
    }
    if let Some(b) = x.as_bool() {
      return if b { "true".to_string() } else { "false".to_string() };
    }
  }
  String::new()
}

fn y_u16(v: Option<&YamlValue>) -> Option<u16> {
  let x = v?;
  if let Some(n) = x.as_u64() {
    if n <= u16::MAX as u64 {
      return Some(n as u16);
    }
    return None;
  }
  if let Some(n) = x.as_i64() {
    if n > 0 && n <= u16::MAX as i64 {
      return Some(n as u16);
    }
    return None;
  }
  if let Some(s) = x.as_str() {
    return s.trim().parse::<u16>().ok();
  }
  None
}

fn y_bool(v: Option<&YamlValue>) -> Option<bool> {
  let x = v?;
  if let Some(b) = x.as_bool() {
    return Some(b);
  }
  if let Some(n) = x.as_i64() {
    return Some(n != 0);
  }
  if let Some(s) = x.as_str() {
    let t = s.trim();
    if t.is_empty() {
      return None;
    }
    return Some(to_bool(t));
  }
  None
}

fn parse_clash_yaml(text: &str) -> Vec<CanonicalNode> {
  let doc: YamlValue = match serde_yaml::from_str(text) {
    Ok(v) => v,
    Err(_) => return vec![],
  };
  let proxies = match doc.as_mapping().and_then(|m| y_map_get(m, "proxies")).and_then(|v| v.as_sequence())
  {
    Some(seq) => seq,
    None => return vec![],
  };

  let mut out = Vec::new();
  for p in proxies {
    let map = match p.as_mapping() {
      Some(m) => m,
      None => continue,
    };
    let type_raw = y_str(y_map_get(map, "type")).to_lowercase();
    let name = y_str(y_map_get(map, "name"));
    let host = y_str(y_map_get(map, "server"));
    let port = match y_u16(y_map_get(map, "port")) {
      Some(x) => x,
      None => continue,
    };
    if type_raw.is_empty() || host.is_empty() || port == 0 {
      continue;
    }

    let allow_insecure = y_bool(
      y_map_get(map, "skip-cert-verify")
        .or_else(|| y_map_get(map, "skipCertVerify"))
        .or_else(|| y_map_get(map, "allowInsecure")),
    )
    .unwrap_or(false);

    if type_raw == "vmess" {
      let id = y_str(y_map_get(map, "uuid"));
      let alter_id = y_str(y_map_get(map, "alterId")).parse::<i64>().ok().unwrap_or(0);
      let security = {
        let c = y_str(y_map_get(map, "cipher"));
        if c.is_empty() {
          "auto".to_string()
        } else {
          c
        }
      };
      let net = {
        let n = y_str(y_map_get(map, "network"));
        if n.is_empty() {
          "tcp".to_string()
        } else {
          n
        }
      };
      let tls = y_bool(y_map_get(map, "tls")).unwrap_or(false);
      let sni = {
        let s = y_str(y_map_get(map, "servername"));
        if s.is_empty() {
          y_str(y_map_get(map, "sni"))
        } else {
          s
        }
      };
      let ws_host = y_str(
        y_map_get(map, "ws-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "headers"))
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "Host")),
      );
      let ws_path = y_str(
        y_map_get(map, "ws-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "path")),
      );
      out.push(CanonicalNode {
        type_: "vmess".to_string(),
        tag: Some(if name.is_empty() {
          format!("vmess:{host}:{port}")
        } else {
          name
        }),
        host,
        port,
        id: to_opt_string(&id),
        password: None,
        method: None,
        alterId: Some(alter_id),
        security: to_opt_string(&security),
        net: to_opt_string(&net),
        tls: Some(if tls { "tls".to_string() } else { "".to_string() }),
        sni: to_opt_string(&sni),
        allowInsecure: Some(allow_insecure),
        encryption: None,
        flow: None,
        wsHost: to_opt_string(&ws_host),
        wsPath: to_opt_string(&ws_path),
        grpcServiceName: None,
        clash: Some(p.clone()),
      });
      continue;
    }

    if type_raw == "vless" {
      let id = y_str(y_map_get(map, "uuid"));
      let encryption = {
        let e = y_str(y_map_get(map, "encryption"));
        if e.is_empty() {
          "none".to_string()
        } else {
          e
        }
      };
      let flow = y_str(y_map_get(map, "flow"));
      let net = {
        let n = y_str(y_map_get(map, "network"));
        if n.is_empty() {
          "tcp".to_string()
        } else {
          n
        }
      };
      let tls = y_bool(y_map_get(map, "tls")).unwrap_or(false);
      let sni = {
        let s = y_str(y_map_get(map, "servername"));
        if s.is_empty() {
          y_str(y_map_get(map, "sni"))
        } else {
          s
        }
      };
      let ws_host = y_str(
        y_map_get(map, "ws-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "headers"))
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "Host")),
      );
      let ws_path = y_str(
        y_map_get(map, "ws-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "path")),
      );
      let grpc_service_name = y_str(
        y_map_get(map, "grpc-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "grpc-service-name")),
      );
      out.push(CanonicalNode {
        type_: "vless".to_string(),
        tag: Some(if name.is_empty() {
          format!("vless:{host}:{port}")
        } else {
          name
        }),
        host,
        port,
        id: to_opt_string(&id),
        password: None,
        method: None,
        alterId: None,
        security: None,
        net: to_opt_string(&net),
        tls: Some(if tls { "tls".to_string() } else { "".to_string() }),
        sni: to_opt_string(&sni),
        allowInsecure: Some(allow_insecure),
        encryption: to_opt_string(&encryption),
        flow: to_opt_string(&flow),
        wsHost: to_opt_string(&ws_host),
        wsPath: to_opt_string(&ws_path),
        grpcServiceName: to_opt_string(&grpc_service_name),
        clash: Some(p.clone()),
      });
      continue;
    }

    if type_raw == "trojan" {
      let password = y_str(y_map_get(map, "password"));
      let net = {
        let n = y_str(y_map_get(map, "network"));
        if n.is_empty() {
          "tcp".to_string()
        } else {
          n
        }
      };
      let sni = {
        let s = y_str(y_map_get(map, "sni"));
        if s.is_empty() {
          y_str(y_map_get(map, "servername"))
        } else {
          s
        }
      };
      let ws_host = y_str(
        y_map_get(map, "ws-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "headers"))
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "Host")),
      );
      let ws_path = y_str(
        y_map_get(map, "ws-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "path")),
      );
      let grpc_service_name = y_str(
        y_map_get(map, "grpc-opts")
          .and_then(|v| v.as_mapping())
          .and_then(|m| y_map_get(m, "grpc-service-name")),
      );
      out.push(CanonicalNode {
        type_: "trojan".to_string(),
        tag: Some(if name.is_empty() {
          format!("trojan:{host}:{port}")
        } else {
          name
        }),
        host,
        port,
        id: None,
        password: to_opt_string(&password),
        method: None,
        alterId: None,
        security: None,
        net: to_opt_string(&net),
        tls: Some("tls".to_string()),
        sni: to_opt_string(&sni),
        allowInsecure: Some(allow_insecure),
        encryption: None,
        flow: None,
        wsHost: to_opt_string(&ws_host),
        wsPath: to_opt_string(&ws_path),
        grpcServiceName: to_opt_string(&grpc_service_name),
        clash: Some(p.clone()),
      });
      continue;
    }

    if type_raw == "ss" || type_raw == "shadowsocks" {
      let method = y_str(y_map_get(map, "cipher").or_else(|| y_map_get(map, "method")));
      let password = y_str(y_map_get(map, "password"));
      out.push(CanonicalNode {
        type_: "ss".to_string(),
        tag: Some(if name.is_empty() {
          format!("ss:{host}:{port}")
        } else {
          name
        }),
        host,
        port,
        id: None,
        password: to_opt_string(&password),
        method: to_opt_string(&method),
        alterId: None,
        security: None,
        net: None,
        tls: None,
        sni: None,
        allowInsecure: None,
        encryption: None,
        flow: None,
        wsHost: None,
        wsPath: None,
        grpcServiceName: None,
        clash: Some(p.clone()),
      });
      continue;
    }

    if type_raw == "hysteria2" || type_raw == "hy2" {
      let password = y_str(
        y_map_get(map, "password")
          .or_else(|| y_map_get(map, "auth"))
          .or_else(|| y_map_get(map, "auth-str")),
      );
      let tls = y_bool(y_map_get(map, "tls")).unwrap_or(false);
      let sni = {
        let s = y_str(y_map_get(map, "sni"));
        if s.is_empty() {
          y_str(y_map_get(map, "servername"))
        } else {
          s
        }
      };
      out.push(CanonicalNode {
        type_: "hysteria2".to_string(),
        tag: Some(if name.is_empty() {
          format!("hy2:{host}:{port}")
        } else {
          name
        }),
        host,
        port,
        id: None,
        password: to_opt_string(&password),
        method: None,
        alterId: None,
        security: None,
        net: None,
        tls: Some(if tls { "tls".to_string() } else { "".to_string() }),
        sni: to_opt_string(&sni),
        allowInsecure: Some(allow_insecure),
        encryption: None,
        flow: None,
        wsHost: None,
        wsPath: None,
        grpcServiceName: None,
        clash: Some(p.clone()),
      });
      continue;
    }

    if type_raw == "tuic" {
      let id = y_str(y_map_get(map, "uuid"));
      let password = y_str(y_map_get(map, "password"));
      let tls = y_bool(y_map_get(map, "tls")).unwrap_or(false);
      let sni = {
        let s = y_str(y_map_get(map, "sni"));
        if s.is_empty() {
          y_str(y_map_get(map, "servername"))
        } else {
          s
        }
      };
      out.push(CanonicalNode {
        type_: "tuic".to_string(),
        tag: Some(if name.is_empty() {
          format!("tuic:{host}:{port}")
        } else {
          name
        }),
        host,
        port,
        id: to_opt_string(&id),
        password: to_opt_string(&password),
        method: None,
        alterId: None,
        security: None,
        net: None,
        tls: Some(if tls { "tls".to_string() } else { "".to_string() }),
        sni: to_opt_string(&sni),
        allowInsecure: Some(allow_insecure),
        encryption: None,
        flow: None,
        wsHost: None,
        wsPath: None,
        grpcServiceName: None,
        clash: Some(p.clone()),
      });
      continue;
    }
  }
  out
    .into_iter()
    .filter(|n| !n.type_.trim().is_empty() && !n.host.trim().is_empty() && n.port > 0)
    .collect()
}

fn parse_subscription_text(txt: &str) -> Vec<CanonicalNode> {
  let raw = txt.trim();
  if raw.is_empty() {
    return vec![];
  }

  if looks_like_clash_yaml(raw) {
    return dedupe_nodes(parse_clash_yaml(raw));
  }

  let mut body = raw.to_string();
  if !body.contains("://") && looks_like_base64(&body) {
    if let Some(decoded) = decode_base64_to_utf8(&body) {
      body = decoded;
    }
  }

  let mut out = Vec::new();
  for line in body.lines() {
    let s = line.trim();
    if s.is_empty() {
      continue;
    }
    if let Some(node) = parse_node_from_uri_line(s) {
      out.push(node);
    }
  }
  dedupe_nodes(out)
}

pub async fn run(args: Args) -> Result<()> {
  let input = if args.stdin || args.text.is_none() {
    let mut buf = String::new();
    let mut stdin = BufReader::new(tokio::io::stdin());
    stdin.read_to_string(&mut buf).await?;
    buf
  } else {
    args.text.unwrap_or_default()
  };

  let nodes = parse_subscription_text(&input);
  for n in nodes {
    if let Ok(line) = serde_json::to_string(&n) {
      println!("{line}");
    }
  }
  Ok(())
}
