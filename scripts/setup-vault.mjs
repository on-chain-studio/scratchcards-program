// Build, deploy and initialize the vault program. The scratch-app companion is setup-scratch.mjs.
//
//   node scripts/setup-vault.mjs
//
// Deploy reads the program keypair locally (never into this process). ProgramData is sized exact,
// so a build LARGER than the live one needs `solana program extend <program> <delta>` first.

import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';

const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const RPC = 'https://api.devnet.solana.com';
const VAULT_DIR = '/Users/tedosijses/projects/vault-program';
const SO = `${VAULT_DIR}/target/deploy/vault.so`;
const PROGRAM_KEYPAIR = `${VAULT_DIR}/target/deploy/vault-keypair.json`;
const IDL = `${VAULT_DIR}/vault-idl.json`;
const ADMIN_KEYPAIR = '/Users/tedosijses/projects/dark-galaxy/dark-galaxy-web/dev-keypair.json';
// Native programs can't take an IDL via `anchor idl init` (no IDL handler) — the Program Metadata
// program stores it instead, authorized by the upgrade authority. Vendored OUT of any project tree
// so npm can't hoist the install into (and clobber) a project's node_modules.
const PM_DIR = `${os.homedir()}/.scratch-cards-pmtool`;
const PM_BIN = `${PM_DIR}/node_modules/.bin/program-metadata`;

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR))));
const base = new Connection(RPC, 'confirmed');
const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const vaultPda = pda([Buffer.from('vault')], VAULT);
const anchorDisc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });

console.log('1. build');
execSync('cargo build-sbf', { cwd: VAULT_DIR, stdio: 'inherit' });

console.log('2. deploy');
// The program keypair signs an initial deploy and names the address on an upgrade; solana reads it
// locally. Admin is fee payer and upgrade authority.
execSync(
  `solana program deploy ${SO} --program-id ${PROGRAM_KEYPAIR} --keypair ${ADMIN_KEYPAIR} --url ${RPC}`,
  { stdio: 'inherit' });

console.log('3. initialize_vault (fund ["vault"] to its rent floor)');
const floor = await base.getMinimumBalanceForRentExemption(0);
const have = (await base.getAccountInfo(vaultPda))?.lamports ?? 0;
if (have >= floor) {
  console.log(`   ⏭  ${vaultPda.toBase58()} already at floor (${(have / 1e9).toFixed(6)} SOL)`);
} else {
  const ix = new TransactionInstruction({
    programId: VAULT,
    keys: [sg(admin.publicKey), rw(vaultPda), ro(SystemProgram.programId)],
    data: anchorDisc('initialize_vault'),
  });
  await sendAndConfirmTransaction(base, new Transaction().add(ix), [admin], { commitment: 'confirmed' });
  console.log(`   ✅ ${vaultPda.toBase58()} funded to floor`);
}

console.log('4. publish IDL (canonical program metadata)');
if (!fs.existsSync(PM_BIN)) {
  console.log('   installing program-metadata tool (one-time)…');
  fs.mkdirSync(PM_DIR, { recursive: true });
  // --prefix pins the install to PM_DIR; @solana/kit is a runtime peer, legacy-peer-deps unblocks it.
  execSync(`npm install --prefix ${PM_DIR} --legacy-peer-deps @solana-program/program-metadata@latest @solana/kit@^8`,
    { stdio: 'inherit' });
}
// `write` is create-or-update, authorized by the admin (the vault's upgrade authority).
execSync(`${PM_BIN} write idl ${VAULT} ${IDL} --keypair ${ADMIN_KEYPAIR} --rpc ${RPC} --format json`,
  { stdio: 'inherit' });

console.log('\ndone. next: node scripts/setup-scratch.mjs');
