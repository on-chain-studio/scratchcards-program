//! The retired v2 shelf: mainnet's until its re-stamp on 2026-10-23, never published again. The
//! program reads none of it any more; only the engine keeps v2, to verify legacy cards from a
//! seed. `fixtures/mainnet_shelf_v2.bin` is the mainnet config account as it was, read 2026-10-20.
//!
//!     cargo build-sbf && cargo test --test v2 -- --ignored --nocapture

use bytemuck::Zeroable;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use scratch_cards::state::card::{self, Card, CardStatus};

const SHELF: &[u8] = include_bytes!("fixtures/mainnet_shelf_v2.bin");

fn key(b: [u8; 32]) -> Pubkey { Pubkey::new_from_array(b) }
fn program() -> Pubkey { key(scratch_cards::ID.to_bytes()) }
fn acct(data: Vec<u8>, owner: Pubkey) -> Account { Account { lamports: 1_000_000_000, data, owner, executable: false, rent_epoch: 0 } }

fn published() -> usize { u64::from_le_bytes(SHELF[48..56].try_into().unwrap()) as usize }

#[test]
fn the_fixture_is_a_v2_shelf() {
    assert_eq!(u64::from_le_bytes(SHELF[8..16].try_into().unwrap()), 2);
    assert!(published() >= 4);
}

/// A card without printed terms is valued by the shelf, and a v2 shelf is no longer one the
/// program reads: `request_collect` refuses before it gets anywhere near the vault.
#[test]
#[ignore = "needs cargo build-sbf"]
fn the_v2_shelf_is_read_no_more() {
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
    let mut c = Card::zeroed();
    c.discriminator = card::DISCRIMINATOR;
    c.version = card::VERSION;
    c.user = user.to_bytes();
    c.status = CardStatus::Revealed as u64;
    let ix = Instruction::new_with_bytes(pid, &25u64.to_le_bytes(), vec![
        AccountMeta::new_readonly(user, false), AccountMeta::new_readonly(config_k, false), AccountMeta::new(house, false),
        AccountMeta::new(card_k, false), AccountMeta::new(receipt, false), AccountMeta::new(other, false),
        AccountMeta::new_readonly(other, false), AccountMeta::new_readonly(other, false), AccountMeta::new_readonly(jackpot, false),
        AccountMeta::new(ledger(jackpot), false), AccountMeta::new_readonly(user, true), AccountMeta::new(ledger(house), false),
        AccountMeta::new(other, false)]);
    let accounts = vec![
        (user, acct(vec![], Pubkey::default())), (config_k, acct(SHELF.to_vec(), pid)), (house, acct(vec![], pid)),
        (card_k, acct(bytemuck::bytes_of(&c).to_vec(), pid)), (receipt, acct(vec![], Pubkey::default())), (other, acct(vec![], Pubkey::default())),
        (jackpot, acct(vec![], pid)), (ledger(jackpot), acct(vec![0u8; 400], Pubkey::default())),
        (ledger(house), acct(vec![0u8; 400], Pubkey::default())),
    ];
    assert_eq!(m.process_instruction(&ix, &accounts).raw_result, Err(InstructionError::InvalidAccountData));
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
