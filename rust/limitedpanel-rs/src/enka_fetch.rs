use anyhow::{anyhow, Context, Result};
use clap::Args as ClapArgs;
use reqwest::{Client, Proxy};
use serde::Serialize;
use std::sync::{
  atomic::{AtomicBool, AtomicUsize, Ordering},
  Arc,
};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, Instant};

#[derive(ClapArgs, Debug, Clone)]
pub struct Args {
  #[arg(long)]
  pub game: String,

  /// Read UIDs from stdin (one UID per line).
  #[arg(long, default_value_t = false)]
  pub uids_stdin: bool,

  /// UID list in a single argument (comma/space separated). Use stdin for large lists.
  #[arg(long)]
  pub uids: Option<String>,

  /// Generate UIDs from a continuous range (uidStart..uidStart+count-1).
  #[arg(long)]
  pub uid_start: Option<u64>,

  /// Number of UIDs in range mode.
  #[arg(long)]
  pub count: Option<u64>,

  /// Enka base URL for gs/sr (default: https://enka.network/).
  #[arg(long)]
  pub base_url: Option<String>,

  /// User-Agent header (default: Chrome-like UA).
  #[arg(long)]
  pub user_agent: Option<String>,

  /// Request timeout (ms).
  #[arg(long, default_value_t = 15_000)]
  pub timeout_ms: u64,

  /// Per-proxy bucket delay (ms). If proxy list is empty, this is ignored unless no_proxy_delay_ms=0.
  #[arg(long, default_value_t = 20_000)]
  pub delay_ms: u64,

  /// Random jitter added to delay (ms, [0, jitter_ms)).
  #[arg(long, default_value_t = 2_000)]
  pub jitter_ms: u64,

  /// Global delay when no proxy is used (ms).
  #[arg(long, default_value_t = 20_000)]
  pub no_proxy_delay_ms: u64,

  /// Maximum concurrency (workers). With proxies, effective concurrency is min(concurrency, proxy_count).
  #[arg(long, default_value_t = 1)]
  pub concurrency: usize,

  /// HTTP proxy URLs list (comma/space/semicolon separated), e.g. http://127.0.0.1:17890,http://127.0.0.1:17891
  #[arg(long)]
  pub proxy_urls: Option<String>,

  /// Disable a proxy after N consecutive transport/HTML failures.
  #[arg(long, default_value_t = 30)]
  pub proxy_max_consecutive_fails: usize,

  /// Circuit breaker (no-proxy mode only): stop after N consecutive failures.
  #[arg(long, default_value_t = 5)]
  pub breaker_max_consecutive_fails: usize,

  /// Circuit breaker (no-proxy mode only): stop immediately on 429.
  #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
  pub breaker_on_429: bool,
}

#[derive(Debug)]
struct ProxyState {
  url: String,
  client: Client,
  disabled: bool,
  consecutive_fails: usize,
  next_at: Instant,
}

#[derive(Serialize)]
struct FetchResult {
  uid: u64,
  ok: bool,
  status: Option<u16>,
  is_html: bool,
  body: Option<String>,
  error: Option<String>,
  ms: u64,
  proxy: Option<String>,
  base: Option<String>,
  retry_after_ms: Option<u64>,
  proxy_disabled: Option<bool>,
}

fn parse_list(raw: &str) -> Vec<String> {
  raw
    .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect()
}

async fn read_uids(args: &Args) -> Result<Vec<u64>> {
  if args.uids_stdin {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut out = Vec::new();
    while let Some(line) = lines.next_line().await? {
      let s = line.trim();
      if s.is_empty() {
        continue;
      }
      let uid: u64 = s.parse().with_context(|| format!("invalid uid: {s}"))?;
      out.push(uid);
    }
    if !out.is_empty() {
      return Ok(out);
    }
    // If stdin is empty, fall through to other sources for convenience.
  }

  if let Some(raw) = &args.uids {
    let mut out = Vec::new();
    for s in parse_list(raw) {
      let uid: u64 = s.parse().with_context(|| format!("invalid uid: {s}"))?;
      out.push(uid);
    }
    if !out.is_empty() {
      return Ok(out);
    }
  }

  if let (Some(start), Some(count)) = (args.uid_start, args.count) {
    if count == 0 {
      return Err(anyhow!("count must be > 0"));
    }
    let mut out = Vec::with_capacity(count.min(200_000) as usize);
    for i in 0..count {
      out.push(start.saturating_add(i));
    }
    return Ok(out);
  }

  Err(anyhow!(
    "missing uids input (provide --uids-stdin, --uids, or --uid-start + --count)"
  ))
}

fn default_user_agent() -> &'static str {
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

fn normalize_base_url(raw: &str) -> String {
  let mut s = raw.trim().to_string();
  if s.is_empty() {
    s = "https://enka.network/".to_string();
  }
  if !s.ends_with('/') {
    s.push('/');
  }
  s
}

fn build_client(proxy_url: Option<&str>, timeout_ms: u64, ua: &str) -> Result<Client> {
  let mut builder = Client::builder()
    .user_agent(ua)
    .redirect(reqwest::redirect::Policy::limited(10))
    .timeout(Duration::from_millis(timeout_ms.max(1)));

  if let Some(p) = proxy_url {
    let proxy = Proxy::all(p).with_context(|| format!("invalid proxy url: {p}"))?;
    builder = builder.proxy(proxy);
  }

  Ok(builder.build()?)
}

fn is_html_body(body: &str) -> bool {
  body.trim_start().starts_with('<')
}

fn rand_jitter_ms(max_jitter: u64) -> u64 {
  if max_jitter == 0 {
    0
  } else {
    fastrand::u64(0..max_jitter)
  }
}

fn build_urls(game: &str, base_url: &str, uid: u64) -> Vec<String> {
  match game {
    "sr" => vec![format!("{base_url}api/hsr/uid/{uid}")],
    "zzz" => vec![
      format!("https://enka.network/api/zzz/uid/{uid}"),
      format!("https://profile.microgg.cn/api/zzz/uid/{uid}"),
    ],
    _ => vec![format!("{base_url}api/uid/{uid}")],
  }
}

async fn fetch_one(
  client: &Client,
  game: &str,
  base_url: &str,
  uid: u64,
  timeout_ms: u64,
  delay_ms: u64,
  proxy_url: Option<&str>,
) -> FetchResult {
  let t0 = Instant::now();
  let urls = build_urls(game, base_url, uid);

  let mut last_status: Option<u16> = None;
  let mut last_is_html = false;
  let mut last_error: Option<String> = None;
  let mut last_base: Option<String> = None;

  for url in urls {
    let res = tokio::time::timeout(
      Duration::from_millis(timeout_ms.max(1)),
      client.get(&url).header("accept", "application/json").send(),
    )
    .await;

    let res = match res {
      Ok(Ok(r)) => r,
      Ok(Err(e)) => {
        last_status = None;
        last_is_html = false;
        last_error = Some(e.to_string());
        last_base = Some(url);
        continue;
      }
      Err(_) => {
        last_status = None;
        last_is_html = false;
        last_error = Some("timeout".to_string());
        last_base = Some(url);
        continue;
      }
    };

    let status = res.status().as_u16();
    let text = match res.text().await {
      Ok(t) => t,
      Err(e) => {
        last_status = Some(status);
        last_is_html = false;
        last_error = Some(e.to_string());
        last_base = Some(url);
        continue;
      }
    };

    let ms = t0.elapsed().as_millis() as u64;
    let html = is_html_body(&text);
    if status == 200 && !html {
      return FetchResult {
        uid,
        ok: true,
        status: Some(status),
        is_html: false,
        body: Some(text),
        error: None,
        ms,
        proxy: proxy_url.map(|s| s.to_string()),
        base: Some(url),
        retry_after_ms: None,
        proxy_disabled: None,
      };
    }

    // Non-200 or HTML. For zzz we should try the next base; for gs/sr this is final anyway.
    let body_short = if text.len() > 300 {
      format!("{}...", &text[..300])
    } else {
      text
    };
    let err = if html {
      format!("http {status} (html): {body_short}")
    } else {
      format!("http {status}: {body_short}")
    };
    last_status = Some(status);
    last_is_html = html;
    last_error = Some(err);
    last_base = Some(url);
  }

  let ms = t0.elapsed().as_millis() as u64;
  let retry_after_ms = if last_status == Some(429) {
    Some((5 * 60_000u64).max(delay_ms.saturating_mul(10)))
  } else {
    None
  };
  FetchResult {
    uid,
    ok: false,
    status: last_status,
    is_html: last_is_html,
    body: None,
    error: Some(last_error.unwrap_or_else(|| "transport_error".to_string())),
    ms,
    proxy: proxy_url.map(|s| s.to_string()),
    base: last_base,
    retry_after_ms,
    proxy_disabled: None,
  }
}

async fn pick_proxy_index(states: &[Arc<Mutex<ProxyState>>], start_idx: usize) -> Option<usize> {
  if states.is_empty() {
    return None;
  }
  let n = states.len();
  let start = start_idx.min(n - 1);
  for step in 0..n {
    let idx = (start + step) % n;
    let st = states[idx].lock().await;
    if !st.disabled {
      return Some(idx);
    }
  }
  None
}

pub async fn run(args: Args) -> Result<()> {
  let game = args.game.trim().to_lowercase();
  if game != "gs" && game != "sr" && game != "zzz" {
    return Err(anyhow!("unsupported game: {}", args.game));
  }

  let uids = Arc::new(read_uids(&args).await?);
  let base_url = normalize_base_url(args.base_url.as_deref().unwrap_or("https://enka.network/"));
  let ua = args.user_agent.clone().unwrap_or_else(|| default_user_agent().to_string());
  let timeout_ms = args.timeout_ms.max(1000).min(120_000);

  let proxy_urls = args
    .proxy_urls
    .as_deref()
    .map(parse_list)
    .unwrap_or_default();

  let has_proxy = !proxy_urls.is_empty();
  let requested_concurrency = args.concurrency.max(1).min(50);
  let concurrency = if has_proxy {
    requested_concurrency.min(proxy_urls.len().max(1))
  } else {
    // JS side forces concurrency=1 in strict no-proxy mode; keep consistent.
    1
  };

  let stop = Arc::new(AtomicBool::new(false));
  let next_idx = Arc::new(AtomicUsize::new(0));

  let proxy_states: Vec<Arc<Mutex<ProxyState>>> = if has_proxy {
    let mut out = Vec::new();
    for p in &proxy_urls {
      let client = build_client(Some(p), timeout_ms, &ua)?;
      out.push(Arc::new(Mutex::new(ProxyState {
        url: p.clone(),
        client,
        disabled: false,
        consecutive_fails: 0,
        next_at: Instant::now(),
      })));
    }
    out
  } else {
    Vec::new()
  };

  let direct_client = if !has_proxy {
    Some(build_client(None, timeout_ms, &ua)?)
  } else {
    None
  };

  let delay_ms = args.delay_ms;
  let jitter_max_ms = args.jitter_ms;
  let no_proxy_delay_ms = args.no_proxy_delay_ms;
  let proxy_max_consec = args.proxy_max_consecutive_fails.max(1).min(200);

  let breaker_max = args.breaker_max_consecutive_fails.max(1).min(200);
  let breaker_on_429 = args.breaker_on_429;
  let consecutive_fails = Arc::new(AtomicUsize::new(0));

  let (tx, mut rx) = mpsc::unbounded_channel::<String>();
  let writer = tokio::spawn(async move {
    while let Some(line) = rx.recv().await {
      println!("{line}");
    }
  });

  let mut tasks = Vec::new();
  for worker_id in 0..concurrency {
    let base_url = base_url.clone();
    let game = game.clone();
    let stop = stop.clone();
    let next_idx = next_idx.clone();
    let proxy_states = proxy_states.clone();
    let direct_client = direct_client.clone();
    let consecutive_fails = consecutive_fails.clone();
    let uids = uids.clone();
    let tx = tx.clone();

    let task = tokio::spawn(async move {
      let mut proxy_idx_hint = worker_id;
      let mut direct_next_at = Instant::now();
      while !stop.load(Ordering::Relaxed) {
        let cur = next_idx.fetch_add(1, Ordering::Relaxed);
        if cur >= uids.len() {
          break;
        }
        let uid = uids[cur];

        let mut proxy_disabled: Option<bool> = None;

        // With proxy path.
        if !proxy_states.is_empty() {
          // With proxy: per-proxy bucket delay.
          let picked = pick_proxy_index(&proxy_states, proxy_idx_hint).await;
          let Some(pidx) = picked else {
            // All proxies disabled.
            break;
          };
          proxy_idx_hint = (pidx + 1) % proxy_states.len();

          let (wait_dur, client, url) = {
            let mut st = proxy_states[pidx].lock().await;
            let now = Instant::now();
            let interval = delay_ms.saturating_add(rand_jitter_ms(jitter_max_ms));
            let wait = st.next_at.saturating_duration_since(now);
            st.next_at = now + Duration::from_millis(interval);
            (wait, st.client.clone(), st.url.clone())
          };
          if !wait_dur.is_zero() {
            sleep(wait_dur).await;
          }

          let r = fetch_one(
            &client,
            &game,
            &base_url,
            uid,
            timeout_ms,
            delay_ms,
            Some(&url),
          )
          .await;

          // Proxy failure tracking.
          if !r.ok {
            let mut st = proxy_states[pidx].lock().await;
            let is_proxy_fail = r.status.is_none() || r.is_html || r.status == Some(429);
            if is_proxy_fail {
              st.consecutive_fails += 1;
            }
            if r.status == Some(429) {
              st.disabled = true;
              proxy_disabled = Some(true);
            } else if is_proxy_fail && st.consecutive_fails >= proxy_max_consec {
              st.disabled = true;
              proxy_disabled = Some(true);
            }
          } else {
            let mut st = proxy_states[pidx].lock().await;
            st.consecutive_fails = 0;
          }

          let mut out = r;
          out.proxy_disabled = proxy_disabled;
          if let Ok(line) = serde_json::to_string(&out) {
            let _ = tx.send(line);
          }
          continue;
        }

        // Direct request path (no proxy).
        let Some(client) = &direct_client else { break };
        // Reserve slot (no initial delay).
        let interval = no_proxy_delay_ms
          .max(delay_ms)
          .saturating_add(rand_jitter_ms(jitter_max_ms));
        let now = Instant::now();
        let wait_dur = direct_next_at.saturating_duration_since(now);
        direct_next_at = now + Duration::from_millis(interval);
        if !wait_dur.is_zero() {
          sleep(wait_dur).await;
        }

        let r = fetch_one(client, &game, &base_url, uid, timeout_ms, delay_ms, None).await;

        if r.ok {
          consecutive_fails.store(0, Ordering::Relaxed);
        } else {
          let prev = consecutive_fails.fetch_add(1, Ordering::Relaxed) + 1;
          if r.status == Some(429) && breaker_on_429 {
            stop.store(true, Ordering::Relaxed);
          } else if prev >= breaker_max {
            stop.store(true, Ordering::Relaxed);
          }
        }

        let out = r;
        if let Ok(line) = serde_json::to_string(&out) {
          let _ = tx.send(line);
        }
      }
    });
    tasks.push(task);
  }

  for t in tasks {
    let _ = t.await;
  }

  drop(tx);
  let _ = writer.await;
  Ok(())
}
