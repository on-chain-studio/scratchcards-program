// Buys the config account room for more cards.
//
// The shelf has no card ceiling — the account holds as many as it has bytes for, and this
// adds bytes. The runtime caps growth per instruction, so a big jump is sent as several
// instructions in separate transactions rather than one.
//
//   node scripts/grow-shelf.mjs            # report capacity and what it costs to add one
//   node scripts/grow-shelf.mjs 4          # make room for 4 more cards
//
// Rent is real and unrecoverable while the account lives, so this never rounds up "to be
// safe": it grows by exactly what you ask for.

import fs from 'fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { BASENET as RPC, ADMIN_PATH as NET_ADMIN } from './net.mjs';

const PROGRAM_ID = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const ADMIN_PATH = process.env.ADMIN_KEYPAIR ?? NET_ADMIN;

// Mirrors src/state/config.rs. The layout test in tests/layout.rs pins these on the Rust side.
const HEADER = 8 + 8 + 32 + 8;
const CARD = 7 * 8 + 10 * (32 + 8 + 24);
const MAX_PERMITTED_DATA_INCREASE = 10 * 1024;
const CARDS_PER_STEP = Math.floor(MAX_PERMITTED_DATA_INCREASE / CARD);

const sizeFor = (cards) => HEADER + cards * CARD;
const minBalance = (space) => (space + 128) * 6960;

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(RPC, 'confirmed');
const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const header = (variant) => {
  const b = Buffer.alloc(8);
  b.writeUInt8(variant, 0);
  return b;
};

/** GrowConfig (26) */
const growIx = (addCards) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([header(26), u16(addCards)]),
});

const main = async () => {
  const info = await conn.getAccountInfo(configPda);
  if (!info) throw new Error('no config on chain — run scripts/setup-devnet.mjs first');

  const capacity = Math.floor((info.data.length - HEADER) / CARD);
  const published = Number(info.data.readBigUInt64LE(48));
  const add = Number(process.argv[2] ?? 0);

  console.log(`config   ${configPda.toBase58()}`);
  console.log(`size     ${info.data.length} bytes — room for ${capacity}, ${published} published`);
  console.log(`a card   ${CARD} bytes, ${(minBalance(CARD) / 1e9).toFixed(6)} SOL of rent`);

  if (!add) {
    console.log(`\nnothing to do. pass a number of cards to add, e.g. \`node ${process.argv[1].split('/').pop()} 3\``);
    return;
  }

  const cost = minBalance(sizeFor(capacity + add)) - info.lamports;
  console.log(`\ngrowing  ${capacity} → ${capacity + add} cards` +
    (cost > 0 ? `, topping up ${(cost / 1e9).toFixed(6)} SOL of rent` : ', already rent-exempt'));

  // The runtime refuses to grow an account by more than 10KiB in one instruction, so a
  // large jump goes out as several transactions.
  let left = add;
  while (left > 0) {
    const step = Math.min(left, CARDS_PER_STEP);
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(growIx(step)), [admin],
    );
    console.log(`  +${step} card${step > 1 ? 's' : ''}  ${sig}`);
    left -= step;
  }

  const after = await conn.getAccountInfo(configPda);
  const now = Math.floor((after.data.length - HEADER) / CARD);
  console.log(`\nroom for ${now} cards (${after.data.length} bytes)`);
};

main().catch((e) => { console.error(e); process.exit(1); });
