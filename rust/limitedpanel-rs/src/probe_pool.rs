use anyhow::{Context, Result};
use clap::Args as ClapArgs;
use reqwest::{Client, Proxy};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Semaphore;
use tokio::time::Instant;

#[derive(ClapArgs, Debug, Clone)]
pub struct Args {
  /// Proxy URLs list (comma/space/semicolon separated), e.g. http://127.0.0.1:17890,http://127.0.0.1:17891
  #[arg(long)]
  pub proxy_urls: Option<String>,

  /// Read proxy URLs from stdin (one URL per line).
  #[arg(long, default_value_t = false)]
  pub stdin: bool,

  /// Test URL (must return JSON for a usable proxy).
  #[arg(long, default_value = "https://enka.network/api/uid/100000001")]
  pub test_url: String,

  /// Request timeout (ms).
  #[arg(long, default_value_t = 8_000)]
  pub timeout_ms: u64,

  /// Max concurrent probes.
  #[arg(long, default_value_t = 20)]
  pub concurrency: usize,

  /// User-Agent header.
  #[arg(long)]
  pub user_agent: Option<String>,

  /// Accept header.
  #[arg(long, default_value = "application/json")]
  pub accept: String,

  /// Limit response body size (bytes) to avoid huge allocations.
  #[arg(long, default_value_t = 65_536)]
  pub max_body_bytes: usize,
}

#[derive(Serialize)]
struct ProbeOut {
  #[serde(rename = "proxyUrl")]
  proxy_url: String,
  ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  status: Option<u16>,
  ms: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<String>,
}

fn split_list(s: &str) -> Vec<String> {
  s.split(|c: char| c == ',' || c == ';' || c.is_whitespace())
    .map(|x| x.trim())
    .filter(|x| !x.is_empty())
    .map(|x| x.to_string())
    .collect()
}

async fn read_proxy_urls(args: &Args) -> Result<Vec<String>> {
  let mut out: Vec<String> = Vec::new();

  if args.stdin {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    while let Some(line) = lines.next_line().await? {
      let s = line.trim();
      if s.is_empty() {
        continue;
      }
      out.push(s.to_string());
    }
  }

  if let Some(list) = &args.proxy_urls {
    out.extend(split_list(list));
  }

  // Dedup while keeping order.
  let mut seen = std::collections::HashSet::new();
  out.retain(|p| seen.insert(p.clone()));

  Ok(out)
}

async fn probe_one(proxy_url: String, args: Args) -> ProbeOut {
  let t0 = Instant::now();

  let timeout = Duration::from_millis(args.timeout_ms);
  let proxy = match Proxy::all(&proxy_url) {
    Ok(p) => p,
    Err(e) => {
      return ProbeOut {
        proxy_url,
        ok: false,
        status: None,
        ms: t0.elapsed().as_millis() as u64,
        error: Some(format!("invalid proxy url: {e}")),
      }
    }
  };

  let mut builder = Client::builder().proxy(proxy).timeout(timeout);
  if let Some(ua) = &args.user_agent {
    builder = builder.user_agent(ua.clone());
  }

  let client = match builder.build() {
    Ok(c) => c,
    Err(e) => {
      return ProbeOut {
        proxy_url,
        ok: false,
        status: None,
        ms: t0.elapsed().as_millis() as u64,
        error: Some(format!("client build failed: {e}")),
      }
    }
  };

  let resp = match client
    .get(&args.test_url)
    .header("accept", args.accept)
    .send()
    .await
  {
    Ok(r) => r,
    Err(e) => {
      return ProbeOut {
        proxy_url,
        ok: false,
        status: None,
        ms: t0.elapsed().as_millis() as u64,
        error: Some(e.to_string()),
      }
    }
  };

  let status = resp.status().as_u16();
  let bytes = match resp.bytes().await {
    Ok(b) => b,
    Err(e) => {
      return ProbeOut {
        proxy_url,
        ok: false,
        status: Some(status),
        ms: t0.elapsed().as_millis() as u64,
        error: Some(e.to_string()),
      }
    }
  };

  let slice = if bytes.len() > args.max_body_bytes {
    &bytes[..args.max_body_bytes]
  } else {
    &bytes[..]
  };

  let body = String::from_utf8_lossy(slice).trim().to_string();
  let is_html = body.starts_with('<');
  let is_json = body.starts_with('{') || body.starts_with('[');
  let ok_status = matches!(status, 200 | 400 | 403 | 404 | 424);
  let ok = !is_html && is_json && ok_status;

  ProbeOut {
    proxy_url,
    ok,
    status: Some(status),
    ms: t0.elapsed().as_millis() as u64,
    error: None,
  }
}

pub async fn run(args: Args) -> Result<()> {
  let proxies = read_proxy_urls(&args)
    .await
    .context("read proxy urls")?;

  if proxies.is_empty() {
    return Ok(());
  }

  let sem = Arc::new(Semaphore::new(std::cmp::max(1, args.concurrency)));
  let mut handles = Vec::with_capacity(proxies.len());

  for proxy_url in proxies {
    let sem = sem.clone();
    let args2 = args.clone();
    handles.push(tokio::spawn(async move {
      let _permit = sem.acquire_owned().await.expect("semaphore closed");
      probe_one(proxy_url, args2).await
    }));
  }

  for h in handles {
    if let Ok(out) = h.await {
      if let Ok(line) = serde_json::to_string(&out) {
        println!("{line}");
      }
    }
  }

  Ok(())
}
