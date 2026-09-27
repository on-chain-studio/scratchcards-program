//! Real cards on devnet, end to end, the way the app plays them. Scratching is client-side, so
//! this does the parts that touch the chain: the ledger funded and in session, the purchase settled
//! into a card, the seed asked for and waited on, the collect that pays and closes the card.
//! Buying and revealing are separate transactions on purpose: the reveal is permissionless and
//! retryable, so a VRF request that fails cannot unwind a purchase that is already paid for.

use anyhow::{bail, Result};
use casino_core::ids::{PERMISSION_PROGRAM, VAULT_PROGRAM, VRF_PROGRAM};
use casino_core::permission;
use casino_ops::magicblock::{EPHEMERAL_VAULT, MAGIC_CONTEXT, MAGIC_PROGRAM, SLOT_HASHES, VRF_EPHEMERAL_QUEUE};
use casino_ops::vault::{self, SYSTEM_PROGRAM};
use casino_ops::{sol, Chain, Endpoint, Instruction, Keypair, Player, Pubkey, Signer, Treasury};
use scratch_cards::instructions::{request_purchase::RequestPurchase, resolve_collect::ResolveCollect, resolve_purchase::ResolvePurchase};
use scratch_cards::state::card::{self, Card};

use crate::sheet::Mints;
use crate::{analytics, card_of, config, generated, house, identity, jackpot, ScratchCards};

const REVEALED: u64 = 2;

fn built(result: solarium_client::result::Result<Instruction>) -> Result<Instruction> {
    result.map_err(|e| anyhow::anyhow!("{e}"))
}

pub struct Table<'p, 'c> {
    pub player: &'p Player<'c>,
    pub at: Endpoint,
}

impl Table<'_, '_> {
    fn user(&self) -> Pubkey {
        self.player.key()
    }

    pub async fn card(&self) -> Result<Option<Card>> {
        let account = self.at.account(&card_of(&self.user())).await?;
        Ok(account.and_then(|a| casino_ops::decode::<Card>(&a.data)).filter(|c| c.discriminator == card::DISCRIMINATOR))
    }

    /// Two instructions, one transaction: the terms, then their settle. The card is made by the
    /// callback inside the settle, from the card id the receipt carries — so the card bought
    /// cannot differ from the card paid for. The callback also makes the card private on the TEE
    /// the first time, so it is handed the card's permission and the ACL program; after that the
    /// permission is left as it is, since it outlives every card at the address.
    async fn buy(&self, card_id: u64) -> Result<()> {
        let (user, session) = (self.user(), self.player.session.pubkey());
        let request = built(generated::ScratchCards::request_purchase_instruction(
            session, user, config(), house(), self.player.receipt(), EPHEMERAL_VAULT, MAGIC_PROGRAM, VAULT_PROGRAM,
            jackpot(), Treasury::house::<ScratchCards>().ledger, MAGIC_CONTEXT, RequestPurchase { card_id },
        ))?;
        let resolve = built(generated::ScratchCards::resolve_purchase_instruction(
            self.player.receipt(), vault::authority(), config(), house(), card_of(&user), EPHEMERAL_VAULT, MAGIC_PROGRAM,
            analytics(), permission::address(&card_of(&user)), PERMISSION_PROGRAM, ResolvePurchase { human: user, card_id },
        ))?;
        self.player.play(&self.at, &[request, self.player.settle::<ScratchCards>(resolve)]).await?;
        self.player.until("the card", async || Ok(self.card().await?)).await?;
        Ok(())
    }

    async fn reveal(&self) -> Result<Card> {
        let request = built(generated::ScratchCards::request_reveal_instruction(
            self.user(), house(), card_of(&self.user()), identity(), VRF_EPHEMERAL_QUEUE, SLOT_HASHES, SYSTEM_PROGRAM,
            VRF_PROGRAM,
        ))?;
        self.player.play(&self.at, &[request]).await?;
        println!("  ✅ reveal requested");
        self.player.until("the seed", async || Ok(self.card().await?.filter(|c| c.status == REVEALED))).await
    }

    /// Values the card and pays it. A losing card arrives on an empty receipt, exactly as a winning
    /// one does; either way the callback closes the card.
    async fn collect(&self) -> Result<()> {
        let (user, session) = (self.user(), self.player.session.pubkey());
        let jackpot_ledger = Treasury::named::<ScratchCards>("jackpot")?.ledger;
        let request = built(generated::ScratchCards::request_collect_instruction(
            user, config(), house(), card_of(&user), self.player.receipt(), EPHEMERAL_VAULT, MAGIC_PROGRAM, VAULT_PROGRAM,
            jackpot(), jackpot_ledger, session, Treasury::house::<ScratchCards>().ledger, MAGIC_CONTEXT,
        ))?;
        let resolve = built(generated::ScratchCards::resolve_collect_instruction(
            self.player.receipt(), vault::authority(), house(), card_of(&user), EPHEMERAL_VAULT, MAGIC_PROGRAM, analytics(),
            ResolveCollect { human: user, jackpot_paid: 0 },
        ))?;
        self.player.play(&self.at, &[request, self.player.settle::<ScratchCards>(resolve)]).await?;
        self.player.until("the card closing", async || Ok(self.card().await?.is_none().then_some(()))).await
    }

    /// Carries a card left mid-flow through: reveal if it has no seed, then collect.
    pub async fn finish(&self) -> Result<bool> {
        let Some(card) = self.card().await? else { return Ok(false) };
        println!("  a card from an earlier run: status {}, card {}", status(card.status), card.card_id);
        if card.status != REVEALED {
            self.reveal().await?;
        }
        self.collect().await?;
        println!("  ✅ finished it");
        Ok(true)
    }
}

pub fn status(status: u64) -> &'static str {
    ["bought", "requested", "revealed"].get(status as usize).copied().unwrap_or("?")
}

pub async fn play(chain: &Chain, wallet: &Keypair, cards: u32, card_id: u64, close: bool) -> Result<()> {
    let shelf = crate::cards_on_chain(chain).await?;
    let Some(terms) = shelf.get(card_id as usize) else {
        bail!("card {card_id} is not on the shelf");
    };
    let price = terms.price_lamports;
    let mints = Mints::load(chain.net.mainnet).unwrap_or_default();
    let player = Player::new(chain, wallet, scratch_cards::ID);
    let before_wallet = chain.balance(&player.key()).await?;
    println!("program  {}", scratch_cards::ID);
    println!("rollup   {}", chain.rollup.url);
    println!("player   {}", player.key());
    println!("card {card_id}   {} SOL × {cards}\n", sol(price));

    println!("1. the ledger, funded and on the rollup");
    let live = player.ready(price * cards as u64, |m| println!("  ✅ {m}")).await?;
    println!("  ✅ live on the rollup with {} SOL", sol(live));
    let table = Table { player: &player, at: player.rollup().await? };
    let start = player.ledger_at(&table.at).await?;
    table.finish().await?;

    let mut played = 0;
    for n in 1..=cards {
        println!("\n2.{n} card {n}/{cards}");
        let before = player.ledger_at(&table.at).await?;
        table.buy(card_id).await?;
        println!("  ✅ bought — {} SOL to the house, card created", sol(price));
        let card = table.reveal().await?;
        println!("  ✅ the VRF answered — seed {}…", hex(&card.seed[..8]));
        table.collect().await?;
        let after = player.ledger_at(&table.at).await?;
        let mut won = Vec::new();
        if let (Some(before), Some(after)) = (&before, &after) {
            for (mint, amount) in &after.balances {
                // Net of the price: SOL paid for the card comes back out of any SOL win.
                let was = before.balance(mint) - if *mint == vault::SOL_MINT { price.min(before.balance(mint)) } else { 0 };
                if *amount > was {
                    // SOL in SOL; a token in its base units, which the stand-in mints make whole.
                    won.push(if *mint == vault::SOL_MINT {
                        format!("{} SOL", sol(amount - was))
                    } else {
                        format!("{} {}", amount - was, mints.symbol(mint))
                    });
                }
            }
        }
        println!("  ✅ collected: {}", if won.is_empty() { "no win — card closed".to_string() } else { won.join(", ") });
        played += 1;
    }

    println!("\n3. the session");
    if let (Some(start), Some(end)) = (start, player.ledger_at(&table.at).await?) {
        println!("   SOL on the ledger {} (was {}; spent {} on {played} card(s))", sol(end.sol), sol(start.sol), sol(price * played));
        let tokens: Vec<String> =
            end.balances.iter().filter(|(m, _)| *m != vault::SOL_MINT).map(|(m, a)| format!("{a} {}", mints.symbol(m))).collect();
        println!("   tokens held       {}", if tokens.is_empty() { "none".into() } else { tokens.join(", ") });
    }

    if close {
        println!("\n4. teardown");
        let withdrawn = player.close().await?;
        println!("  ✅ withdrew {} SOL, closed the ledger and its permission", sol(withdrawn));
    } else {
        println!("\nthe ledger is left open for the next run — reclaim it with --close");
    }
    println!("this run cost {} SOL from the wallet (deposits included)", sol(before_wallet.saturating_sub(chain.balance(&player.key()).await?)));
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
