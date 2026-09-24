//! The built program, run. `layout.rs` pins what the bytes mean; these check that the deployed
//! artifact dispatches and refuses exactly as it always has — the same accounts in the same order,
//! the same errors for the same mistakes. They load `target/deploy/scratch_cards.so`, so they need
//! `cargo build-sbf` first, and are ignored otherwise:
//!
//!     cargo build-sbf && SBF_OUT_DIR=$PWD/target/deploy cargo test --test program -- --ignored
//!
//! Point `SBF_OUT_DIR` at another build to run the same checks against it.

use bytemuck::Zeroable;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use scratch_cards::error::GameError;
use scratch_cards::state::card::{self, Card, CardStatus};

fn key(bytes: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(bytes)
}

fn program() -> Pubkey {
    key(scratch_cards::ID.to_bytes())
}

fn vrf_identity() -> Pubkey {
    key(scratch_cards::utils::vrf::callback_identity(&scratch_cards::ID).to_bytes())
}

fn mollusk() -> Mollusk {
    Mollusk::new(&program(), "scratch_cards")
}

fn wallet() -> Account {
    Account::new(1_000_000_000, 0, &Pubkey::default())
}

fn input(discriminator: u64, arguments: &[u8]) -> Vec<u8> {
    [&discriminator.to_le_bytes()[..], arguments].concat()
}

struct Table {
    user: Pubkey,
    card: Pubkey,
}

impl Table {
    fn new() -> Self {
        let user = Pubkey::new_unique();
        let (card, _) = Pubkey::find_program_address(&[b"card", user.as_ref()], &program());
        Self { user, card }
    }

    fn card_account(&self, status: CardStatus) -> Account {
        let mut c = Card::zeroed();
        c.discriminator = card::DISCRIMINATOR;
        c.version = card::VERSION;
        c.user = self.user.to_bytes();
        c.status = status as u64;
        let mut data = bytemuck::bytes_of(&c).to_vec();
        data.resize(Card::WITH_TERMS, 0);
        Account { lamports: 1_000_000_000, data, owner: program(), executable: false, rent_epoch: 0 }
    }

    fn card_after(&self, accounts: &[(Pubkey, Account)]) -> Card {
        let (_, account) = accounts.iter().find(|(k, _)| *k == self.card).unwrap();
        *bytemuck::from_bytes::<Card>(&account.data[..Card::SIZE])
    }

    fn reveal(&self, signer: Pubkey, extra: &[u8]) -> Instruction {
        Instruction::new_with_bytes(
            program(),
            &input(12, &[&[9u8; 32][..], extra].concat()),
            vec![AccountMeta::new_readonly(signer, true), AccountMeta::new(self.card, false)],
        )
    }
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_oracle_lands_its_seed_on_a_requested_card() {
    let table = Table::new();
    let result = mollusk().process_instruction(
        // Whatever the oracle appends after the randomness is not the program's business.
        &table.reveal(vrf_identity(), &[0xAA; 8]),
        &[(vrf_identity(), wallet()), (table.card, table.card_account(CardStatus::Requested))],
    );
    assert_eq!(result.raw_result, Ok(()));
    let after = table.card_after(&result.resulting_accounts);
    assert_eq!(after.seed, [9; 32]);
    assert_eq!(after.status, CardStatus::Revealed as u64);
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn anyone_but_the_oracle_is_refused_for_its_signature() {
    let table = Table::new();
    let impostor = Pubkey::new_unique();
    let result = mollusk().process_instruction(
        &table.reveal(impostor, &[]),
        &[(impostor, wallet()), (table.card, table.card_account(CardStatus::Requested))],
    );
    assert_eq!(result.raw_result, Err(InstructionError::MissingRequiredSignature));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_card_not_waiting_for_the_oracle_is_refused() {
    let table = Table::new();
    let result = mollusk().process_instruction(
        &table.reveal(vrf_identity(), &[]),
        &[(vrf_identity(), wallet()), (table.card, table.card_account(CardStatus::Revealed))],
    );
    assert_eq!(result.raw_result, Err(InstructionError::Custom(GameError::WrongStatus as u32)));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_reveal_missing_its_card_is_refused_for_the_account() {
    let table = Table::new();
    let mut instruction = table.reveal(vrf_identity(), &[]);
    instruction.accounts.truncate(1);
    let result = mollusk().process_instruction(&instruction, &[(vrf_identity(), wallet())]);
    assert_eq!(result.raw_result, Err(InstructionError::NotEnoughAccountKeys));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn zero_is_a_no_op_whatever_it_is_given() {
    let table = Table::new();
    let mut instruction = table.reveal(vrf_identity(), &[1, 2, 3]);
    instruction.data[..8].copy_from_slice(&0u64.to_le_bytes());
    let card = table.card_account(CardStatus::Requested);
    let result = mollusk().process_instruction(
        &instruction,
        &[(vrf_identity(), wallet()), (table.card, card.clone())],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(result.resulting_accounts[1].1.data, card.data, "the no-op wrote");

    let bare = Instruction::new_with_bytes(program(), &input(0, &[]), vec![]);
    assert_eq!(mollusk().process_instruction(&bare, &[]).raw_result, Ok(()));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn retired_numbers_are_no_ops_too() {
    for retired in [5u64, 6, 8, 10, 11, 13, 14, 19, 23] {
        let bare = Instruction::new_with_bytes(program(), &input(retired, &[]), vec![]);
        assert_eq!(mollusk().process_instruction(&bare, &[]).raw_result, Ok(()), "{retired}");
    }
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn numbers_past_the_list_are_invalid_data() {
    let table = Table::new();
    for retired in [32u64, 33, 255, 1 << 40] {
        let mut instruction = table.reveal(vrf_identity(), &[]);
        instruction.data[..8].copy_from_slice(&retired.to_le_bytes());
        let result = mollusk().process_instruction(
            &instruction,
            &[(vrf_identity(), wallet()), (table.card, table.card_account(CardStatus::Requested))],
        );
        assert_eq!(
            result.raw_result,
            Err(InstructionError::InvalidInstructionData),
            "{retired} was answered"
        );
    }
}

fn jackpot() -> (Pubkey, Pubkey) {
    let (jackpot, _) = Pubkey::find_program_address(&[b"jackpot"], &program());
    let vault = key(scratch_cards::constants::VAULT_PROGRAM.to_bytes());
    let (ledger, _) = Pubkey::find_program_address(&[b"ledger", jackpot.as_ref()], &vault);
    (jackpot, ledger)
}

fn ledger_holding(lamports: u64) -> Account {
    // The vault's layout: a 116-byte header, then slot 0 — the SOL mint, then its amount.
    let mut data = vec![0u8; 116 + 32 + 8];
    data[148..156].copy_from_slice(&lamports.to_le_bytes());
    let vault = key(scratch_cards::constants::VAULT_PROGRAM.to_bytes());
    Account { lamports: 1_000_000, data, owner: vault, executable: false, rent_epoch: 0 }
}

fn read_jackpot(jackpot: Pubkey, ledger: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        program(),
        &input(21, &[]),
        vec![AccountMeta::new_readonly(jackpot, false), AccountMeta::new_readonly(ledger, false)],
    )
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_pot_is_read_off_the_jackpot_ledger() {
    let (jackpot, ledger) = jackpot();
    let result = mollusk().process_instruction(
        &read_jackpot(jackpot, ledger),
        &[(jackpot, Account::new(1_000_000, 0, &program())), (ledger, ledger_holding(4_200_000))],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(result.return_data, 4_200_000u64.to_le_bytes());
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn another_ledger_is_not_the_pot() {
    let (jackpot, _) = jackpot();
    let other = Pubkey::new_unique();
    let result = mollusk().process_instruction(
        &read_jackpot(jackpot, other),
        &[(jackpot, Account::new(1_000_000, 0, &program())), (other, ledger_holding(1))],
    );
    assert_eq!(result.raw_result, Err(InstructionError::Custom(GameError::InvalidPDA as u32)));
}
