mod enka_fetch;
mod probe_pool;
mod sub_parse;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(author, version, about)]
struct Cli {
  #[command(subcommand)]
  command: Commands,
}

#[derive(Subcommand)]
enum Commands {
  /// Fetch Enka API JSON for a list of UIDs and output JSONL lines (1 result per UID).
  EnkaFetch(enka_fetch::Args),

  /// Parse subscription text (vmess/vless/trojan/ss + Clash YAML proxies) and output Canonical Node JSONL.
  SubParse(sub_parse::Args),

  /// Probe a list of proxy URLs by fetching a JSON endpoint (stdout JSONL).
  ProbePool(probe_pool::Args),
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
  let cli = Cli::parse();
  match cli.command {
    Commands::EnkaFetch(args) => enka_fetch::run(args).await,
    Commands::SubParse(args) => sub_parse::run(args).await,
    Commands::ProbePool(args) => probe_pool::run(args).await,
  }
}
