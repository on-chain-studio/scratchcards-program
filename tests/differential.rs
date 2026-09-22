//! Parity between two builds of this program, instruction by instruction.
//!
//! Every instruction is run on a baseline build and a candidate build from the same accounts, and
//! everything observable must match: the result, the log, the return data and every account
//! afterwards. Nothing here says what the right answer is — only that both builds give the same
//! one — so a rewrite is checked against the program it replaces rather than against a spec.
//!
//! The programs the game calls (vault, VRF, delegation, magic, permission, token) are all the
//! `cpi-recorder` fixture, which logs the exact bytes and account list of every call it gets. Two
//! builds that call out differently log differently. The system program is the real one.
//!
//! Each case runs as written and then mutated: each signer unsigned, the account list cut short,
//! each account swapped for a stranger, the arguments cut short, corrupted and padded.
//!
//!     scripts/parity.sh
//!
//! which builds the program and runs this against `tests/fixtures/baseline.so`, the deployed build
//! (see `tests/fixtures/README.md`). `BASELINE_SO` and `CANDIDATE_SO` name other builds to compare.
//!
//! Instruction data is written here as bytes, not through either build's types: it is the wire
//! format both have to honour.

use std::collections::BTreeMap;
use std::rc::Rc;

use mollusk_svm::program::{
    create_program_account_loader_v2, keyed_account_for_system_program, loader_keys::LOADER_V2,
};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_log_collector::LogCollector;
use solana_pubkey::Pubkey;

const RECORDER: &[u8] = include_bytes!("fixtures/cpi_recorder.so");

const PROGRAM: Pubkey = Pubkey::from_str_const("GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC");
const VAULT: Pubkey = Pubkey::from_str_const("VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV");
const VRF: Pubkey = Pubkey::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const PERMISSION: Pubkey = Pubkey::from_str_const("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TOKEN: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const DELEGATION: Pubkey = Pubkey::from_str_const("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC: Pubkey = Pubkey::from_str_const("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT: Pubkey = Pubkey::from_str_const("MagicContext1111111111111111111111111111111");
const EPHEMERAL_VAULT: Pubkey =
    Pubkey::from_str_const("MagicVau1t999999999999999999999999999999999");
const VAULT_AUTHORITY: Pubkey =
    Pubkey::from_str_const("341xevm3ejTyZCncco8UdEuiagcBbZQtJnEgsDDYBcgs");
const VRF_IDENTITY: Pubkey = Pubkey::from_str_const("9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw");
const ADMIN: Pubkey = Pubkey::from_str_const("691aFvKMnHXrMSgqk6G8izoCbVZTmkrRcu8xCeMKfPh1");
const SYSTEM: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");
const SLOT_HASHES: Pubkey = Pubkey::from_str_const("SysvarS1otHashes111111111111111111111111111");

const RECORDED: [Pubkey; 6] = [VAULT, VRF, PERMISSION, TOKEN, DELEGATION, MAGIC];

const SOL: u64 = 1_000_000_000;

// ---------------------------------------------------------------------------------------------
// Wire encoding

fn ix(discriminator: u64) -> Vec<u8> {
    discriminator.to_le_bytes().to_vec()
}

trait Wire {
    fn u8(self, v: u8) -> Self;
    fn u16(self, v: u16) -> Self;
    fn u32(self, v: u32) -> Self;
    fn u64(self, v: u64) -> Self;
    fn key(self, k: &Pubkey) -> Self;
    fn raw(self, b: &[u8]) -> Self;
    fn bytes(self, b: &[u8]) -> Self;
    fn nested(self, v: &[Vec<u8>]) -> Self;
}

impl Wire for Vec<u8> {
    fn u8(mut self, v: u8) -> Self {
        self.push(v);
        self
    }
    fn u16(mut self, v: u16) -> Self {
        self.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(mut self, v: u32) -> Self {
        self.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u64(mut self, v: u64) -> Self {
        self.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn key(mut self, k: &Pubkey) -> Self {
        self.extend_from_slice(k.as_ref());
        self
    }
    fn raw(mut self, b: &[u8]) -> Self {
        self.extend_from_slice(b);
        self
    }
    fn bytes(self, b: &[u8]) -> Self {
        self.u32(b.len() as u32).raw(b)
    }
    fn nested(self, v: &[Vec<u8>]) -> Self {
        v.iter().fold(self.u32(v.len() as u32), |w, b| w.bytes(b))
    }
}

// ---------------------------------------------------------------------------------------------
// Running a build

#[derive(Debug, PartialEq)]
struct Outcome {
    result: Result<(), InstructionError>,
    logs: Vec<String>,
    return_data: Vec<u8>,
    /// Every account the instruction was given, afterwards. Programs are left out: they are the
    /// builds themselves.
    accounts: Vec<(Pubkey, Account)>,
}

struct Build {
    mollusk: Mollusk,
    compute_units: u64,
    /// What the last run cost.
    last: u64,
}

impl Build {
    fn load(variable: &str, default: &str) -> Self {
        let path = std::env::var(variable)
            .unwrap_or_else(|_| format!("{}/{default}", env!("CARGO_MANIFEST_DIR")));
        let elf = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let mut mollusk = Mollusk::default();
        mollusk.add_program_with_elf_and_loader(&PROGRAM, &elf, &LOADER_V2);
        for id in RECORDED {
            mollusk.add_program_with_elf_and_loader(&id, RECORDER, &LOADER_V2);
        }
        Self { mollusk, compute_units: 0, last: 0 }
    }

    fn run(&mut self, instruction: &Instruction, world: &World) -> Outcome {
        let logger = LogCollector::new_ref_with_limit(None);
        self.mollusk.logger = Some(Rc::clone(&logger));
        let mut keys: Vec<Pubkey> = Vec::new();
        for meta in &instruction.accounts {
            if !keys.contains(&meta.pubkey) {
                keys.push(meta.pubkey);
            }
        }
        let accounts: Vec<(Pubkey, Account)> =
            keys.iter().map(|k| (*k, world.get(k))).collect();
        let result = self.mollusk.process_instruction(instruction, &accounts);
        self.compute_units += result.compute_units_consumed;
        self.last = result.compute_units_consumed;
        let logs = logger
            .borrow()
            .get_recorded_content()
            .iter()
            // The one thing two correct builds may disagree on.
            .filter(|line| !line.contains(" consumed "))
            .cloned()
            .collect();
        Outcome {
            result: result.raw_result,
            logs,
            return_data: result.return_data,
            accounts: result
                .resulting_accounts
                .into_iter()
                .filter(|(_, a)| !a.executable)
                .collect(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The world the instructions run against

#[derive(Clone, Default)]
struct World(BTreeMap<Pubkey, Account>);

impl World {
    fn get(&self, key: &Pubkey) -> Account {
        self.0.get(key).cloned().unwrap_or_default()
    }

    fn with(&self, key: Pubkey, account: Account) -> Self {
        let mut world = self.clone();
        world.0.insert(key, account);
        world
    }

    fn absorb(&mut self, accounts: &[(Pubkey, Account)]) {
        for (key, account) in accounts {
            self.0.insert(*key, account.clone());
        }
    }
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn wallet(lamports: u64) -> Account {
    Account::new(lamports, 0, &SYSTEM)
}

fn owned(data: Vec<u8>, owner: &Pubkey) -> Account {
    Account { lamports: SOL, data, owner: *owner, executable: false, rent_epoch: 0 }
}

/// A vault ledger holding `lamports` of SOL: a 116-byte header, then slot 0 — the all-zero mint
/// and its amount.
fn ledger_holding(lamports: u64) -> Account {
    let mut data = vec![0u8; 116 + 40];
    data[148..156].copy_from_slice(&lamports.to_le_bytes());
    owned(data, &VAULT)
}

struct Keys {
    user: Pubkey,
    consenter: Pubkey,
    stranger: Pubkey,
    config: Pubkey,
    house: Pubkey,
    jackpot: Pubkey,
    analytics: Pubkey,
    identity: Pubkey,
    card: Pubkey,
    house_ledger: Pubkey,
    jackpot_ledger: Pubkey,
    admin_ledger: Pubkey,
    receipt: Pubkey,
    analytics_permission: Pubkey,
    oracle_queue: Pubkey,
    fees_vault: Pubkey,
    reserve: Pubkey,
}

impl Keys {
    fn new() -> Self {
        let user = Pubkey::new_from_array([0x11; 32]);
        let consenter = Pubkey::new_from_array([0x22; 32]);
        let house = pda(&[b"house"], &PROGRAM);
        let jackpot = pda(&[b"jackpot"], &PROGRAM);
        let analytics = pda(&[b"analytics"], &PROGRAM);
        Self {
            user,
            consenter,
            stranger: Pubkey::new_from_array([0x33; 32]),
            config: pda(&[b"config"], &PROGRAM),
            house,
            jackpot,
            analytics,
            identity: pda(&[b"identity"], &PROGRAM),
            card: pda(&[b"card", user.as_ref()], &PROGRAM),
            house_ledger: pda(&[b"ledger", house.as_ref()], &VAULT),
            jackpot_ledger: pda(&[b"ledger", jackpot.as_ref()], &VAULT),
            admin_ledger: pda(&[b"ledger", ADMIN.as_ref()], &VAULT),
            receipt: pda(&[b"receipt", PROGRAM.as_ref(), consenter.as_ref()], &VAULT),
            analytics_permission: pda(&[b"permission:", analytics.as_ref()], &PERMISSION),
            oracle_queue: Pubkey::new_from_array([0x44; 32]),
            fees_vault: Pubkey::new_from_array([0x55; 32]),
            reserve: pda(&[b"vault"], &VAULT),
        }
    }

    /// A treasury by its `which`, with its ledger — the jackpot is 1, anything past it no treasury.
    fn treasury(&self, which: u8) -> (Pubkey, Pubkey) {
        match which {
            0 => (self.house, self.house_ledger),
            _ => (self.jackpot, self.jackpot_ledger),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The published sheet

/// The live sheet, as `scripts/setup-devnet.mjs` publishes it.
const SHEET: &str = include_str!("../tools/sheet/cards.json");

fn sheet() -> Vec<serde_json::Value> {
    serde_json::from_str(SHEET).unwrap()
}

/// A stand-in mint per token, so every pool entry is distinct; SOL is the all-zero mint.
fn mint(token: &str) -> [u8; 32] {
    if token == "SOL" {
        return [0; 32];
    }
    let mut mint = [0u8; 32];
    for (i, b) in token.bytes().enumerate() {
        mint[i % 32] ^= b;
    }
    mint[31] = 0x4D;
    mint
}

fn set_card(index: u8, card: &serde_json::Value) -> Vec<u8> {
    let n = |v: &serde_json::Value| v.as_u64().unwrap();
    let mode = match card["mode"].as_str().unwrap() { "count" => 0, _ => 1 };
    let roll = match card["roll"].as_str().unwrap() { "exclusive" => 0, _ => 1 };
    let role = |r: &str| match r { "plate" => 0u8, "number" => 1, "mark" => 2, _ => 3 };
    let mut data = ix(9)
        .u8(index)
        .u8(mode)
        .u8(roll)
        .u64(n(&card["priceLamports"]))
        .u32(n(&card["jackpotHitWeight"]) as u32)
        .u32(n(&card["jackpotNearWeight"]) as u32);
    for arg in card["modeArgs"].as_array().unwrap() {
        data = data.u16(n(arg) as u16);
    }
    let blocks = card["blocks"].as_array().unwrap();
    data = data.u32(blocks.len() as u32);
    for b in blocks {
        data = data
            .u8(role(b["role"].as_str().unwrap()))
            .u8(n(&b["count"]) as u8)
            .u8(n(&b["cols"]) as u8)
            .u8(n(&b["flags"]) as u8)
            .u16(n(&b["a"]) as u16)
            .u16(n(&b["b"]) as u16);
    }
    let pays = card["pays"].as_array().unwrap();
    data = data.u32(pays.len() as u32);
    for p in pays {
        data = data
            .u32(n(&p["scope"]) as u32)
            .u32(n(&p["weight"]) as u32)
            .u8(n(&p["min"]) as u8)
            .u8(n(&p["flags"]) as u8)
            .u16(n(&p["mult"]) as u16);
    }
    let tiers = card["tiers"].as_array().unwrap();
    data = data.u32(tiers.len() as u32);
    for t in tiers {
        data = data.u32(n(&t["factor"]) as u32).u32(n(&t["weight"]) as u32);
    }
    let pool = card["pool"].as_array().unwrap();
    data = data.u32(pool.len() as u32);
    for e in pool {
        data = data
            .raw(&mint(e["token"].as_str().unwrap()))
            .u64(n(&e["amount"]))
            .u32(n(&e["weight"]) as u32);
    }
    data
}

fn initialize(k: &Keys, count: u8) -> Instruction {
    Instruction::new_with_bytes(
        PROGRAM,
        &ix(1).u8(count),
        vec![
            AccountMeta::new(ADMIN, true),
            AccountMeta::new(k.config, false),
            AccountMeta::new(k.house, false),
            AccountMeta::new(k.jackpot, false),
            AccountMeta::new(k.analytics, false),
            AccountMeta::new(k.analytics_permission, false),
            AccountMeta::new_readonly(PERMISSION, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
    )
}

fn admin(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    let mut metas = vec![AccountMeta::new(ADMIN, true)];
    metas.extend(accounts);
    Instruction::new_with_bytes(PROGRAM, &data, metas)
}

fn publish(k: &Keys, index: u8, card: &serde_json::Value) -> Instruction {
    admin(
        set_card(index, card),
        vec![AccountMeta::new(k.config, false), AccountMeta::new_readonly(SYSTEM, false)],
    )
}

/// The programs, the admin and the players, and nothing of the game's yet.
fn bare_world() -> World {
    let mut world = World::default();
    for id in RECORDED.iter().chain([&PROGRAM]) {
        world.0.insert(*id, create_program_account_loader_v2(RECORDER));
    }
    let (system, system_account) = keyed_account_for_system_program();
    world.0.insert(system, system_account);
    let k = Keys::new();
    for key in [ADMIN, k.user, k.consenter, k.stranger, VAULT_AUTHORITY, VRF_IDENTITY] {
        world.0.insert(key, wallet(100 * SOL));
    }
    world
}

/// The live sheet, published by the baseline build's own `Initialize` and `SetCard`, plus ledgers
/// for the house, the pot and the admin.
fn world(baseline: &mut Build) -> World {
    let k = Keys::new();
    let mut world = bare_world();
    let sheet = sheet();
    let mut setup = vec![initialize(&k, sheet.len() as u8)];
    for (i, card) in sheet.iter().enumerate() {
        setup.push(publish(&k, i as u8, card));
    }
    for instruction in &setup {
        let outcome = baseline.run(instruction, &world);
        assert_eq!(outcome.result, Ok(()), "setup failed: {:?}", outcome.logs);
        world.absorb(&outcome.accounts);
    }
    world.0.insert(k.house_ledger, ledger_holding(50 * SOL));
    world.0.insert(k.jackpot_ledger, ledger_holding(7 * SOL));
    world.0.insert(k.admin_ledger, ledger_holding(0));
    world
}

const CARD_BYTES: usize = 992;

fn terms(world: &World, card_id: u64) -> Vec<u8> {
    let config = world.get(&Keys::new().config).data;
    let from = 56 + card_id as usize * CARD_BYTES;
    config[from..from + CARD_BYTES].to_vec()
}

/// A card someone bought, carrying its terms as the shelf holds them.
fn card(world: &World, card_id: u64, status: u64, seed: [u8; 32]) -> Account {
    let k = Keys::new();
    let data = Vec::new()
        .u64(3)
        .u64(1)
        .key(&k.user)
        .u64(card_id)
        .u64(status)
        .raw(&seed)
        .raw(&terms(world, card_id));
    owned(data, &PROGRAM)
}

const BOUGHT: u64 = 0;
const REQUESTED: u64 = 1;
const REVEALED: u64 = 2;

fn seed(n: u64) -> [u8; 32] {
    let mut seed = [0u8; 32];
    seed[..8].copy_from_slice(&n.to_le_bytes());
    seed[31] = 0x5E;
    seed
}

/// The first seeds this card deals a loss, a plain win and the jackpot on — found by the engine
/// both builds share, so every branch of a collect is reached.
fn seeds(world: &World, card_id: u64) -> Vec<(&'static str, [u8; 32])> {
    let card = scratch_engine::parse(&terms(world, card_id)).expect("a published card parses");
    let mut found: Vec<(&'static str, [u8; 32])> = Vec::new();
    for n in 0..200_000u64 {
        let s = seed(n);
        let Ok(w) = scratch_engine::evaluate(&card, &s) else { continue };
        let label = if w.jackpot {
            "a jackpot"
        } else if w.amounts.iter().any(|a| *a > 0) {
            "a win"
        } else {
            "a loss"
        };
        if !found.iter().any(|(l, _)| *l == label) {
            found.push((label, s));
        }
        if found.len() == 3 {
            break;
        }
    }
    found
}

// ---------------------------------------------------------------------------------------------
// The cases

struct Case {
    name: String,
    instruction: Instruction,
    world: World,
}

fn case(name: &str, instruction: Instruction, world: &World) -> Case {
    Case { name: name.into(), instruction, world: world.clone() }
}

fn cases(base: &World) -> Vec<Case> {
    let k = Keys::new();
    let fresh = bare_world();
    let sheet = sheet();
    let cards = sheet.len() as u64;
    let mut all = Vec::new();

    all.push(case("initialize fresh", initialize(&k, 4), &fresh));
    all.push(case("initialize again", initialize(&k, 2), base));
    all.push(case("initialize past capacity", initialize(&k, 9), base));

    let delegate = |seeds: &[Vec<u8>], pda_key: Pubkey| {
        admin(
            ix(2).nested(seeds).key(&k.stranger),
            vec![
                AccountMeta::new(pda_key, false),
                AccountMeta::new_readonly(PROGRAM, false),
                AccountMeta::new(pda(&[b"buffer", pda_key.as_ref()], &PROGRAM), false),
                AccountMeta::new(pda(&[b"delegation", pda_key.as_ref()], &DELEGATION), false),
                AccountMeta::new(pda(&[b"delegation-metadata", pda_key.as_ref()], &DELEGATION), false),
                AccountMeta::new_readonly(DELEGATION, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
        )
    };
    all.push(case("delegate house", delegate(&[b"house".to_vec()], k.house), base));
    all.push(case("delegate analytics", delegate(&[b"analytics".to_vec()], k.analytics), base));

    let undelegate = |tag: [u8; 8]| {
        Instruction::new_with_bytes(
            PROGRAM,
            &tag.to_vec().nested(&[b"house".to_vec()]),
            vec![
                AccountMeta::new(k.house, false),
                // The delegation program signs for the buffer when it calls back.
                AccountMeta::new(pda(&[b"buffer", k.house.as_ref()], &PROGRAM), true),
                AccountMeta::new(ADMIN, true),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
        )
    };
    let buffered = base
        .with(pda(&[b"buffer", k.house.as_ref()], &PROGRAM), owned(vec![7; 24], &DELEGATION))
        .with(k.house, wallet(SOL));
    all.push(case("undelegate by number", undelegate(3u64.to_le_bytes()), &buffered));
    all.push(case(
        "undelegate into an empty address",
        undelegate(3u64.to_le_bytes()),
        &buffered.with(k.house, Account::default()),
    ));
    all.push(case(
        "undelegate by the delegation program's tag",
        undelegate([196, 28, 41, 206, 48, 37, 51, 167]),
        &buffered,
    ));

    all.push(case(
        "request undelegation",
        admin(
            ix(4),
            vec![
                AccountMeta::new(k.house, false),
                AccountMeta::new(MAGIC_CONTEXT, false),
                AccountMeta::new_readonly(MAGIC, false),
                AccountMeta::new(k.fees_vault, false),
            ],
        ),
        base,
    ));

    all.push(case(
        "close card",
        admin(
            ix(7).key(&k.user),
            vec![
                AccountMeta::new(k.house, false),
                AccountMeta::new(k.card, false),
                AccountMeta::new(EPHEMERAL_VAULT, false),
                AccountMeta::new_readonly(MAGIC, false),
            ],
        ),
        &base.with(k.card, card(base, 0, REVEALED, seed(1))),
    ));

    for (i, c) in sheet.iter().enumerate() {
        all.push(case(&format!("set card {i} again"), publish(&k, i as u8, c), base));
    }
    all.push(case("set card past the shelf", publish(&k, 8, &sheet[0]), base));
    all.push(case("set card grows the shelf", publish(&k, 4, &sheet[1]), base));
    let mut nonsense = sheet[0].clone();
    nonsense["pool"][0]["weight"] = serde_json::json!(1);
    all.push(case("set card with a pool that does not add up", publish(&k, 0, &nonsense), base));

    for add in [0u16, 1, 4] {
        all.push(case(
            &format!("grow config by {add}"),
            admin(
                ix(26).u16(add),
                vec![AccountMeta::new(k.config, false), AccountMeta::new_readonly(SYSTEM, false)],
            ),
            base,
        ));
    }

    for which in [0u8, 1, 2] {
        let (treasury, ledger) = k.treasury(which);
        let permission = pda(&[b"permission:", ledger.as_ref()], &PERMISSION);
        all.push(case(
            &format!("open ledger {which}"),
            admin(
                ix(15).u8(which).u16(4),
                vec![
                    AccountMeta::new(treasury, false),
                    AccountMeta::new(ledger, false),
                    AccountMeta::new(permission, false),
                    AccountMeta::new_readonly(PERMISSION, false),
                    AccountMeta::new_readonly(VAULT, false),
                    AccountMeta::new_readonly(SYSTEM, false),
                ],
            ),
            base,
        ));
        all.push(case(
            &format!("delegate treasury {which}"),
            admin(
                ix(16).u8(which).key(&k.stranger),
                vec![
                    AccountMeta::new(treasury, false),
                    AccountMeta::new(pda(&[b"buffer", ledger.as_ref()], &VAULT), false),
                    AccountMeta::new(pda(&[b"delegation", ledger.as_ref()], &DELEGATION), false),
                    AccountMeta::new(pda(&[b"delegation-metadata", ledger.as_ref()], &DELEGATION), false),
                    AccountMeta::new(ledger, false),
                    AccountMeta::new_readonly(VAULT, false),
                    AccountMeta::new_readonly(DELEGATION, false),
                    AccountMeta::new_readonly(SYSTEM, false),
                ],
            ),
            base,
        ));
        all.push(case(
            &format!("undelegate treasury {which}"),
            admin(
                ix(30).u8(which),
                vec![
                    AccountMeta::new(treasury, false),
                    AccountMeta::new(ledger, false),
                    AccountMeta::new_readonly(VAULT, false),
                    AccountMeta::new_readonly(MAGIC, false),
                    AccountMeta::new(MAGIC_CONTEXT, false),
                    AccountMeta::new(k.fees_vault, false),
                ],
            ),
            base,
        ));
        all.push(case(
            &format!("close ledger {which} with token pairs"),
            admin(
                ix(18).u8(which),
                vec![
                    AccountMeta::new(treasury, false),
                    AccountMeta::new(ledger, false),
                    AccountMeta::new(k.reserve, false),
                    AccountMeta::new(permission, false),
                    AccountMeta::new_readonly(PERMISSION, false),
                    AccountMeta::new_readonly(VAULT, false),
                    AccountMeta::new_readonly(TOKEN, false),
                    AccountMeta::new_readonly(SYSTEM, false),
                    AccountMeta::new(Pubkey::new_from_array([0x61; 32]), false),
                    AccountMeta::new(Pubkey::new_from_array([0x62; 32]), false),
                ],
            ),
            base,
        ));
        all.push(case(
            &format!("authorize treasury {which}"),
            admin(
                ix(20).u8(which),
                vec![
                    AccountMeta::new(treasury, false),
                    AccountMeta::new(ledger, false),
                    AccountMeta::new_readonly(VAULT, false),
                ],
            ),
            base,
        ));
        for public in [0u8, 1] {
            all.push(case(
                &format!("set privacy {which} public={public}"),
                admin(
                    ix(22).u8(which).u8(public),
                    vec![
                        AccountMeta::new(treasury, false),
                        AccountMeta::new(ledger, false),
                        AccountMeta::new(permission, false),
                        AccountMeta::new_readonly(PERMISSION, false),
                        AccountMeta::new_readonly(VAULT, false),
                        AccountMeta::new_readonly(SYSTEM, false),
                    ],
                ),
                base,
            ));
        }
    }

    all.push(case(
        "withdraw house",
        admin(
            ix(17).key(&Pubkey::default()).u64(SOL),
            vec![
                AccountMeta::new(k.house, false),
                AccountMeta::new(k.house_ledger, false),
                AccountMeta::new(k.admin_ledger, false),
                AccountMeta::new_readonly(VAULT, false),
            ],
        ),
        base,
    ));

    let read_jackpot = |ledger: Pubkey| {
        Instruction::new_with_bytes(
            PROGRAM,
            &ix(21),
            vec![AccountMeta::new_readonly(k.jackpot, false), AccountMeta::new_readonly(ledger, false)],
        )
    };
    all.push(case("read the pot", read_jackpot(k.jackpot_ledger), base));
    all.push(case("read the pot off the house ledger", read_jackpot(k.house_ledger), base));

    let request_purchase = |card_id: u64| {
        Instruction::new_with_bytes(
            PROGRAM,
            &ix(24).u64(card_id),
            vec![
                AccountMeta::new_readonly(k.consenter, true),
                AccountMeta::new_readonly(k.user, false),
                AccountMeta::new_readonly(k.config, false),
                AccountMeta::new(k.house, false),
                AccountMeta::new(k.receipt, false),
                AccountMeta::new(EPHEMERAL_VAULT, false),
                AccountMeta::new_readonly(MAGIC, false),
                AccountMeta::new_readonly(VAULT, false),
                AccountMeta::new_readonly(k.jackpot, false),
                AccountMeta::new(k.house_ledger, false),
                AccountMeta::new(MAGIC_CONTEXT, false),
            ],
        )
    };
    for card_id in (0..cards).chain([cards, 99]) {
        all.push(case(&format!("buy card {card_id}"), request_purchase(card_id), base));
    }

    let resolve_purchase = |card_id: u64| {
        Instruction::new_with_bytes(
            PROGRAM,
            &ix(27).key(&k.user).u64(card_id),
            vec![
                AccountMeta::new_readonly(k.receipt, false),
                AccountMeta::new_readonly(VAULT_AUTHORITY, true),
                AccountMeta::new_readonly(k.config, false),
                AccountMeta::new(k.house, false),
                AccountMeta::new(k.card, false),
                AccountMeta::new(EPHEMERAL_VAULT, false),
                AccountMeta::new_readonly(MAGIC, false),
                AccountMeta::new(k.analytics, false),
            ],
        )
    };
    // Where the card will be: unclaimed, and the magic program's to create — see cpi-recorder.
    let unclaimed = base.with(k.card, Account::new(SOL, 0, &MAGIC));
    for card_id in 0..cards {
        all.push(case(&format!("resolve purchase of card {card_id}"), resolve_purchase(card_id), &unclaimed));
    }
    all.push(case("resolve purchase with a card live", resolve_purchase(0), &base.with(k.card, card(base, 0, BOUGHT, seed(0)))));
    all.push(case("resolve purchase of no card", resolve_purchase(99), &unclaimed));

    let request_reveal = Instruction::new_with_bytes(
        PROGRAM,
        &ix(28),
        vec![
            AccountMeta::new_readonly(k.user, false),
            AccountMeta::new(k.house, false),
            AccountMeta::new(k.card, false),
            AccountMeta::new_readonly(k.identity, false),
            AccountMeta::new(k.oracle_queue, false),
            AccountMeta::new_readonly(SLOT_HASHES, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(VRF, false),
        ],
    );
    for (label, status) in [("bought", BOUGHT), ("requested", REQUESTED), ("revealed", REVEALED)] {
        all.push(case(
            &format!("request reveal of a {label} card"),
            request_reveal.clone(),
            &base.with(k.card, card(base, 1, status, [0; 32])),
        ));
    }

    let callback = |extra: &[u8]| {
        Instruction::new_with_bytes(
            PROGRAM,
            &ix(12).raw(&[9; 32]).raw(extra),
            vec![AccountMeta::new_readonly(VRF_IDENTITY, true), AccountMeta::new(k.card, false)],
        )
    };
    let requested = base.with(k.card, card(base, 1, REQUESTED, [0; 32]));
    all.push(case("oracle answers", callback(&[]), &requested));
    all.push(case("oracle answers with extra bytes", callback(&[0xAA; 8]), &requested));
    all.push(case("oracle answers a revealed card", callback(&[]), &base.with(k.card, card(base, 1, REVEALED, seed(3)))));

    let request_collect = |signer: Pubkey| {
        Instruction::new_with_bytes(
            PROGRAM,
            &ix(25),
            vec![
                AccountMeta::new_readonly(k.user, false),
                AccountMeta::new_readonly(k.config, false),
                AccountMeta::new(k.house, false),
                AccountMeta::new(k.card, false),
                AccountMeta::new(pda(&[b"receipt", PROGRAM.as_ref(), signer.as_ref()], &VAULT), false),
                AccountMeta::new(EPHEMERAL_VAULT, false),
                AccountMeta::new_readonly(MAGIC, false),
                AccountMeta::new_readonly(VAULT, false),
                AccountMeta::new_readonly(k.jackpot, false),
                AccountMeta::new(k.jackpot_ledger, false),
                AccountMeta::new_readonly(signer, true),
                AccountMeta::new(k.house_ledger, false),
                AccountMeta::new(MAGIC_CONTEXT, false),
            ],
        )
    };
    let resolve_collect = |jackpot_paid: u64| {
        Instruction::new_with_bytes(
            PROGRAM,
            &ix(29).key(&k.user).u64(jackpot_paid),
            vec![
                AccountMeta::new_readonly(k.receipt, false),
                AccountMeta::new_readonly(VAULT_AUTHORITY, true),
                AccountMeta::new(k.house, false),
                AccountMeta::new(k.card, false),
                AccountMeta::new(EPHEMERAL_VAULT, false),
                AccountMeta::new_readonly(MAGIC, false),
                AccountMeta::new(k.analytics, false),
            ],
        )
    };
    for card_id in 0..cards {
        for (label, s) in seeds(base, card_id) {
            let world = base.with(k.card, card(base, card_id, REVEALED, s));
            all.push(case(&format!("collect {label} on card {card_id}"), request_collect(k.consenter), &world));
            all.push(case(&format!("collect {label} on card {card_id} by the player"), request_collect(k.user), &world));
            all.push(case(&format!("resolve collect of {label} on card {card_id}"), resolve_collect(0), &world));
            all.push(case(&format!("resolve collect of {label} on card {card_id}, pot paid"), resolve_collect(7 * SOL), &world));
        }
    }
    all.push(case(
        "collect before the reveal",
        request_collect(k.consenter),
        &base.with(k.card, card(base, 0, REQUESTED, seed(1))),
    ));

    for number in [0u64, 5, 6, 8, 10, 11, 13, 14, 19, 23, 31, 255, u64::MAX] {
        all.push(case(
            &format!("discriminator {number}"),
            Instruction::new_with_bytes(PROGRAM, &ix(number), vec![AccountMeta::new(ADMIN, true)]),
            base,
        ));
    }
    all.push(case("no instruction data", Instruction::new_with_bytes(PROGRAM, &[], vec![]), base));

    all
}

/// The case as written, then every way of getting it slightly wrong.
fn variants(case: &Case) -> Vec<(String, Instruction)> {
    let base = &case.instruction;
    let mut out = vec![("as written".to_string(), base.clone())];
    for (i, meta) in base.accounts.iter().enumerate() {
        if meta.is_signer {
            let mut v = base.clone();
            v.accounts[i].is_signer = false;
            out.push((format!("account {i} unsigned"), v));
        }
        let mut v = base.clone();
        v.accounts[i].pubkey = Pubkey::new_from_array([0xE0 | i as u8; 32]);
        out.push((format!("account {i} a stranger"), v));
    }
    for len in 0..base.accounts.len() {
        let mut v = base.clone();
        v.accounts.truncate(len);
        out.push((format!("only {len} accounts"), v));
    }
    if base.data.len() > 8 {
        let mut v = base.clone();
        v.data.truncate(8);
        out.push(("no arguments".into(), v));
        let mut v = base.clone();
        v.data.pop();
        out.push(("arguments cut short".into(), v));
        let mut v = base.clone();
        *v.data.last_mut().unwrap() ^= 0xFF;
        out.push(("last argument byte flipped".into(), v));
    }
    let mut v = base.clone();
    v.data.extend_from_slice(&[0xAB; 7]);
    out.push(("arguments padded".into(), v));
    out
}

#[test]
#[ignore = "needs cargo build-sbf; run scripts/parity.sh"]
fn both_builds_do_exactly_the_same() {
    let mut baseline = Build::load("BASELINE_SO", "tests/fixtures/baseline.so");
    let mut candidate = Build::load("CANDIDATE_SO", "target/deploy/scratch_cards.so");
    let base = world(&mut baseline);
    baseline.compute_units = 0;
    let cases = cases(&base);
    if std::env::var("COVERAGE").is_ok() {
        for case in &cases {
            let outcome = baseline.run(&case.instruction, &case.world);
            let calls = outcome.logs.iter().filter(|l| l.starts_with("Program data:")).count();
            println!("{:<48} {:?} ({calls} calls)", case.name, outcome.result);
        }
        baseline.compute_units = 0;
    }

    let mut runs = 0;
    let mut succeeded = 0;
    let mut differences = Vec::new();
    let report = std::env::var("CU_REPORT").is_ok();
    for case in &cases {
        for (variant, instruction) in variants(case) {
            let expected = baseline.run(&instruction, &case.world);
            let actual = candidate.run(&instruction, &case.world);
            if report && variant == "as written" {
                println!("CU {:<48} {:>8} {:>8}", case.name, baseline.last, candidate.last);
            }
            runs += 1;
            succeeded += usize::from(expected.result.is_ok());
            if expected != actual {
                differences.push(format!(
                    "{} / {variant}\n  baseline:  {:?}\n  candidate: {:?}",
                    case.name, expected, actual
                ));
            }
        }
    }

    println!(
        "{} cases, {runs} runs ({succeeded} succeeded on the baseline), {} differences",
        cases.len(),
        differences.len()
    );
    println!(
        "compute units: baseline {}, candidate {}",
        baseline.compute_units, candidate.compute_units
    );
    // DIFF_ALL prints every difference rather than the first few.
    let shown = if std::env::var("DIFF_ALL").is_ok() { usize::MAX } else { 5 };
    for difference in differences.iter().take(shown) {
        println!("\n{difference}");
    }
    assert!(differences.is_empty(), "{} runs differ", differences.len());
}
