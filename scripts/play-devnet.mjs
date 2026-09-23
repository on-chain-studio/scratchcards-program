// Plays real cards on devnet, end to end, against a rollup.
//
//   node scripts/play-devnet.mjs [cards]        default 3
//   node scripts/play-devnet.mjs 3 --close      undelegate, withdraw and close the ledger after
//   node scripts/play-devnet.mjs 1 --wallet     consent with the owner wallet instead of the
//                                               session key (masks client-only errors — avoid)
//   ROLLUP=tee node scripts/play-devnet.mjs     play on the private TEE instead of the public ER
//
// Scratching is client-side, so this does the parts that touch the chain: fund, delegate,
// buy, ask for the seed, wait for the VRF, collect. Buying and revealing are separate
// transactions on purpose — the reveal is permissionless and retryable, so a VRF request that
// fails cannot unwind a purchase that is already paid for.
//
// Plays as the dev key against a ledger that persists between runs: deposit only the
// shortfall, delegate only if not already delegated, leave it open for the next run.
// `--close` is the reclaim path — undelegate, withdraw everything, close the ledger.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { wallets } from './test-wallets.mjs';
import { teeToken } from './tee-auth.mjs';
import { decodeCard, decodeLedger } from './accounts.mjs';
import { loadCards } from './sheet.mjs';
import { BASENET, TEE, PUBLIC_ER } from './net.mjs';

/** Which rollup to play on — `ROLLUP=tee` for the private one. Development moved to the
 *  public ER while the TEE was serving a stale binary; it is meant to move back. */
const ROLLUP = process.env.ROLLUP === 'tee' ? TEE : PUBLIC_ER;
const PRIVATE = ROLLUP === TEE;

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const VRF_PROGRAM = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const VRF_EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const SLOT_HASHES = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const SOL_MINT = new PublicKey('11111111111111111111111111111111');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

/** The public devnet RPC rate-limits hard. A 429 is a wait, not a failure — retry every
 *  request, reads included, or a long setup run dies halfway through. */
const fetchRetrying = async (url, opts) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, opts);
    if (r.status === 403 && process.env.TRACE) {
      try { console.log('   403 on', JSON.parse(opts.body).method); } catch {}
    }
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return fetch(url, opts);
};

const base = new Connection(BASENET, { commitment: 'confirmed', fetch: fetchRetrying });

/** The private rollup refuses an unauthenticated caller; the public one has no token to take. */
const rollupUrl = async (signer) =>
  PRIVATE ? `${ROLLUP}?token=${await teeToken(signer)}` : ROLLUP;

const CARDS = Number(process.argv[2]) || 3;
const CLOSE = process.argv.includes('--close');
// Session-key consent is the default — it is the app's real path, so it catches errors the
// wallet-direct path (owner signs its own debits) silently passes. `--wallet` opts out.
const SESSION = !process.argv.includes('--wallet');

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const anchorDisc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const housePda = () => pda([Buffer.from('house')]);
const jackpotPda = () => pda([Buffer.from('jackpot')]);
const analyticsPda = () => pda([Buffer.from('analytics')]);
const configPda = () => pda([Buffer.from('config')]);
const identityPda = () => pda([Buffer.from('identity')]);
// One card per player — a second purchase is refused by the account already existing.
const cardPda = (user) => pda([Buffer.from('card'), user.toBuffer()]);
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const reservePda = () => pda([Buffer.from('vault')], VAULT);
const permPda = (a) => pda([Buffer.from('permission:'), a.toBuffer()], PERMISSION);
const ataOf = (o, m) => PublicKey.findProgramAddressSync(
  [o.toBuffer(), TOKEN.toBuffer(), m.toBuffer()], ATA_PROGRAM)[0];

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const bad = (m, e) => {
  fail++;
  console.log(`  ❌ ${m}\n     ${String(e)}`);
  if (e?.err) console.log('     err:', JSON.stringify(e.err));
  const logs = e?.transactionLogs || e?.logs || e?.transactionMessage && [] || [];
  for (const l of logs.slice(-12)) console.log(`       ${l}`);
  if (!logs.length && e?.signature) pending.push(e.signature);
  const m2 = String(e).match(/Transaction ([1-9A-HJ-NP-Za-km-z]{60,}) resulted/);
  if (m2) pending.push(m2[1]);
};
const pending = [];
/** The public devnet RPC rate-limits hard; a 429 is not a failure, just a wait. */
async function retry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e);
      if (!msg.includes('429') && !msg.includes('Too Many Requests')) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Never preflight against a rollup. Its simulate substitutes blockhashes and cannot be
 * trusted, and against a private one it is worse: the simulate reads every account in the
 * transaction, the rollup refuses to serve accounts the caller is not a member of, and a
 * perfectly valid transaction comes back as a flat `403 Access denied` with no logs, long
 * before the validator sees it. Execution has no such problem — the program reads those
 * accounts, not the caller.
 */
/**
 * A rollup advances its own block height independently of the basenet blockhash the client
 * signed with, so `sendAndConfirmTransaction` can hit its blockheight deadline and give up on
 * a transaction that landed perfectly well. Reporting that as a failure is worse than useless
 * here — it claims a card was not bought after the player has already paid for it. So on
 * expiry, ask the chain what actually happened rather than trusting the deadline.
 */
const send = (conn, ixs, signers) => retry(async () => {
  const tx = new Transaction().add(...ixs);
  try {
    return await sendAndConfirmTransaction(conn, tx, signers,
      { commitment: 'confirmed', skipPreflight: conn !== base });
  } catch (e) {
    const sig = e?.signature ?? String(e).match(/Signature ([1-9A-HJ-NP-Za-km-z]{60,}) has expired/)?.[1];
    if (!sig || !String(e).includes('block height exceeded')) throw e;
    for (let i = 0; i < 20; i++) {
      const { value } = await conn.getSignatureStatuses([sig]);
      const status = value?.[0];
      if (status?.err) throw Object.assign(new Error(`${sig} failed: ${JSON.stringify(status.err)}`), { err: status.err, signature: sig });
      if (status?.confirmationStatus) return sig;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw e;
  }
});

/**
 * A failed rollup transaction may have no logs to fetch afterwards — the TEE serves no
 * `getTransaction` at all. Subscriptions do work on both, so listen live and keep the last
 * burst rather than relying on being able to ask later.
 */
const logsBySig = new Map();
async function captureLogs(conn) {
  try {
    await conn.onLogs('all', (l) => {
      if (logsBySig.size > 500) logsBySig.clear();
      logsBySig.set(l.signature, l.logs ?? []);
    }, 'confirmed');
  } catch (e) { console.log('   (log capture unavailable:', String(e).split('\n')[0], ')'); }
}

/** Our transaction's logs, picked out of the rollup's general traffic by signature. */
const logsFor = (e) => {
  const sig = String(e).match(/Transaction ([1-9A-HJ-NP-Za-km-z]{80,90})/)?.[1];
  return (sig && logsBySig.get(sig)) || [];
};

// ── instructions ─────────────────────────────────────────────────────────────

const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const createAtaIdempotentIx = (payer, owner, mint) => new TransactionInstruction({
  programId: ATA_PROGRAM_ID,
  keys: [sg(payer), rw(ataOf(owner, mint)), ro(owner), ro(mint),
         ro(SystemProgram.programId), ro(TOKEN)],
  data: Buffer.from([1]),
});

const vaultDepositIx = (owner, mint, amount) => {
  const ledger = ledgerPda(owner);
  const isSol = mint.equals(SOL_MINT);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      sg(owner), rw(ledger), rw(permPda(ledger)), ro(PERMISSION), rw(reservePda()),
      isSol ? ro(SystemProgram.programId) : rw(ataOf(reservePda(), mint)),
      isSol ? ro(SystemProgram.programId) : rw(ataOf(owner, mint)),
      ro(TOKEN), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([anchorDisc('deposit'), mint.toBuffer(), u64(amount),
                         Buffer.from([0]), Buffer.from([0])]),
  });
};

const vaultWithdrawIx = (owner, mint, amount) => {
  const isSol = mint.equals(SOL_MINT);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      sg(owner), rw(ledgerPda(owner)), rw(reservePda()),
      isSol ? ro(SystemProgram.programId) : rw(ataOf(reservePda(), mint)),
      isSol ? ro(SystemProgram.programId) : rw(ataOf(owner, mint)),
      ro(TOKEN), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([anchorDisc('withdraw'), mint.toBuffer(), u64(amount)]),
  });
};

const delegateLedgerIx = (payer, owner, validator) => {
  const ledger = ledgerPda(owner);
  const b = (tag, prog) => PublicKey.findProgramAddressSync(
    [Buffer.from(tag), ledger.toBuffer()], prog)[0];
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      sg(payer), sgro(owner),
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger),
      ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([anchorDisc('delegate_ledger'), Buffer.from([1]), validator.toBuffer()]),
  });
};

const undelegateLedgerIx = (payer, owner) => new TransactionInstruction({
  programId: VAULT,
  keys: [sg(payer), sgro(owner), rw(ledgerPda(owner)), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT),
         rw(EPHEMERAL_VAULT)],
  data: anchorDisc('undelegate'),
});

const closeLedgerIx = (owner) => {
  const ledger = ledgerPda(owner);
  return new TransactionInstruction({
    programId: VAULT,
    // The rent comes back to whoever paid it, and they have to sign for it. A wallet funds
    // its own ledger — the vault refuses otherwise — so the player is both.
    keys: [sg(owner), sg(owner), rw(ledger), rw(reservePda()), rw(permPda(ledger)),
           ro(PERMISSION), ro(TOKEN), ro(SystemProgram.programId)],
    data: anchorDisc('close_ledger'),
  });
};

const receiptPda = (consenter) => PublicKey.findProgramAddressSync(
  [Buffer.from('receipt'), PROGRAM.toBuffer(), consenter.toBuffer()], VAULT)[0];
/** The vault's seedless authority. It signs every settle callback, and that signature is what
 *  proves to the game that the payment happened — the receipt is zeroed by then. */
const vaultAuthorityPda = () => PublicKey.findProgramAddressSync([], VAULT)[0];

/** RequestPurchase (24) — records what the player owes, and which card, in the receipt's
 *  args. No ledger, so the CPI is allowed. No card is created here. */
const requestPurchaseIx = (signer, user, cardId) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sgro(signer), ro(user), ro(configPda()), rw(housePda()), rw(receiptPda(signer)),
    rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT), ro(jackpotPda()),
    rw(ledgerPda(housePda())), rw(MAGIC_CONTEXT),
  ],
  data: Buffer.concat([header(24), u64(cardId)]),
});

/** assign_ledger_authorization — grants a session key consent over this ledger's debits.
 *  basenet only; the owner signs. */
const assignAuthorizationIx = (owner, authorized) => new TransactionInstruction({
  programId: VAULT,
  keys: [rw(ledgerPda(owner)), sgro(owner)],
  data: Buffer.concat([anchorDisc('assign_ledger_authorization'), authorized.toBuffer()]),
});

/** settle_receipt — top-level vault. Moves the balances, then calls back into the game
 *  inside the same instruction with the receipt intact. `extra` is forwarded to that
 *  callback after the receipt, which the vault prepends itself. */
const settleReceiptIx = (user, consenter, consenterSigns, ledgers, extra) =>
  new TransactionInstruction({
    programId: VAULT,
    keys: [
      rw(receiptPda(consenter)), ro(housePda()),
      { pubkey: consenter, isSigner: consenterSigns, isWritable: false },
      ro(PROGRAM), ro(vaultAuthorityPda()),
      rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT),
      // the receipt's ledgers, in index order, then whatever the callback needs
      ...ledgers.map(rw),
      ...extra,
    ],
    data: anchorDisc('settle_receipt'),
  });

/** Ledger order matches the owner list the receipt was created with. */
const purchaseLedgers = (user) => [ledgerPda(user), ledgerPda(housePda()), ledgerPda(jackpotPda())];
const collectLedgers = (user) => [ledgerPda(user), ledgerPda(housePda()), ledgerPda(jackpotPda())];

/** What ResolvePurchase (27) needs, after the receipt and vault authority the vault prepends.
 *  No VRF accounts: the seed is asked for separately by RequestReveal. */
const resolvePurchaseAccounts = (user) => [
  ro(configPda()), rw(housePda()), rw(cardPda(user)),
  rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), rw(analyticsPda()),
  rw(permPda(cardPda(user))), ro(PERMISSION),
];

/** RequestReveal (28) — asks the oracle for the seed. Permissionless and retryable, so it
 *  is split out of the payment: a failed VRF request cannot unwind a settled purchase. */
const requestRevealIx = (user) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    ro(user), rw(housePda()), rw(cardPda(user)),
    ro(identityPda()), rw(VRF_EPHEMERAL_QUEUE), ro(SLOT_HASHES),
    ro(SystemProgram.programId), ro(VRF_PROGRAM),
  ],
  data: header(28),
});

/** RequestCollect (25) — values the card and records what it owes. No *player* ledger
 *  touched; a won jackpot moves from its ledger to the house before it goes on the receipt. */
const requestCollectIx = (user, wallet = user) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    ro(user), ro(configPda()), rw(housePda()), rw(cardPda(user)), rw(receiptPda(wallet)),
    rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT),
    ro(jackpotPda()), ro(ledgerPda(jackpotPda())),
    sgro(wallet), rw(ledgerPda(housePda())), rw(MAGIC_CONTEXT),
  ],
  data: header(25),
});

/** What ResolveCollect (29) needs. A losing card arrives here on an empty receipt, exactly
 *  as a winning one does — there is no flag to get wrong. */
const resolveCollectAccounts = (user) => [
  rw(housePda()), rw(cardPda(user)), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM),
  rw(analyticsPda()),
];

// ── reads ────────────────────────────────────────────────────────────────────

const STATUS = ['bought', 'requested', 'revealed', 'collected'];

async function readCard(conn, user) {
  const i = await conn.getAccountInfo(cardPda(user));
  return i && decodeCard(i.data);
}

async function readLedger(conn, owner) {
  const i = await conn.getAccountInfo(ledgerPda(owner));
  const l = i && decodeLedger(i.data);
  return l && { sol: l.sol, balances: l.balances, cap: l.slots };
}

// One decoder per account type: the sheet module owns the config layout.
async function cardPrice(id) {
  const { cards } = await loadCards();
  return cards[id].priceLamports;
}

// ── the run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('program ', PROGRAM.toBase58());
  console.log('rollup  ', ROLLUP, PRIVATE ? '(private)' : '(public)');

  const player = admin;
  const price = await cardPrice(0);
  const stake = price * CARDS;
  console.log('player  ', player.publicKey.toBase58(), '(dev key)');
  console.log('card 0  ', (price / 1e9).toFixed(4), 'SOL ×', CARDS, 'cards\n');

  // TOKEN_AS lets us test whether the caller's identity matters at all, or only which
  // top-level program the transaction invokes. Only the private rollup authenticates.
  const tokenSigner = process.env.TOKEN_AS === 'admin' ? admin : player;
  const tee = new Connection(await rollupUrl(tokenSigner),
    { commitment: 'confirmed', fetch: fetchRetrying });
  if (PRIVATE && process.env.TOKEN_AS) console.log(`   (auth token signed by ${process.env.TOKEN_AS})`);
  await captureLogs(tee);

  // The app's path: a session key consents to buys. Persisted, so the assignment written
  // onto the ledger once stays valid across runs.
  const session = SESSION ? wallets(['session']).session : null;
  if (session) console.log(`session  ${session.publicKey.toBase58()} (persisted)\n`);

  // 1 ── the dev key's ledger persists between runs: top up, assign, delegate — only as needed
  console.log('1. ensure the ledger is funded and on the rollup');
  let ledgerStart = 0;
  try {
    const houseRec = await base.getAccountInfo(
      PublicKey.findProgramAddressSync(
        [Buffer.from('delegation'), ledgerPda(housePda()).toBuffer()], DELEGATION)[0]);
    const validator = houseRec ? new PublicKey(houseRec.data.subarray(8, 40)) : null;
    if (!validator) throw new Error('house ledger is not delegated — run setup-devnet.mjs');

    let onTee = (await base.getAccountInfo(ledgerPda(player.publicKey)))?.owner
      .equals(DELEGATION) ?? false;
    const info = await (onTee ? tee : base).getAccountInfo(ledgerPda(player.publicKey));
    const led = info && decodeLedger(info.data);
    ledgerStart = Number(led?.sol ?? 0n);
    const shortfall = Math.max(0, stake - ledgerStart);
    const needsAssign = !!session && !led?.authorized?.equals(session.publicKey);

    // Deposits and session assignment are basenet verbs, so a delegated ledger comes home
    // first — but only when it actually needs something.
    if ((shortfall || needsAssign) && onTee) {
      await send(tee, [undelegateLedgerIx(player.publicKey, player.publicKey)], [player]);
      for (let i = 0; i < 40; i++) {
        if ((await base.getAccountInfo(ledgerPda(player.publicKey)))?.owner.equals(VAULT)) {
          onTee = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (onTee) throw new Error('undelegation never landed on basenet');
      ok('undelegated to top up');
    }
    // Deposit, assignment and delegation are all basenet verbs against the same ledger, so
    // they ride one transaction — the app's deposit does the same. Nothing observes the
    // ledger funded-but-undelegated in between.
    const ixs = [];
    if (shortfall) ixs.push(vaultDepositIx(player.publicKey, SOL_MINT, shortfall));
    if (needsAssign) ixs.push(assignAuthorizationIx(player.publicKey, session.publicKey));
    if (!onTee) ixs.push(delegateLedgerIx(player.publicKey, player.publicKey, validator));
    if (ixs.length) {
      await send(base, ixs, [player]);
      if (shortfall) ok(`deposited ${(shortfall / 1e9).toFixed(4)} SOL (ledger had ${(ledgerStart / 1e9).toFixed(4)})`);
      if (needsAssign) ok('session key assigned on the ledger');
    }
    if (!onTee) {
      // Delegation completes on basenet, but the rollup has to observe and clone the account
      // before it is writable there. Buying immediately gets InvalidWritableAccount — the
      // account exists and is delegated, just not yet present on the validator.
      let live = false;
      for (let i = 0; i < 40; i++) {
        if (await tee.getAccountInfo(ledgerPda(player.publicKey))) { live = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!live) throw new Error('ledger never appeared in the rollup');
    }
    const l = await readLedger(tee, player.publicKey);
    ok(`ledger live in the rollup with ${(Number(l.sol) / 1e9).toFixed(4)} SOL`);
  } catch (e) { bad('ledger setup', e); return { player, tee, ledgerStart }; }

  // 2 ── play
  const played = [];
  for (let n = 0; n < CARDS; n++) {
    console.log(`\n2.${n + 1} buy card ${n + 1}/${CARDS}`);
    try {
      // A key nobody authorized must not be able to consent — the whole point of the
      // ledger's authorization. The reverted attempt leaves nothing behind.
      if (session && n === 0) {
        const stranger = Keypair.generate();
        let refused = true;
        try {
          await send(tee, [
            requestPurchaseIx(stranger.publicKey, player.publicKey, 0),
            settleReceiptIx(player.publicKey, stranger.publicKey, true,
                            purchaseLedgers(player.publicKey),
                            resolvePurchaseAccounts(player.publicKey)),
          ], [stranger]);
          refused = false;
        } catch { /* expected */ }
        if (!refused) throw new Error('a stranger key consented to a debit — refusal is broken');
        ok('stranger consent refused');
      }
      // Two instructions, one transaction: record the terms, then settle them. The card is
      // created by the callback inside the settle, from the card id the receipt carries — so
      // the card bought cannot differ from the card paid for.
      await send(tee, [
        requestPurchaseIx((session ?? player).publicKey, player.publicKey, 0),
        settleReceiptIx(player.publicKey, (session ?? player).publicKey, true,
                        purchaseLedgers(player.publicKey),
                        resolvePurchaseAccounts(player.publicKey)),
      ], [session ?? player]);

      ok(`bought — receipt settled, ${(price / 1e9).toFixed(4)} SOL to the house, card created`);

      // Its own transaction on purpose: permissionless and retryable, so a VRF request that
      // fails cannot unwind a purchase that is already paid for.
      await send(tee, [requestRevealIx(player.publicKey)], [player]);
      ok('reveal requested');

      let card = null;
      for (let i = 0; i < 40; i++) {
        card = await readCard(tee, player.publicKey);
        if (card?.status === 'revealed') break;
        await new Promise((r) => setTimeout(r, 750));
      }
      if (card?.status !== 'revealed') throw new Error(`seed never arrived (status ${card?.status})`);
      ok(`VRF answered — seed ${Buffer.from(card.seed).toString('hex').slice(0, 16)}…`);

      const before = await readLedger(tee, player.publicKey);
      // request → settle → collect. A losing card has no receipt, so the settle is skipped.
      // Same shape for the payout: the callback closes the card and the receipt.
      await send(tee, [
        requestCollectIx(player.publicKey),
        settleReceiptIx(player.publicKey, player.publicKey, true,
                        collectLedgers(player.publicKey),
                        resolveCollectAccounts(player.publicKey)),
      ], [player]);
      const after = await readLedger(tee, player.publicKey);
      const gone = await readCard(tee, player.publicKey);
      if (gone) throw new Error('card still exists after collect');

      const won = [];
      for (const [mint, amt] of Object.entries(after?.balances ?? {})) {
        const was = before?.balances?.[mint] ?? 0n;
        if (amt > was) won.push(`${amt - was} of ${mint.slice(0, 6)}…`);
      }
      // devnet pools pay SOL for every rung, so a SOL win says nothing about the jackpot
      const solDelta = Number((after?.sol ?? 0n) - (before?.sol ?? 0n));
      if (solDelta > 0) won.push(`${(solDelta / 1e9).toFixed(4)} SOL`);
      ok(won.length ? `collected: ${won.join(', ')}` : 'collected: no win — card closed');
      played.push(n);
    } catch (e) {
      bad(`card ${n + 1}`, e);
      for (const l of logsFor(e)) console.log('       ', l);
    }
  }

  // 3 ── what the session did
  console.log('\n3. session result');
  try {
    const l = await readLedger(tee, player.publicKey);
    const tokens = Object.entries(l?.balances ?? {}).filter(([m]) => m !== SOL_MINT.toBase58());
    console.log(`   SOL on ledger : ${(Number(l.sol) / 1e9).toFixed(6)}  (staked ${(stake / 1e9).toFixed(4)}, spent ${((price * played.length) / 1e9).toFixed(4)})`);
    console.log(`   tokens won    : ${tokens.length ? tokens.map(([m, a]) => `${a} ${m.slice(0, 6)}…`).join(', ') : 'none'}`);
    ok(`${played.length}/${CARDS} cards played through`);
  } catch (e) { bad('session result', e); }

  return { player, tee, ledgerStart };
}

/** The ledger persists between runs; `--close` is the reclaim path. */
async function teardown(ctx) {
  if (!ctx) return;
  const { player, tee } = ctx;
  if (!CLOSE) {
    try {
      const l = await readLedger(tee, player.publicKey);
      if (l) console.log(`\nledger left open with ${(Number(l.sol) / 1e9).toFixed(4)} SOL — reclaim with --close`);
    } catch { /* report only */ }
    return;
  }
  console.log('\n4. teardown (--close)');
  try {
    const owner = (await base.getAccountInfo(ledgerPda(player.publicKey)))?.owner;
    if (owner?.equals(DELEGATION)) {
      await send(tee, [undelegateLedgerIx(player.publicKey, player.publicKey)], [player]);
      for (let i = 0; i < 40; i++) {
        const o = (await base.getAccountInfo(ledgerPda(player.publicKey)))?.owner;
        if (o?.equals(VAULT)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      ok('ledger undelegated, state committed to basenet');
    }
    const l = await readLedger(base, player.publicKey);
    if (l) {
      if (l.sol > 0n) await send(base, [vaultWithdrawIx(player.publicKey, SOL_MINT, Number(l.sol))], [player]);
      // Token winnings have to come out too, or close_ledger refuses — it will not strand a
      // balance. Each needs the player's ATA to exist first.
      for (const [m, amt] of Object.entries(l.balances)) {
        if (m === SOL_MINT.toBase58()) continue;
        const mint = new PublicKey(m);
        try {
          await send(base, [
            createAtaIdempotentIx(player.publicKey, player.publicKey, mint),
            vaultWithdrawIx(player.publicKey, mint, Number(amt)),
          ], [player]);
        } catch (e) {
          console.log(`  ▫ could not withdraw ${amt} of ${m.slice(0, 8)}…: ${String(e).split('\n')[0]}`);
        }
      }
      try {
        await send(base, [closeLedgerIx(player.publicKey)], [player]);
        ok('ledger and permission closed, rent returned');
      } catch (e) {
        console.log(`  ▫ ledger left open: ${String(e).split('\n')[0]}`);
      }
    }
  } catch (e) {
    console.log(`  ⚠ teardown incomplete: ${String(e).split('\n')[0]}`);
  }
}

let ctx;
const before = await base.getBalance(admin.publicKey);
try {
  ctx = await main();
} catch (e) {
  console.error(e);
} finally {
  await teardown(ctx);
  const after = await base.getBalance(admin.publicKey);
  // The ledger is the dev key's own pocket, so what sits on it is held, not spent.
  let ledgerEnd = 0;
  if (ctx && !CLOSE) {
    try { ledgerEnd = Number((await readLedger(ctx.tee, admin.publicKey))?.sol ?? 0n); } catch {}
  }
  const cost = before + (ctx?.ledgerStart ?? 0) - after - ledgerEnd;
  console.log(`\n${pass} passed, ${fail} failed  |  run cost ${(cost / 1e9).toFixed(6)} SOL`);
  for (const sig of pending) {
    try {
      const conn = new Connection(await rollupUrl(wallets(['player']).player),
        { commitment: 'confirmed', fetch: fetchRetrying });
      const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      console.log(`\nlogs for ${sig.slice(0, 16)}…`);
      for (const l of tx?.meta?.logMessages ?? ['(none retained)']) console.log('   ', l);
    } catch (e) { console.log(`could not fetch logs: ${String(e).split('\n')[0]}`); }
  }
}
process.exit(fail ? 1 : 0);
