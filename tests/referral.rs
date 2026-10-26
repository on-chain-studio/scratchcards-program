//! Referrals on the built program: a sale naming a code schedules the link, a linked sale the
//! credit; the house's tasks link, credit and pay, and a card from before referrals grows to the
//! layout unlinked. The
//! Magic program and the vault are stand-ins that record what they are asked.
//!
//!     cargo build-sbf && cargo test --test referral -- --ignored --nocapture

use std::cell::RefCell;

use bytemuck::Zeroable;
use casino_core::referral::{self, Counters, Referral};
use mollusk_svm::program::{create_keyed_account_for_builtin_program, Builtin};
use mollusk_svm::Mollusk;
use solana_account::{Account, ReadableAccount};
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_program_runtime::declare_process_instruction;
use solana_program_runtime::invoke_context::BuiltinFunctionRegisterer;
use solana_program_runtime::solana_sbpf::program::BuiltinFunctionDefinition;
use solana_pubkey::Pubkey;

use scratch_cards::state::analytics::{self, Analytics};
use scratch_cards::state::card::{self, Card, CardStatus};
use scratch_cards::state::config::{self, CardConfig};

const SOL: u64 = 1_000_000_000;
const PRICE: u64 = 2_000_000;

fn key(b: [u8; 32]) -> Pubkey { Pubkey::new_from_array(b) }
fn fixed(k: casino_core::chain::Pubkey) -> Pubkey { key(k.to_bytes()) }
fn core_key(k: Pubkey) -> casino_core::chain::Pubkey { casino_core::chain::Pubkey::new_from_array(k.to_bytes()) }
fn program() -> Pubkey { key(scratch_cards::ID.to_bytes()) }
fn pda(seeds: &[&[u8]]) -> Pubkey { Pubkey::find_program_address(seeds, &program()).0 }
fn magic() -> Pubkey { fixed(casino_core::ids::MAGIC_PROGRAM_ID) }
fn vault() -> Pubkey { fixed(casino_core::ids::VAULT_PROGRAM) }
fn magic_context() -> Pubkey { fixed(casino_core::ids::MAGIC_CONTEXT_ID) }
fn wallet() -> Account { Account { lamports: SOL, ..Account::default() } }
fn owned(data: Vec<u8>) -> Account { Account { lamports: SOL, data, owner: program(), executable: false, rent_epoch: 0 } }
fn builtin(id: Pubkey, name: &str) -> Account { create_keyed_account_for_builtin_program(&id, name).1 }
fn core(e: casino_core::CoreError) -> Result<(), InstructionError> { Err(InstructionError::Custom(e as u32)) }

thread_local! {
    static CALLS: RefCell<Vec<(Pubkey, Vec<u8>)>> = const { RefCell::new(Vec::new()) };
}

fn record(target: Pubkey, data: &[u8]) { CALLS.with(|c| c.borrow_mut().push((target, data.to_vec()))); }

/// The tag of every call the Magic stand-in took: 12 create, 13 resize, 6 schedule a task.
fn magic_calls() -> Vec<u32> {
    CALLS.with(|c| c.borrow().iter().filter(|(p, _)| *p == magic()).map(|(_, d)| u32::from_le_bytes(d[..4].try_into().unwrap())).collect())
}

fn calls_to(target: Pubkey) -> Vec<Vec<u8>> {
    CALLS.with(|c| c.borrow().iter().filter(|(p, _)| *p == target).map(|(_, d)| d.clone()).collect())
}

declare_process_instruction!(FakeMagic, 150, |invoke_context| {
    let transaction = &invoke_context.transaction_context;
    let context = transaction.get_current_instruction_context()?;
    let data = context.get_instruction_data().to_vec();
    record(magic(), &data);
    let tag = u32::from_le_bytes(data[..4].try_into().unwrap());
    let size = || u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
    match tag {
        12 => {
            let mut ephemeral = context.try_borrow_instruction_account(1)?;
            ephemeral.set_data_length(size())?;
            ephemeral.set_owner(program().as_ref())?;
        }
        13 => {
            let index = context.get_index_of_instruction_account_in_transaction(1)?;
            let mut ephemeral = transaction.accounts().try_borrow_mut(index)?;
            let mut grown = ephemeral.data().to_vec();
            grown.resize(size(), 0);
            ephemeral.set_data_from_slice(&grown);
        }
        _ => {}
    }
    Ok(())
});

declare_process_instruction!(FakeVault, 150, |invoke_context| {
    let context = invoke_context.transaction_context.get_current_instruction_context()?;
    record(vault(), context.get_instruction_data());
    Ok(())
});

fn with_stand_ins() -> Mollusk {
    CALLS.with(|c| c.borrow_mut().clear());
    let mut m = Mollusk::new(&program(), "scratch_cards");
    let fakes: [(Pubkey, &'static str, BuiltinFunctionRegisterer); 2] =
        [(magic(), "fake_magic", FakeMagic::register), (vault(), "fake_vault", FakeVault::register)];
    for (program_id, name, register_fn) in fakes {
        m.program_cache.add_builtin(Builtin { program_id, name, register_fn });
    }
    m
}

/// A shelf with one v3 card at `PRICE`.
fn shelf() -> Account {
    let mut header = casino_core::shelf::Header::zeroed();
    header.discriminator = config::DISCRIMINATOR;
    header.version = config::VERSION;
    header.count = 1;
    let mut terms = CardConfig::zeroed();
    terms.price_lamports = PRICE;
    let mut data = bytemuck::bytes_of(&header).to_vec();
    data.extend_from_slice(bytemuck::bytes_of(&terms));
    owned(data)
}

fn books(grown: bool) -> Account {
    let mut a = Analytics::zeroed();
    a.discriminator = analytics::DISCRIMINATOR;
    a.version = analytics::VERSION;
    let mut data = bytemuck::bytes_of(&a).to_vec();
    if grown {
        data.resize(Analytics::REFERRALS_SIZE, 0);
    }
    owned(data)
}

struct Player {
    user: Pubkey,
    card: Pubkey,
}

impl Player {
    fn new() -> Self {
        let user = Pubkey::new_unique();
        Self { user, card: pda(&[b"card", user.as_ref()]) }
    }

    fn permission(&self) -> Pubkey {
        fixed(casino_core::permission::address(&core_key(self.card)))
    }

    /// The card's permission naming everyone a purchase asks for, so nothing is called to add them.
    fn full_permission(&self) -> Account {
        let read = casino_core::magicblock::MEMBER_READ;
        let mut data = vec![0u8, 255];
        data.extend_from_slice(self.card.as_ref());
        data.push(1);
        for (flags, member) in [
            (0, program()),
            (read, vault()),
            (read, self.user),
            (read, fixed(scratch_cards::constants::PRIVATE_CASINO)),
        ] {
            data.push(flags);
            data.extend_from_slice(member.as_ref());
        }
        Account { lamports: SOL, data, owner: fixed(casino_core::ids::PERMISSION_PROGRAM), executable: false, rent_epoch: 0 }
    }

    /// A collected card at `size` — the layout before referrals, or the current one with `section`.
    fn card_at(&self, size: usize, generation: u64, section: Option<Referral>) -> Account {
        let mut c = Card::zeroed();
        c.discriminator = card::DISCRIMINATOR;
        c.version = card::VERSION;
        c.user = self.user.to_bytes();
        c.status = CardStatus::Collected as u64;
        let mut data = bytemuck::bytes_of(&c).to_vec();
        let mut terms = CardConfig::zeroed();
        terms.price_lamports = PRICE;
        data.extend_from_slice(bytemuck::bytes_of(&terms));
        data.extend_from_slice(&generation.to_le_bytes());
        if let Some(section) = section {
            data.extend_from_slice(bytemuck::bytes_of(&section));
        }
        assert_eq!(data.len(), size);
        owned(data)
    }

    fn section_after(&self, accounts: &[(Pubkey, Account)]) -> Referral {
        let data = &accounts.iter().find(|(k, _)| *k == self.card).unwrap().1.data;
        assert_eq!(data.len(), Card::REFERRED_SIZE);
        Referral::read(data, Card::PERSISTENT_SIZE).expect("a referral section")
    }
}

fn no_card() -> Account { Account { lamports: 0, data: vec![], owner: magic(), executable: false, rent_epoch: 0 } }

fn counters_after(accounts: &[(Pubkey, Account)]) -> Counters {
    let data = &accounts.iter().find(|(k, _)| *k == pda(&[b"analytics"])).unwrap().1.data;
    *bytemuck::from_bytes(&data[Analytics::SIZE..Analytics::REFERRALS_SIZE])
}

/// The vault's settle callback for a sale of card 0, naming `referrer` if any, with `rest` after.
fn resolve_purchase(player: &Player, referrer: Option<Pubkey>, rest: &[Pubkey]) -> Instruction {
    let mut data = 27u64.to_le_bytes().to_vec();
    data.extend_from_slice(player.user.as_ref());
    data.extend_from_slice(&0u64.to_le_bytes());
    if let Some(r) = referrer {
        data.extend_from_slice(r.as_ref());
    }
    let mut accounts = vec![
        AccountMeta::new_readonly(Pubkey::new_unique(), false),
        AccountMeta::new_readonly(fixed(casino_core::ids::VAULT_AUTHORITY), true),
        AccountMeta::new_readonly(pda(&[b"config"]), false),
        AccountMeta::new(pda(&[b"house"]), false),
        AccountMeta::new(player.card, false),
        AccountMeta::new(fixed(casino_core::ids::EPHEMERAL_VAULT_ID), false),
        AccountMeta::new_readonly(magic(), false),
        AccountMeta::new(pda(&[b"analytics"]), false),
        AccountMeta::new(player.permission(), false),
        AccountMeta::new_readonly(fixed(casino_core::ids::PERMISSION_PROGRAM), false),
    ];
    accounts.extend(rest.iter().map(|k| AccountMeta::new(*k, false)));
    Instruction::new_with_bytes(program(), &data, accounts)
}

fn sale_accounts(ix: &Instruction, player: &Player, card: Account, grown_books: bool) -> Vec<(Pubkey, Account)> {
    let k = |i: usize| ix.accounts[i].pubkey;
    let mut accounts = vec![
        (k(0), wallet()),
        (k(1), wallet()),
        (k(2), shelf()),
        (k(3), owned(vec![])),
        (k(4), card),
        (k(5), wallet()),
        (k(6), builtin(magic(), "fake_magic")),
        (k(7), books(grown_books)),
        (k(8), player.full_permission()),
        (k(9), wallet()),
    ];
    accounts.extend(ix.accounts[10..].iter().map(|m| (m.pubkey, wallet())));
    accounts
}

/// Whether the Magic stand-in was asked to schedule a task carrying `bytes`.
fn scheduled(bytes: &[u8]) -> bool {
    calls_to(magic()).iter().any(|d| d[..4] == 6u32.to_le_bytes() && d.windows(bytes.len()).any(|w| w == bytes))
}

fn link_data(amount: u64, generation: u64) -> Vec<u8> {
    let mut data = scratch_cards::ScratchCardsInstruction::LINK_REFERRAL.to_le_bytes().to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&generation.to_le_bytes());
    data
}

fn credit_data(amount: u64) -> Vec<u8> {
    let mut data = scratch_cards::ScratchCardsInstruction::CREDIT_REFERRAL.to_le_bytes().to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

fn linked(account: Pubkey, since: i64) -> Referral {
    Referral { referrer: account.to_bytes(), since, ..Referral::unlinked() }
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_first_card_naming_a_code_schedules_the_link_and_links_nothing_yet() {
    let player = Player::new();
    let code = Pubkey::new_unique();
    let ix = resolve_purchase(&player, Some(code), &[magic_context()]);
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, no_card(), true));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![12, 6], "created, then the link scheduled");
    assert_eq!(calls_to(magic())[0][4..8], (Card::REFERRED_SIZE as u32).to_le_bytes());
    assert!(scheduled(&link_data(PRICE / 100, 1)) && scheduled(code.as_ref()));
    assert_eq!(player.section_after(&result.resulting_accounts).referrer(), None);
    assert_eq!(counters_after(&result.resulting_accounts), Counters { players_unreferred: 1, ..Counters::default() });
    println!("resolve_purchase, naming a code: {} CU", result.compute_units_consumed);
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn an_unreferred_sale_is_as_before_and_counted() {
    let player = Player::new();
    let ix = resolve_purchase(&player, None, &[]);
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, no_card(), true));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![12]);
    assert_eq!(player.section_after(&result.resulting_accounts).referrer(), None);
    assert_eq!(counters_after(&result.resulting_accounts).players_unreferred, 1);
    println!("resolve_purchase, an unreferred card: {} CU", result.compute_units_consumed);
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_code_naming_the_player_s_own_card_is_not_worth_a_task() {
    let player = Player::new();
    let ix = resolve_purchase(&player, Some(player.card), &[magic_context()]);
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, no_card(), true));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![12]);
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_sale_naming_a_code_without_the_magic_context_is_refused() {
    let player = Player::new();
    let ix = resolve_purchase(&player, Some(Pubkey::new_unique()), &[]);
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, no_card(), true));
    #[allow(deprecated)]
    let missing = InstructionError::NotEnoughAccountKeys;
    assert_eq!(result.raw_result, Err(missing));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_card_from_before_referrals_grows_unlinked_and_may_link() {
    let player = Player::new();
    let ix = resolve_purchase(&player, Some(Pubkey::new_unique()), &[magic_context()]);
    let before = player.card_at(Card::PERSISTENT_SIZE, 4, None);
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, before, true));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![13, 6], "grown in place, then the link scheduled");
    assert!(scheduled(&link_data(PRICE / 100, 5)));
    assert_eq!(player.section_after(&result.resulting_accounts).referrer(), None);
    assert_eq!(counters_after(&result.resulting_accounts), Counters { players_unreferred: 1, ..Counters::default() });
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_linked_card_s_next_sale_credits_its_link_whatever_code_it_names() {
    let player = Player::new();
    let referrer = Player::new();
    let section = linked(referrer.card, 9);
    let ix = resolve_purchase(&player, Some(Pubkey::new_unique()), &[magic_context()]);
    let before = player.card_at(Card::REFERRED_SIZE, 2, Some(section));
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, before, true));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![6]);
    assert!(scheduled(&credit_data(PRICE / 100)) && scheduled(referrer.card.as_ref()));
    assert!(!scheduled(&link_data(PRICE / 100, 3)));
    assert_eq!(player.section_after(&result.resulting_accounts), section);
    assert_eq!(counters_after(&result.resulting_accounts), Counters::default());
    println!("resolve_purchase, a linked card: {} CU", result.compute_units_consumed);
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn books_not_grown_yet_never_stop_a_sale() {
    let player = Player::new();
    let ix = resolve_purchase(&player, Some(Pubkey::new_unique()), &[magic_context()]);
    let result = with_stand_ins().process_instruction(&ix, &sale_accounts(&ix, &player, no_card(), false));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![12, 6]);
}

fn as_test(ix: casino_core::chain::Instruction) -> Instruction {
    Instruction::new_with_bytes(
        program(),
        &ix.data,
        ix.accounts.iter().map(|m| AccountMeta { pubkey: fixed(m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable }).collect(),
    )
}

fn owed_card(player: &Player, owed: u64) -> Account {
    let section = Referral { owed, earned: owed, ..Referral::unlinked() };
    player.card_at(Card::REFERRED_SIZE, 3, Some(section))
}

fn credit_accounts(ix: &Instruction, card: Account) -> Vec<(Pubkey, Account)> {
    let k = |i: usize| ix.accounts[i].pubkey;
    vec![
        (k(0), wallet()), (k(1), owned(vec![])), (k(2), card), (k(3), books(true)),
        (k(4), wallet()), (k(5), builtin(magic(), "fake_magic")),
    ]
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_referrer_s_card_from_before_referrals_is_grown_by_its_first_credit() {
    let referrer = Player::new();
    let ix = as_test(referral::credit_instruction(
        &core_key(program()), &core_key(pda(&[b"house"])), &core_key(referrer.card), &scratch_cards::constants::ANALYTICS,
        scratch_cards::ScratchCardsInstruction::CREDIT_REFERRAL, 1_000, None,
    ));
    let result = with_stand_ins().process_instruction(&ix, &credit_accounts(&ix, referrer.card_at(Card::PERSISTENT_SIZE, 4, None)));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![13], "grown in place");
    let section = referrer.section_after(&result.resulting_accounts);
    assert_eq!((section.referrer(), section.owed, section.earned), (None, 1_000, 1_000));
    assert_eq!(counters_after(&result.resulting_accounts), Counters { players_unreferred: 1, owed: 1_000, earned: 1_000, ..Counters::default() });
    println!("credit_referral, growing the card: {} CU", result.compute_units_consumed);
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_house_s_credit_adds_to_what_the_referrer_is_owed() {
    let referrer = Player::new();
    let ix = as_test(referral::credit_instruction(
        &core_key(program()), &core_key(pda(&[b"house"])), &core_key(referrer.card), &scratch_cards::constants::ANALYTICS,
        scratch_cards::ScratchCardsInstruction::CREDIT_REFERRAL, referral::cut(PRICE), None,
    ));
    let accounts = |ix: &Instruction| credit_accounts(ix, owed_card(&referrer, 50));
    let result = with_stand_ins().process_instruction(&ix, &accounts(&ix));
    assert_eq!(result.raw_result, Ok(()));
    let section = referrer.section_after(&result.resulting_accounts);
    assert_eq!((section.owed, section.earned), (50 + PRICE / 100, 50 + PRICE / 100));
    assert_eq!(counters_after(&result.resulting_accounts), Counters { owed: PRICE / 100, earned: PRICE / 100, ..Counters::default() });
    println!("credit_referral: {} CU", result.compute_units_consumed);

    let mut stranger = ix.clone();
    stranger.accounts[0].pubkey = Pubkey::new_unique();
    let result = with_stand_ins().process_instruction(&stranger, &accounts(&stranger));
    assert_eq!(result.raw_result, core(casino_core::CoreError::Unauthorized));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn anyone_may_claim_and_the_house_pays_what_is_owed_once() {
    let player = Player::new();
    let claim = Instruction::new_with_bytes(program(), &36u64.to_le_bytes(), vec![
        AccountMeta::new_readonly(Pubkey::new_unique(), true),
        AccountMeta::new_readonly(player.user, false),
        AccountMeta::new(pda(&[b"house"]), false),
        AccountMeta::new_readonly(player.card, false),
        AccountMeta::new(magic_context(), false),
        AccountMeta::new_readonly(magic(), false),
    ]);
    let claim_accounts = |owed| {
        let k = |i: usize| claim.accounts[i].pubkey;
        vec![(k(0), wallet()), (k(1), wallet()), (k(2), owned(vec![])), (k(3), owed_card(&player, owed)), (k(4), wallet()), (k(5), builtin(magic(), "fake_magic"))]
    };
    let result = with_stand_ins().process_instruction(&claim, &claim_accounts(700));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![6]);
    let result = with_stand_ins().process_instruction(&claim, &claim_accounts(0));
    assert_eq!(result.raw_result, core(casino_core::CoreError::NothingToCollect));

    let pay = as_test(referral::pay_instruction(
        &core_key(program()), &core_key(pda(&[b"house"])), &core_key(player.card), &core_key(player.user),
        &scratch_cards::constants::ANALYTICS, scratch_cards::ScratchCardsInstruction::PAY_REFERRAL,
    ));
    let mut owed_books = books(true);
    bytemuck::from_bytes_mut::<Counters>(&mut owed_books.data[Analytics::SIZE..]).owed = 700;
    let k = |i: usize| pay.accounts[i].pubkey;
    let mut accounts = vec![
        (k(0), wallet()), (k(1), owned(vec![])), (k(2), wallet()), (k(3), owed_card(&player, 700)),
        (k(4), wallet()), (k(5), builtin(vault(), "fake_vault")), (k(6), owed_books),
    ];
    let result = with_stand_ins().process_instruction(&pay, &accounts);
    assert_eq!(result.raw_result, Ok(()));
    let settles = calls_to(vault());
    assert_eq!(settles.len(), 1);
    assert_eq!(u64::from_le_bytes(settles[0][settles[0].len() - 8..].try_into().unwrap()), 700);
    let section = player.section_after(&result.resulting_accounts);
    assert_eq!((section.owed, section.earned), (0, 700));
    assert_eq!(counters_after(&result.resulting_accounts).owed, 0);
    println!("pay_referral: {} CU", result.compute_units_consumed);

    accounts[3].1 = owed_card(&player, 0);
    let result = with_stand_ins().process_instruction(&pay, &accounts);
    assert_eq!(result.raw_result, Ok(()));
    assert!(calls_to(vault()).is_empty(), "nothing owed, nothing paid");
}

#[test]
fn the_analytics_constant_is_its_derivation() {
    assert_eq!(fixed(scratch_cards::constants::ANALYTICS), pda(&[b"analytics"]));
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn a_card_still_owed_is_not_closed_until_it_is_paid() {
    let player = Player::new();
    let mut data = 7u64.to_le_bytes().to_vec();
    data.extend_from_slice(player.user.as_ref());
    let ix = Instruction::new_with_bytes(program(), &data, vec![
        AccountMeta::new_readonly(fixed(casino_core::ids::OPS_KEY), true),
        AccountMeta::new(pda(&[b"house"]), false),
        AccountMeta::new(player.card, false),
        AccountMeta::new(fixed(casino_core::ids::EPHEMERAL_VAULT_ID), false),
        AccountMeta::new_readonly(magic(), false),
    ]);
    let k = |i: usize| ix.accounts[i].pubkey;
    let accounts = |owed| vec![(k(0), wallet()), (k(1), owned(vec![])), (k(2), owed_card(&player, owed)), (k(3), wallet()), (k(4), builtin(magic(), "fake_magic"))];
    let result = with_stand_ins().process_instruction(&ix, &accounts(700));
    assert_eq!(result.raw_result, Err(InstructionError::Custom(scratch_cards::error::GameError::StillOwed as u32)));
    assert!(magic_calls().is_empty());
    let result = with_stand_ins().process_instruction(&ix, &accounts(0));
    assert_eq!(result.raw_result, Ok(()));
}

fn link_task(code: Pubkey, player: &Player, amount: u64) -> Instruction {
    as_test(referral::link_instruction(
        &core_key(program()), &core_key(pda(&[b"house"])), &core_key(code), &core_key(player.card),
        scratch_cards::ScratchCardsInstruction::LINK_REFERRAL, amount, 3,
    ))
}

fn link_accounts(ix: &Instruction, code: Account, card: Account) -> Vec<(Pubkey, Account)> {
    let k = |i: usize| ix.accounts[i].pubkey;
    vec![(k(0), wallet()), (k(1), owned(vec![])), (k(2), code), (k(3), card), (k(4), wallet()), (k(5), builtin(magic(), "fake_magic"))]
}

/// Any account holding a wallet at the owner's place: another game's, here a stranger program's.
fn foreign_code(owner: Pubkey) -> Account {
    let mut data = vec![7u8; 96];
    data[referral::OWNER_AT..referral::OWNER_AT + 32].copy_from_slice(owner.as_ref());
    Account { lamports: SOL, data, owner: Pubkey::new_unique(), executable: false, rent_epoch: 0 }
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_link_task_finds_the_code_owner_s_card_here_and_schedules_the_linking_credit() {
    let player = Player::new();
    let referrer = Player::new();
    let code = Pubkey::new_unique();
    let ix = link_task(code, &player, 500);
    let card = player.card_at(Card::REFERRED_SIZE, 3, Some(Referral::unlinked()));
    let result = with_stand_ins().process_instruction(&ix, &link_accounts(&ix, foreign_code(referrer.user), card));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(magic_calls(), vec![6]);
    assert!(scheduled(&credit_data(500)) && scheduled(referrer.card.as_ref()) && scheduled(player.card.as_ref()));
    println!("link_referral: {} CU", result.compute_units_consumed);

    let card = || player.card_at(Card::REFERRED_SIZE, 3, Some(Referral::unlinked()));
    for code in [foreign_code(player.user), foreign_code(Pubkey::default()), wallet()] {
        let result = with_stand_ins().process_instruction(&ix, &link_accounts(&ix, code, card()));
        assert_eq!(result.raw_result, Ok(()));
        assert!(magic_calls().is_empty(), "the player, no one, or nothing at all links nothing");
    }

    let mut stranger = ix.clone();
    stranger.accounts[0].pubkey = Pubkey::new_unique();
    let result = with_stand_ins().process_instruction(&stranger, &link_accounts(&stranger, foreign_code(referrer.user), card()));
    assert_eq!(result.raw_result, core(casino_core::CoreError::Unauthorized));
}

fn linking_credit(referrer: &Player, player: &Player, amount: u64) -> Instruction {
    as_test(referral::credit_instruction(
        &core_key(program()), &core_key(pda(&[b"house"])), &core_key(referrer.card), &scratch_cards::constants::ANALYTICS,
        scratch_cards::ScratchCardsInstruction::CREDIT_REFERRAL, amount, Some(&core_key(player.card)),
    ))
}

fn linking_accounts(ix: &Instruction, referrer_card: Account, player_card: Account) -> Vec<(Pubkey, Account)> {
    let mut accounts = credit_accounts(ix, referrer_card);
    let mut unreferred = books(true);
    bytemuck::from_bytes_mut::<Counters>(&mut unreferred.data[Analytics::SIZE..]).players_unreferred = 1;
    accounts[3].1 = unreferred;
    accounts.push((ix.accounts[6].pubkey, player_card));
    accounts
}

fn section_of(accounts: &[(Pubkey, Account)], card: Pubkey) -> Referral {
    let data = &accounts.iter().find(|(k, _)| *k == card).unwrap().1.data;
    Referral::read(data, Card::PERSISTENT_SIZE).unwrap()
}

#[test]
#[ignore = "needs cargo build-sbf"]
fn the_linking_credit_links_only_to_a_card_that_exists_then_credits_it() {
    let player = Player::new();
    let referrer = Player::new();
    let ix = linking_credit(&referrer, &player, 500);
    let unlinked = || player.card_at(Card::REFERRED_SIZE, 3, Some(Referral::unlinked()));

    let result = with_stand_ins().process_instruction(&ix, &linking_accounts(&ix, owed_card(&referrer, 0), unlinked()));
    assert_eq!(result.raw_result, Ok(()));
    let link = section_of(&result.resulting_accounts, player.card);
    assert_eq!(link.referrer, referrer.card.to_bytes());
    assert_eq!(section_of(&result.resulting_accounts, referrer.card).owed, 500);
    assert_eq!(counters_after(&result.resulting_accounts),
        Counters { players_referred: 1, players_unreferred: 0, owed: 500, earned: 500 });
    println!("credit_referral, linking: {} CU", result.compute_units_consumed);

    let result = with_stand_ins().process_instruction(&ix, &linking_accounts(&ix, no_card(), unlinked()));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(section_of(&result.resulting_accounts, player.card).referrer(), None, "no card, no link");
    assert_eq!(counters_after(&result.resulting_accounts).players_referred, 0);

    let elsewhere = player.card_at(Card::REFERRED_SIZE, 3, Some(linked(Pubkey::new_unique(), 4)));
    let result = with_stand_ins().process_instruction(&ix, &linking_accounts(&ix, owed_card(&referrer, 0), elsewhere));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(section_of(&result.resulting_accounts, referrer.card).owed, 0, "linked to someone else since");

    let already = player.card_at(Card::REFERRED_SIZE, 3, Some(linked(referrer.card, 4)));
    let result = with_stand_ins().process_instruction(&ix, &linking_accounts(&ix, owed_card(&referrer, 0), already));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(section_of(&result.resulting_accounts, player.card).since, 4);
    assert_eq!(section_of(&result.resulting_accounts, referrer.card).owed, 500, "linked to it before: credited once");

    let at_no_cut = linking_credit(&referrer, &player, 0);
    let result = with_stand_ins().process_instruction(&at_no_cut, &linking_accounts(&at_no_cut, owed_card(&referrer, 0), unlinked()));
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(section_of(&result.resulting_accounts, player.card).referrer, referrer.card.to_bytes());
    assert_eq!(section_of(&result.resulting_accounts, referrer.card).earned, 0);
}
