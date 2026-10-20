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

/// `Initialize` as `setup --restamp` sends it, on a shelf that already exists: every PDA present,
/// the analytics permission already created (so `permission::set` returns early).
fn initialize(admin: Pubkey, shelf: Vec<u8>) -> (Instruction, Vec<(Pubkey, Account)>) {
    use scratch_cards::state::analytics::{self, Analytics};
    let pid = program();
    let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed], &pid).0;
    let (config, house, jackpot, analytics_k) = (pda(b"config"), pda(b"house"), pda(b"jackpot"), pda(b"analytics"));
    let permission = key(casino_core::permission::address(&casino_core::chain::Pubkey::new_from_array(analytics_k.to_bytes())).to_bytes());
    let permission_program = key(casino_core::ids::PERMISSION_PROGRAM.to_bytes());
    let mut a = Analytics::zeroed();
    a.discriminator = analytics::DISCRIMINATOR;
    a.version = analytics::VERSION;
    let ix = Instruction::new_with_bytes(pid, &[1u64.to_le_bytes().as_slice(), &[0u8]].concat(), vec![
        AccountMeta::new(admin, true), AccountMeta::new(config, false), AccountMeta::new(house, false),
        AccountMeta::new(jackpot, false), AccountMeta::new(analytics_k, false), AccountMeta::new(permission, false),
        AccountMeta::new_readonly(permission_program, false), AccountMeta::new_readonly(Pubkey::default(), false),
    ]);
    let accounts = vec![
        (admin, Account::new(1_000_000_000, 0, &Pubkey::default())),
        (config, acct(shelf, pid)), (house, acct(vec![], pid)), (jackpot, acct(vec![], pid)),
        (analytics_k, acct(bytemuck::bytes_of(&a).to_vec(), pid)),
        (permission, acct(vec![1u8; 64], permission_program)),
        (permission_program, Account { lamports: 1, data: vec![], owner: Pubkey::default(), executable: true, rent_epoch: 0 }),
        (Pubkey::default(), Account { lamports: 1, data: vec![], owner: Pubkey::default(), executable: true, rent_epoch: 0 }),
    ];
    (ix, accounts)
}

fn header(accounts: &[(Pubkey, Account)]) -> (u64, u64, usize) {
    let config = Pubkey::find_program_address(&[b"config"], &program()).0;
    let (_, a) = accounts.iter().find(|(k, _)| *k == config).unwrap();
    (u64::from_le_bytes(a.data[8..16].try_into().unwrap()), u64::from_le_bytes(a.data[48..56].try_into().unwrap()), a.data.len())
}

/// Re-stamping the live v2 shelf takes every card off sale in the same instruction: nothing can
/// be sold or valued at the wrong stride, whatever else the admin sends or forgets.
#[test]
#[ignore = "needs cargo build-sbf"]
fn initialize_on_a_v2_shelf_restamps_it_empty() {
    let m = Mollusk::new(&program(), "scratch_cards");
    let admin = key(casino_core::ids::OPS_KEY.to_bytes());
    let (ix, accounts) = initialize(admin, SHELF.to_vec());
    let r = m.process_instruction(&ix, &accounts);
    assert_eq!(r.raw_result, Ok(()));
    let (version, count, len) = header(&r.resulting_accounts);
    assert_eq!(version, scratch_cards::state::config::VERSION);
    assert_eq!(count, 0, "the v2 cards must not stay on sale at the v3 stride");
    assert_eq!(len, SHELF.len(), "the shelf is not grown — SetCard grows it per card");
}

/// A re-run at the current layout is the idempotent setup it always was: the cards stay.
#[test]
#[ignore = "needs cargo build-sbf"]
fn initialize_on_a_v3_shelf_keeps_its_cards() {
    use scratch_cards::state::config::{self, Config};
    let m = Mollusk::new(&program(), "scratch_cards");
    let admin = key(casino_core::ids::OPS_KEY.to_bytes());
    let mut shelf = vec![0u8; Config::size_for(4)];
    shelf[..8].copy_from_slice(&config::DISCRIMINATOR.to_le_bytes());
    shelf[8..16].copy_from_slice(&config::VERSION.to_le_bytes());
    shelf[48..56].copy_from_slice(&3u64.to_le_bytes());
    let (ix, accounts) = initialize(admin, shelf);
    let r = m.process_instruction(&ix, &accounts);
    assert_eq!(r.raw_result, Ok(()));
    let (version, count, _) = header(&r.resulting_accounts);
    assert_eq!((version, count), (scratch_cards::state::config::VERSION, 3));
}
