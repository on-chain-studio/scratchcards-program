//! Watching accounts change, for the questions a client's waits raise: is the chain slow, or are
//! we slow to notice it? And does the rollup push account notifications at all?

use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use casino_core::ids::VAULT_PROGRAM;
use casino_core::magicblock::DELEGATION_PROGRAM_ID;
use casino_ops::{sol, tee, vault, Chain, Endpoint, Keypair, Pubkey, Signer};
use serde_json::{json, Value};
use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::rpc_config::RpcAccountInfoConfig;
use solana_client::rpc_request::RpcRequest;
use solana_commitment_config::CommitmentConfig;
use tokio_stream::StreamExt;

use crate::card_of;

/// The vault ledger's discriminator, base58, for a `memcmp` at offset 0.
const LEDGER_DISCRIMINATOR: &str = "8DiEB2worzb";

fn clock() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) % 86_400_000;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

fn holder(owner: &str) -> String {
    if owner == VAULT_PROGRAM.to_string() {
        "the vault (home)".into()
    } else if owner == DELEGATION_PROGRAM_ID.to_string() {
        "the delegation program (in a session)".into()
    } else {
        owner.into()
    }
}

fn fingerprint(data: &[u8], lamports: u64) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    lamports.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

fn subscription_config() -> RpcAccountInfoConfig {
    RpcAccountInfoConfig {
        encoding: Some(solana_client::rpc_config::UiAccountEncoding::Base64),
        commitment: Some(CommitmentConfig::confirmed()),
        ..Default::default()
    }
}

/// With no argument, the ledgers on basenet, home and delegated. With a wallet or a ledger, that
/// ledger watched over a websocket, timestamping each change and every change of hands.
pub async fn watch_ledger(chain: &Chain, who: Option<String>) -> Result<()> {
    let Some(who) = who else {
        for program in [DELEGATION_PROGRAM_ID, VAULT_PROGRAM] {
            let params = json!([program.to_string(), {
                "encoding": "base64", "dataSlice": { "offset": 0, "length": 0 },
                "filters": [{ "memcmp": { "offset": 0, "bytes": LEDGER_DISCRIMINATOR } }],
            }]);
            // An endpoint that refuses indexed reads must say so: "0 ledgers" would read as an
            // answer about the chain when it is an answer about the endpoint.
            match chain.base.connection.send::<Value>(RpcRequest::GetProgramAccounts, params).await {
                Ok(found) => {
                    let found = found.as_array().cloned().unwrap_or_default();
                    println!("\n{} — {} ledger(s)", holder(&program.to_string()), found.len());
                    for entry in found {
                        let lamports = entry["account"]["lamports"].as_u64().unwrap_or(0);
                        println!("  {}  {} SOL", entry["pubkey"].as_str().unwrap_or("?"), sol(lamports));
                    }
                }
                Err(e) => println!("\n{} — cannot list: {}", holder(&program.to_string()), e.to_string().chars().take(120).collect::<String>()),
            }
        }
        println!("\nPass a wallet (or a ledger) to watch it.");
        return Ok(());
    };

    let key: Pubkey = who.parse().map_err(|e| anyhow::anyhow!("{who} is not a key: {e:?}"))?;
    // A wallet derives its ledger; a ledger derives nothing that exists. Whichever account is
    // there is the one to watch.
    let derived = vault::ledger(&key);
    let ledger = if chain.account(&derived).await?.is_some() { derived } else { key };
    let start = chain.account(&ledger).await?.with_context(|| format!("{ledger} does not exist on basenet"))?;
    let mut owner = start.owner.to_string();
    let mut since = Instant::now();
    println!("watching {ledger}");
    println!("{}  held by {}  {} SOL", clock(), holder(&owner), sol(start.lamports));

    let ws = tee::with_token(&chain.base.url, None).1;
    let client = PubsubClient::new(&ws).await.map_err(|e| anyhow::anyhow!("opening the websocket: {e:?}"))?;
    let (mut updates, _unsubscribe) = client
        .account_subscribe(&ledger.to_string().parse()?, Some(subscription_config()))
        .await
        .context("subscribing")?;
    println!("{}  subscribed — undelegate now", clock());
    while let Some(update) = updates.next().await {
        let next = update.value.owner;
        let dt = since.elapsed().as_secs_f64();
        if next == owner {
            println!("{}  (+{dt:.1}s) data changed, still held by {}", clock(), holder(&owner));
            continue;
        }
        println!("{}  (+{dt:.1}s) CHANGED HANDS  {} -> {}", clock(), holder(&owner), holder(&next));
        owner = next;
        since = Instant::now();
    }
    println!("{}  socket closed", clock());
    Ok(())
}

/// Does the rollup push account notifications for real delegated accounts? Subscribes to the
/// player's ledger and card on the rollup, polls both over HTTP as the ground truth for when a
/// change became visible, and plays one card meanwhile.
pub async fn probe_push(chain: &Chain, wallet: &Keypair) -> Result<()> {
    let user = wallet.pubkey();
    let watched = [("ledger", vault::ledger(&user)), ("card", card_of(&user))];
    // One login for both sides: a second one retires the first token.
    let token = tee::login(&chain.http, &chain.rollup.url, wallet).await?;
    let ws = tee::with_token(&chain.rollup.url, Some(&token)).1;
    let rollup = Endpoint::new(&chain.rollup.url, Some(&token), true);
    let start = Instant::now();
    let at = move || format!("{:.2}s", start.elapsed().as_secs_f64());

    let client = PubsubClient::new(&ws).await.map_err(|e| anyhow::anyhow!("opening the rollup's websocket: {e:?}"))?;
    let mut streams = Vec::new();
    for (name, key) in watched {
        let (stream, _unsubscribe) = client
            .account_subscribe(&key.to_string().parse()?, Some(subscription_config()))
            .await
            .with_context(|| format!("subscribing to the {name}"))?;
        println!("{} WS subscribed {name}", at());
        streams.push(stream.map(move |update| (name, update)));
    }
    let mut pushes = futures_merge(streams);
    let listen = async {
        while let Some((name, update)) = pushes.next().await {
            let data = update.value.data.decode().unwrap_or_default();
            println!("{} WS PUSH {name}: lamports={} data#{}", at(), update.value.lamports, fingerprint(&data, 0));
        }
    };

    let poll = async {
        let mut last: [Option<String>; 2] = [None, None];
        loop {
            for (i, (name, key)) in watched.iter().enumerate() {
                let seen = rollup.account(key).await.ok().flatten();
                let now = seen.as_ref().map(|a| fingerprint(&a.data, a.lamports)).unwrap_or_else(|| "absent".into());
                match &last[i] {
                    None => println!("{} HTTP baseline {name}: {now}", at()),
                    Some(before) if *before != now => println!(
                        "{} HTTP CHANGE {name}: {before} -> {now} lamports={}", at(), seen.map(|a| a.lamports).unwrap_or(0)
                    ),
                    _ => {}
                }
                last[i] = Some(now);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    };

    let run = async {
        println!("{} playing one card", at());
        let played = crate::play::play(chain, wallet, 1, 0, false).await;
        println!("{} play finished ({}) — listening 10s more for stragglers", at(), if played.is_ok() { "ok" } else { "failed" });
        tokio::time::sleep(Duration::from_secs(10)).await;
        played
    };

    tokio::select! {
        played = run => played,
        _ = listen => Ok(()),
        _ = poll => Ok(()),
        _ = tokio::time::sleep(Duration::from_secs(150)) => { println!("{} TIMEOUT", at()); Ok(()) }
    }
}

fn futures_merge<S: tokio_stream::Stream + Unpin>(streams: Vec<S>) -> impl tokio_stream::Stream<Item = S::Item> + Unpin {
    let mut merged = tokio_stream::StreamMap::new();
    for (i, stream) in streams.into_iter().enumerate() {
        merged.insert(i, stream);
    }
    merged.map(|(_, item)| item)
}
