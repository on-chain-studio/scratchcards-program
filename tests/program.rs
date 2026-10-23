//! The built program, run. `layout.rs` pins what the bytes mean; these check that the artifact
//! that will be deployed dispatches and refuses the way the source says it does — the same
//! accounts in the same order, the same errors for the same mistakes. They load
//! `target/deploy/scratch_cards.so`, so they need `cargo build-sbf` first, and are ignored
//! otherwise:
//!
//!     cargo build-sbf && cargo test --test program -- --ignored
//!
//! Point `SBF_OUT_DIR` at another build to run the same checks against it.

use bytemuck::Zeroable;
use mollusk_svm::Mollusk;
use pinocchio::error::ProgramError;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use casino_core::CoreError;
use scratch_cards::state::card::{self, Card, CardStatus};

fn key(bytes: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(bytes)
}

fn program() -> Pubkey {
    key(scratch_cards::ID.to_bytes())
}

/// The oracle signs a scoped request's callback as `["identity", program]` at the VRF program.
fn vrf_identity() -> Pubkey {
    key(casino_core::vrf::scoped_identity(&scratch_cards::ID).to_bytes())
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
            &input(12, &[&[9u8; 32][..], &0u64.to_le_bytes(), extra].concat()),
            vec![AccountMeta::new_readonly(signer, true), AccountMeta::new(self.card, false)],
        )
    }
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_oracle_lands_its_seed_on_a_requested_card() {
    let table = Table::new();
    let result = mollusk().process_instruction(
        // Whatever the oracle appends after the generation is not the program's business.
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
    assert_eq!(result.raw_result, Err(InstructionError::Custom(CoreError::WrongStatus as u32)));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_reveal_missing_its_card_is_refused_for_the_account() {
    let table = Table::new();
    let mut instruction = table.reveal(vrf_identity(), &[]);
    instruction.accounts.truncate(1);
    let result = mollusk().process_instruction(&instruction, &[(vrf_identity(), wallet())]);
    // The runtime still reports this code as the deprecated `NotEnoughAccountKeys`, and a
    // program has no way to return `MissingAccount`, so it is checked as the program raised it.
    let error = result.raw_result.unwrap_err();
    assert_eq!(ProgramError::try_from(error), Ok(ProgramError::NotEnoughAccountKeys));
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
    for retired in [35u64, 36, 255, 1 << 40] {
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
    let vault = key(casino_core::ids::VAULT_PROGRAM.to_bytes());
    let (ledger, _) = Pubkey::find_program_address(&[b"ledger", jackpot.as_ref()], &vault);
    (jackpot, ledger)
}

fn ledger_holding(lamports: u64) -> Account {
    // The vault's layout: a 116-byte header, then slot 0 — the SOL mint, then its amount.
    let mut data = vec![0u8; 116 + 32 + 8];
    data[148..156].copy_from_slice(&lamports.to_le_bytes());
    let vault = key(casino_core::ids::VAULT_PROGRAM.to_bytes());
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
    assert_eq!(result.raw_result, Err(InstructionError::Custom(CoreError::InvalidPDA as u32)));
}


/// `FabricateCard` (33) in the build this file tests: refused outright without `devnet-debug`,
/// and with it, admin-gated and reaching the Magic CPI (absent here, so MissingAccount).
#[test]
#[ignore = "needs cargo build-sbf"]
fn fabricate_card_is_a_devnet_debug_build_s_alone() {
    let admin = key(casino_core::ids::OPS_KEY.to_bytes());
    let stranger = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let (card, _) = Pubkey::find_program_address(&[b"card", user.as_ref()], &program());
    let (house, _) = Pubkey::find_program_address(&[b"house"], &program());
    let vault = key(casino_core::magicblock::EPHEMERAL_VAULT_ID.to_bytes());
    let magic = key(casino_core::magicblock::MAGIC_PROGRAM_ID.to_bytes());
    let args = [user.to_bytes().as_slice(), &4u32.to_le_bytes(), &[1, 2, 3, 4]].concat();
    let ix = |signer: Pubkey| Instruction::new_with_bytes(program(), &input(33, &args), vec![
        AccountMeta::new_readonly(signer, true), AccountMeta::new(house, false), AccountMeta::new(card, false),
        AccountMeta::new(vault, false), AccountMeta::new_readonly(magic, false),
    ]);
    let accounts = |signer: Pubkey| vec![
        (signer, wallet()), (house, Account::new(1_000_000_000, 0, &program())), (card, Account::new(0, 0, &Pubkey::default())),
        (vault, Account::new(1, 0, &Pubkey::default())),
        (magic, Account { lamports: 1, data: vec![], owner: Pubkey::default(), executable: true, rent_epoch: 0 }),
    ];
    let result = mollusk().process_instruction(&ix(admin), &accounts(admin));
    if cfg!(feature = "devnet-debug") {
        // every gate passed: the Magic program is the one thing Mollusk cannot run
        assert_eq!(result.raw_result, Err(InstructionError::UnsupportedProgramId), "should reach the Magic CPI");
        let refused = mollusk().process_instruction(&ix(stranger), &accounts(stranger));
        assert_eq!(refused.raw_result, Err(InstructionError::MissingRequiredSignature));
    } else {
        assert_eq!(result.raw_result, Err(InstructionError::InvalidInstructionData));
    }
}

// HasPlayed (34): MagicBlock Quests' lookup. The quest verifier key alone gets an answer — success
// or NotPlayed; everyone else gets the same refusal whether the card exists or not.

fn verifier() -> Pubkey {
    key(scratch_cards::constants::QUEST_VERIFIER.to_bytes())
}

fn has_played(signer: Pubkey, signs: bool, card: Pubkey, wallet: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        program(),
        &input(34, &wallet.to_bytes()),
        vec![AccountMeta::new_readonly(signer, signs), AccountMeta::new_readonly(card, false)],
    )
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_verifier_learns_whether_a_wallet_has_a_card() {
    let table = Table::new();
    let ix = has_played(verifier(), true, table.card, table.user);
    let played = mollusk().process_instruction(&ix, &[(verifier(), wallet()), (table.card, table.card_account(CardStatus::Collected))]);
    assert_eq!(played.raw_result, Ok(()));
    println!("has_played, a card: {} CU", played.compute_units_consumed);

    let none = mollusk().process_instruction(&ix, &[(verifier(), wallet()), (table.card, Account::default())]);
    assert_eq!(none.raw_result, Err(InstructionError::Custom(scratch_cards::error::GameError::NotPlayed as u32)));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn anyone_else_is_refused_the_same_way_card_or_not() {
    let table = Table::new();
    let stranger = Pubkey::new_unique();
    for card in [table.card_account(CardStatus::Collected), Account::default()] {
        let ix = has_played(stranger, true, table.card, table.user);
        let result = mollusk().process_instruction(&ix, &[(stranger, wallet()), (table.card, card.clone())]);
        assert_eq!(result.raw_result, Err(InstructionError::Custom(CoreError::Unauthorized as u32)));

        // Naming the verifier without its signature is no better.
        let claimed = has_played(verifier(), false, table.card, table.user);
        let result = mollusk().process_instruction(&claimed, &[(verifier(), wallet()), (table.card, card)]);
        assert_eq!(result.raw_result, Err(InstructionError::MissingRequiredSignature));
    }
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_card_must_be_the_wallet_s_own() {
    let table = Table::new();
    let other = Table::new();
    let ix = has_played(verifier(), true, other.card, table.user);
    let result = mollusk().process_instruction(&ix, &[(verifier(), wallet()), (other.card, other.card_account(CardStatus::Collected))]);
    assert_eq!(result.raw_result, Err(InstructionError::Custom(CoreError::InvalidPDA as u32)));
}
