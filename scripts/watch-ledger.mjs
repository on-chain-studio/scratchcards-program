/**
 * Watches one ledger on basenet and says, with timestamps, the moment it changes hands.
 *
 * Ground truth for "is the chain slow, or are we slow to notice it?": run this beside the
 * client, undelegate, and compare when this prints the owner change with when the client
 * stops waiting.
 *
 *   node scripts/watch-ledger.mjs                 # list the ledgers currently delegated
 *   node scripts/watch-ledger.mjs <wallet|pda>    # watch one
 */
import { Connection, PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';

const RPC = 'https://solana-rpc.publicnode.com';
const WS = 'wss://solana-rpc.publicnode.com';

const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const LEDGER_DISCRIMINATOR = '8DiEB2worzb';

const name = (owner) =>
  owner === VAULT.toBase58() ? 'VAULT (home)'
    : owner === DELEGATION.toBase58() ? 'DELEGATION (in a session)'
      : owner;

const stamp = () => new Date().toISOString().slice(11, 23);

const conn = new Connection(RPC, 'confirmed');

const ledgerPda = (wallet) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('ledger'), new PublicKey(wallet).toBuffer()], VAULT)[0];

const arg = process.argv[2];

if (!arg) {
  for (const program of [DELEGATION, VAULT]) {
    let found;
    try {
      found = await conn.getProgramAccounts(program, {
        filters: [{ memcmp: { offset: 0, bytes: LEDGER_DISCRIMINATOR } }],
      });
    } catch (e) {
      // An endpoint that refuses indexed reads must say so: "0 ledgers" would read as an
      // answer about the chain when it is an answer about the endpoint.
      console.log(`\n${name(program.toBase58())} — cannot list: ${e.message.slice(0, 120)}`);
      continue;
    }
    console.log(`\n${name(program.toBase58())} — ${found.length} ledger(s)`);
    for (const { pubkey, account } of found) {
      console.log(`  ${pubkey.toBase58()}  ${account.lamports / 1e9} SOL`);
    }
  }
  console.log('\nPass a wallet address (or a ledger PDA) to watch it.');
  process.exit(0);
}

// A wallet address is 32 bytes on the curve; a PDA is not. Deriving from a PDA would be
// wrong in a way that is silent, so try the derivation and keep whichever account exists.
let pda;
try {
  const derived = ledgerPda(arg);
  pda = (await conn.getAccountInfo(derived)) ? derived : new PublicKey(arg);
} catch {
  pda = new PublicKey(arg);
}

const start = await conn.getAccountInfo(pda);
if (!start) {
  console.log(`${pda.toBase58()} does not exist on mainnet.`);
  process.exit(1);
}
let owner = start.owner.toBase58();
let since = Date.now();
console.log(`watching ${pda.toBase58()}`);
console.log(`${stamp()}  owner ${name(owner)}  ${start.lamports / 1e9} SOL`);

const ws = new WebSocket(WS);
ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'accountSubscribe',
    params: [pda.toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
  }));
  console.log(`${stamp()}  subscribed — undelegate now`);
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method !== 'accountNotification') {
    if (m.id === 1) console.log(`${stamp()}  server subscription ${m.result}`);
    return;
  }
  const v = m.params.result.value;
  const next = v.owner;
  const dt = ((Date.now() - since) / 1000).toFixed(1);
  if (next === owner) {
    console.log(`${stamp()}  (+${dt}s) data changed, still ${name(owner)}`);
    return;
  }
  console.log(`${stamp()}  (+${dt}s) OWNER CHANGED  ${name(owner)} -> ${name(next)}`);
  owner = next;
  since = Date.now();
});

ws.on('close', () => console.log(`${stamp()}  socket closed`));
ws.on('error', (e) => console.log(`${stamp()}  socket error ${e.message}`));
