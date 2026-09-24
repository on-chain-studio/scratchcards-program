// Reusable test wallets, so a test run costs devnet SOL once instead of every time.
//
// The harnesses used to `Keypair.generate()` per run and walk away, stranding the funding in
// a keypair nobody had saved. Isolation between runs is worth keeping, but it comes from
// closing the *ledgers* at the end — not from throwing the wallets away.
//
// Keypairs persist in ~/keys/scratch_test_wallets.json; balances are topped up only when short.

import fs from 'fs';
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { KEYS_DIR } from './net.mjs';

const STORE = `${KEYS_DIR}/scratch_test_wallets.json`;

/** Loads named wallets, creating any that don't exist yet. */
export function wallets(names) {
  const store = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};
  let dirty = false;
  const out = {};
  for (const name of names) {
    if (!store[name]) {
      store[name] = Array.from(Keypair.generate().secretKey);
      dirty = true;
    }
    out[name] = Keypair.fromSecretKey(new Uint8Array(store[name]));
  }
  if (dirty) fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
  return out;
}

/** Tops a wallet up to `target` lamports, and only if it is short. */
export async function topUp(conn, admin, wallet, target) {
  const have = await conn.getBalance(wallet.publicKey);
  if (have >= target) return 0;
  const need = target - have;
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: wallet.publicKey, lamports: need,
    })),
    [admin],
    { commitment: 'confirmed' },
  );
  return need;
}

/**
 * Returns everything above the rent floor to the admin. Called at the end of a run — and in
 * a `finally`, so a failed run does not strand the funding either.
 *
 * Leaves the rent-exempt minimum for a zero-data account (~890,880 lamports) plus a little
 * for fees. Sweeping below that makes the account non-rent-exempt, and the transfer will not
 * even simulate — which is how the earlier sweeps failed silently.
 */
export async function sweep(conn, admin, wallet, leave = 900_000) {
  const have = await conn.getBalance(wallet.publicKey);
  const fee = 5_000;
  if (have <= leave + fee) return 0;
  const amount = have - leave - fee;
  try {
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey, toPubkey: admin.publicKey, lamports: amount,
      })),
      [wallet],
      { commitment: 'confirmed' },
    );
    return amount;
  } catch (e) {
    // Never swallow this. A cleanup failure that reports success is how funds go missing
    // without anyone noticing — say so loudly and leave the balance where it can be found.
    console.log(`  ⚠ could not sweep ${wallet.publicKey.toBase58()}: ${String(e).split('\n')[0]}`);
    console.log(`    ${(have / 1e9).toFixed(6)} SOL left there — keys are in ${STORE}`);
    return 0;
  }
}

/** Sum of what a set of wallets currently holds — for reporting what a run cost. */
export async function totalHeld(conn, list) {
  let total = 0;
  for (const w of list) total += await conn.getBalance(w.publicKey);
  return total;
}
