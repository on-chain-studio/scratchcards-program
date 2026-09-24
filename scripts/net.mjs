// Which chain a script run talks to: devnet, unless --mainnet is on the command line — real
// money never by default. The flag is consumed here (spliced out of argv) so positional
// arguments keep their places in scripts that read argv by index.
//
//   node scripts/<script>.mjs [args] --mainnet
//
// Endpoints switch; program ids and rollup validator identities do not — the TEE (MTEW…) and
// public ER (MAS1…) each report the same identity on both clusters, verified via getIdentity.

import fs from 'fs';
import os from 'os';

const flag = process.argv.indexOf('--mainnet');
if (flag !== -1) process.argv.splice(flag, 1);

export const MAINNET = flag !== -1;
export const CLUSTER = MAINNET ? 'mainnet' : 'devnet';

export const BASENET = MAINNET ? 'https://api.mainnet-beta.solana.com'
                               : 'https://api.devnet.solana.com';
// MagicBlock's hosted base-chain RPC gateway — NOT their smart router: a delegated account
// read here shows the delegation-program owner, the same as any plain base RPC.
export const MAGIC_RPC = MAINNET ? 'https://rpc.magicblock.app/mainnet'
                                 : 'https://rpc.magicblock.app/devnet';
export const TEE = MAINNET ? 'https://mainnet-tee.magicblock.app'
                           : 'https://devnet-tee.magicblock.app';
export const PUBLIC_ER = MAINNET ? 'https://mainnet.magicblock.app'
                                 : 'https://devnet.magicblock.app';

/** The keypair scripts sign and pay with: the dev key, or the mainnet ops key. Both are in the
 *  program's ADMIN_PUBKEYS, so either passes the admin gate — this only decides whose funds move. */
export const KEYS_DIR = process.env.KEYS_DIR ?? `${os.homedir()}/keys`;
export const ADMIN_PATH = MAINNET ? `${KEYS_DIR}/casino_admin.json` : `${KEYS_DIR}/dev.json`;

/**
 * token key → mint: the devnet stand-ins, or the real mints fetch-prices.mjs read off mainnet.
 * Wrapped SOL (prices.json lists it) is dropped — native SOL is the all-zero mint everywhere
 * and never looked up here.
 */
export const MINTS = (() => {
  const here = (f) => new URL(f, import.meta.url);
  if (!MAINNET) return JSON.parse(fs.readFileSync(here('devnet.json'), 'utf8')).mints;
  const { SOL, ...spl } = JSON.parse(fs.readFileSync(here('prices.json'), 'utf8'))._mints;
  return spl;
})();

/**
 * Pool weights as published on this cluster. Mainnet takes the sheet's own; devnet is SOL-only
 * — sales replenish SOL, so the house needs no token float and no mints. The pool must
 * partition 2^32 exactly and a single u32 cannot hold that, so the SOL rung carries 2^32 − 1
 * and the first token rung the leftover 1 (a once-per-4.3-billion-draws hit, never funded).
 */
export const poolWeights = (pool) => {
  if (MAINNET) return pool.map((e) => e.weight);
  const firstToken = pool.findIndex((e) => e.token !== 'SOL');
  return pool.map((e, i) => (e.token === 'SOL' ? 4294967295 : i === firstToken ? 1 : 0));
};

if (MAINNET) console.log('■ MAINNET — real funds\n');
