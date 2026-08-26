// Publishes the card sheet, plus — devnet only — the 0-decimal stand-in mints it references.
// House liquidity is a different job: acquire-float.mjs buys it, top-up.mjs moves it into the
// house ledger. (The treasury_ta era, where this script also provisioned per-mint payout
// accounts, ended with the receipts redesign — payouts settle ledger-to-ledger now.)
//
//   node scripts/setup-devnet.mjs                 full: mints if missing, then the sheet
//   node scripts/setup-devnet.mjs --cards-only    republish the sheet, touch nothing else
//   node scripts/setup-devnet.mjs --mainnet       real mints from prices.json
//
// Uses @solana/web3.js from the dark-galaxy-web node_modules (NODE_PATH), and the
// admin keypair the cluster picks (see net.mjs ADMIN_PATH).

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import { MAINNET, CLUSTER, MAGIC_RPC as RPC, MINTS as NET_MINTS, poolWeights } from './net.mjs';
const PROGRAM_ID = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const OUT = 'scripts/devnet.json';

// SPL stand-ins — 0 decimals on devnet so base units equal the printed whole numbers.
// SOL is not among them: it is native, it has no mint to create and no treasury account to
// fund, and its pool amounts are lamports rather than whole tokens.
const TOKENS = [
  'BONK', 'PENGU', 'MEW', 'WIF', 'PUMP', 'SKR',
  'POPCAT', 'JTO', 'FART', 'PYTH', 'RAY', 'JUP',
];

// The vault reads the all-zero mint as native SOL — it is what slot 0 of every ledger holds,
// and how the jackpot already pays out. A pool entry carrying it pays SOL from the house.
const SOL_MINT = new PublicKey('11111111111111111111111111111111');

/**
 * The sheet comes from `tools/sheet/cards.json`, which the balancing tool writes.
 *
 * It used to be a table maintained here by hand, with a second copy of every card's odds in the
 * app and a third in the engine. There is one now, and this script only translates it onto the
 * wire.
 */
const SHEET = JSON.parse(
  fs.readFileSync(new URL('../tools/sheet/cards.json', import.meta.url), 'utf8'),
);

/**
 * Amounts go on chain exactly as the sheet holds them.
 *
 * A prize is base units, and an SPL transfer moves base units — decimals are display metadata a
 * mint carries, nothing the program reads. Publishing the same integers devnet that mainnet will
 * hold is the whole point of rehearsing here: scale them down for the 0-decimal stand-ins and
 * devnet stops predicting mainnet, which is the one thing it is for.
 *
 * The consequence is that the devnet house needs the same base-unit depth a real one would.
 * That is top-up's job — these mints are ours and unlimited — not a reason to publish
 * different numbers.
 */
const ROLE = { plate: 0, number: 1, mark: 2, jackpot: 3 };
const MODE = { count: 0, compare: 1 };
const ROLL = { exclusive: 0, independent: 1 };

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(RPC, 'confirmed');

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

async function createMint(decimals = 0) {
  const mint = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(82);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey,
      lamports: rent, space: 82, programId: TOKEN_PROGRAM,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      // InitializeMint (0): decimals, mint authority, freeze option
      data: Buffer.concat([
        Buffer.from([0, decimals]), admin.publicKey.toBuffer(), Buffer.from([0]),
      ]),
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [admin, mint]);
  return mint.publicKey;
}


/** Initialize (1) — creates config + jackpot + analytics and declares the shelf size. */
function initializeIx() {
  const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
  const analytics = pda([Buffer.from('analytics')]);
  const permission = PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), analytics.toBuffer()], PERMISSION)[0];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda([Buffer.from('config')]), isSigner: false, isWritable: true },
      { pubkey: pda([Buffer.from('house')]), isSigner: false, isWritable: true },
      { pubkey: pda([Buffer.from('jackpot')]), isSigner: false, isWritable: true },
      { pubkey: analytics, isSigner: false, isWritable: true },
      { pubkey: permission, isSigner: false, isWritable: true },
      { pubkey: PERMISSION, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([header(1), Buffer.from([SHEET.length])]),
  });
}

/** SetCard (9) — one card of the sheet per transaction. */
function setCardIx(index, c, mints) {
  const vec = (items, encode) =>
    Buffer.concat([u32(items.length), ...items.map(encode)]);

  const parts = [
    header(9),
    Buffer.from([index, MODE[c.mode], ROLL[c.roll]]),
    u64(c.priceLamports),
    u32(c.jackpotHitWeight),
    u32(c.jackpotNearWeight),
    // a fixed-size array, so borsh writes it without a length
    ...c.modeArgs.map(u16),
    vec(c.blocks, (b) =>
      Buffer.concat([
        Buffer.from([ROLE[b.role], b.count, b.cols, b.flags]),
        u16(b.a), u16(b.b),
      ])),
    vec(c.pays, (p) =>
      Buffer.concat([u32(p.scope), u32(p.weight), Buffer.from([p.min, p.flags]), u16(p.mult)])),
    vec(c.tiers, (t) => Buffer.concat([u32(t.factor), u32(t.weight)])),
    (() => {
      if (!MAINNET && !c.pool.some((p) => p.token === 'SOL')) {
        throw new Error(`${c.id}: no SOL rung to carry the devnet pool`);
      }
      const weights = poolWeights(c.pool);
      return vec(c.pool, (e, i) => {
        const mint = e.token === 'SOL' ? SOL_MINT : mints[e.token];
        if (!mint) throw new Error(`no ${CLUSTER} mint for ${e.token}`);
        return Buffer.concat([mint.toBuffer(), u64(e.amount), u32(weights[i])]);
      });
    })(),
  ];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda([Buffer.from('config')]), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat(parts),
  });
}

const send = (ixs, signers = [admin]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers);

async function main() {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT)) : { mints: {} };
  const mints = {};
  if (MAINNET) {
    // The real mints, recorded off chain by fetch-prices.mjs. Nothing is ever created here.
    for (const t of TOKENS) {
      if (!NET_MINTS[t]) throw new Error(`no mainnet mint for ${t} in scripts/prices.json`);
      mints[t] = new PublicKey(NET_MINTS[t]);
    }
  } else for (const t of TOKENS) {
    if (existing.mints[t]) { mints[t] = new PublicKey(existing.mints[t]); continue; }
    if (process.argv.includes('--cards-only')) throw new Error(`no mint for ${t} in ${OUT}`);
    mints[t] = await createMint(0);
    console.log(`mint ${t} = ${mints[t].toBase58()}`);
    existing.mints[t] = mints[t].toBase58();
    fs.writeFileSync(OUT, JSON.stringify(existing, null, 2));
  }

  // The sheet alone: prices, chances and pools live in config, which set_card rewrites in
  // place — mints and initialize are creation-time work and stay untouched. House liquidity
  // is a different job entirely: acquire-float.mjs buys it, top-up.mjs moves it.
  if (process.argv.includes('--cards-only')) {
    console.log('writing the card sheet…');
    for (let i = 0; i < SHEET.length; i++) {
      console.log(`  card ${SHEET[i].id}:`, await send([setCardIx(i, SHEET[i], mints)]));
    }

  /**
   * A retired slot must not keep selling its old card: `card_count` never shrinks, so any
   * on-chain slot past the sheet is overwritten with a copy of the last card. The app's shelf
   * stops before it, and anyone buying the index directly just buys the same card twice over.
   */
  const cfgInfo = await conn.getAccountInfo(pda([Buffer.from('config')]));
  const published = cfgInfo ? Number(cfgInfo.data.readBigUInt64LE(48)) : SHEET.length;
  for (let i = SHEET.length; i < published; i++) {
    console.log(`  slot ${i} retired (rewritten as ${SHEET[SHEET.length - 1].id}):`,
      await send([setCardIx(i, SHEET[SHEET.length - 1], mints)]));
  }
    return;
  }

  console.log('writing the card sheet…');
  console.log('  initialize:', await send([initializeIx()]));
  for (let i = 0; i < SHEET.length; i++) {
    console.log(`  card ${SHEET[i].id}:`, await send([setCardIx(i, SHEET[i], mints)]));
  }

  /**
   * A retired slot must not keep selling its old card: `card_count` never shrinks, so any
   * on-chain slot past the sheet is overwritten with a copy of the last card. The app's shelf
   * stops before it, and anyone buying the index directly just buys the same card twice over.
   */
  const cfgInfo = await conn.getAccountInfo(pda([Buffer.from('config')]));
  const published = cfgInfo ? Number(cfgInfo.data.readBigUInt64LE(48)) : SHEET.length;
  for (let i = SHEET.length; i < published; i++) {
    console.log(`  slot ${i} retired (rewritten as ${SHEET[SHEET.length - 1].id}):`,
      await send([setCardIx(i, SHEET[SHEET.length - 1], mints)]));
  }

  // The mint record is devnet's alone — mainnet mints live in prices.json already.
  if (!MAINNET) {
    existing.config = pda([Buffer.from('config')]).toBase58();
    existing.jackpot = pda([Buffer.from('jackpot')]).toBase58();
    fs.writeFileSync(OUT, JSON.stringify(existing, null, 2));
    console.log('done →', OUT);
  } else console.log('done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
