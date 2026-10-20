//! The upgraded program on a v2 shelf and v2 tickets: what mainnet holds until it is re-stamped.
//! `fixtures/mainnet_shelf_v2.bin` is the live mainnet config account, read 2026-10-20.
//!
//!     cargo build-sbf && cargo test --test v2 -- --ignored --nocapture

use bytemuck::Zeroable;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use scratch_cards::state::card::{self, Card, CardStatus};
use scratch_cards::state::config::{Terms, CARD_SIZE_V2, VERSION_V2};

const SHELF: &[u8] = include_bytes!("fixtures/mainnet_shelf_v2.bin");

fn key(b: [u8; 32]) -> Pubkey { Pubkey::new_from_array(b) }
fn program() -> Pubkey { key(scratch_cards::ID.to_bytes()) }
fn acct(data: Vec<u8>, owner: Pubkey) -> Account { Account { lamports: 1_000_000_000, data, owner, executable: false, rent_epoch: 0 } }

fn published() -> usize { u64::from_le_bytes(SHELF[48..56].try_into().unwrap()) as usize }
fn slot(i: usize) -> [u8; CARD_SIZE_V2] { SHELF[56 + i * CARD_SIZE_V2..56 + (i + 1) * CARD_SIZE_V2].try_into().unwrap() }

#[test]
fn the_fixture_is_a_v2_shelf() {
    assert_eq!(u64::from_le_bytes(SHELF[8..16].try_into().unwrap()), VERSION_V2);
    assert!(published() >= 4);
}

/// A v2 card's price and mints are read where v2 kept them.
#[test]
fn v2_terms_read_their_own_layout() {
    for i in 0..published() {
        let b = slot(i);
        let t = Terms::V2(b);
        assert_eq!(t.price_lamports(), u64::from_le_bytes(b[..8].try_into().unwrap()));
        let pool = b[21] as usize;
        for c in 0..pool {
            assert_eq!(t.mint(c).unwrap(), b[512 + c * 48..544 + c * 48]);
        }
        assert!(t.mint(pool).is_none(), "a coin past the pool has no mint");
    }
}

/// `request_collect` on a v2 ticket, and on a pre-terms ticket over the v2 shelf, values the card
/// and gets as far as the vault CPI — which is absent here, so it stops there with MissingAccount.
/// Anything earlier (bad terms, an unreadable shelf) fails before that, in a few hundred units.
#[test]
#[ignore = "needs cargo build-sbf"]
fn v2_tickets_and_the_v2_shelf_are_valued() {
    let m = Mollusk::new(&program(), "scratch_cards");
    let pid = program();
    let user = Pubkey::new_unique();
    let (card_k, _) = Pubkey::find_program_address(&[b"card", user.as_ref()], &pid);
    let (config_k, _) = Pubkey::find_program_address(&[b"config"], &pid);
    let (house, _) = Pubkey::find_program_address(&[b"house"], &pid);
    let (jackpot, _) = Pubkey::find_program_address(&[b"jackpot"], &pid);
    let ledger = |k: Pubkey| key(casino_core::vault::ledger(&casino_core::chain::Pubkey::new_from_array(k.to_bytes())).to_bytes());
    let receipt = key(casino_core::receipt::address(&scratch_cards::ID, &casino_core::chain::Pubkey::new_from_array(user.to_bytes())).to_bytes());
    let other = Pubkey::new_unique();
    for i in 0..published() {
        for printed in [true, false] {
            let mut worst = 0;
            for s in 0..200u32 {
                let mut c = Card::zeroed();
                c.discriminator = card::DISCRIMINATOR;
                c.version = card::VERSION;
                c.user = user.to_bytes();
                c.card_id = i as u64;
                c.status = CardStatus::Revealed as u64;
                c.seed[..4].copy_from_slice(&s.to_le_bytes());
                let mut data = bytemuck::bytes_of(&c).to_vec();
                if printed {
                    data.extend_from_slice(&slot(i));
                    data.resize(Card::PERSISTENT_SIZE_V2, 0);
                }
                let ix = Instruction::new_with_bytes(pid, &25u64.to_le_bytes(), vec![
                    AccountMeta::new_readonly(user, false), AccountMeta::new_readonly(config_k, false), AccountMeta::new(house, false),
                    AccountMeta::new(card_k, false), AccountMeta::new(receipt, false), AccountMeta::new(other, false),
                    AccountMeta::new_readonly(other, false), AccountMeta::new_readonly(other, false), AccountMeta::new_readonly(jackpot, false),
                    AccountMeta::new(ledger(jackpot), false), AccountMeta::new_readonly(user, true), AccountMeta::new(ledger(house), false),
                    AccountMeta::new(other, false)]);
                let accounts = vec![
                    (user, acct(vec![], Pubkey::default())), (config_k, acct(SHELF.to_vec(), pid)), (house, acct(vec![], pid)),
                    (card_k, acct(data, pid)), (receipt, acct(vec![], Pubkey::default())), (other, acct(vec![], Pubkey::default())),
                    (jackpot, acct(vec![], pid)), (ledger(jackpot), acct(vec![0u8; 400], Pubkey::default())),
                    (ledger(house), acct(vec![0u8; 400], Pubkey::default())),
                ];
                let r = m.process_instruction(&ix, &accounts);
                assert_eq!(
                    r.raw_result.clone().map_err(|e| e != InstructionError::MissingAccount).err(),
                    Some(false),
                    "slot {i} printed={printed} seed {s}: {:?} after {} CU", r.raw_result, r.compute_units_consumed,
                );
                assert!(r.compute_units_consumed > 2_000, "slot {i}: stopped early");
                worst = worst.max(r.compute_units_consumed);
            }
            println!("mainnet slot {i} {}: valued, worst {worst} CU to the vault CPI", if printed { "v2 ticket" } else { "pre-terms ticket" });
        }
    }
}
