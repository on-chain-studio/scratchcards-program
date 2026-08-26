import { Connection, PublicKey } from '@solana/web3.js';
import { decodeLedger } from './accounts.mjs';

const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const GAME = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PERM = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');

const base = new Connection('https://rpc.magicblock.app/devnet', 'confirmed');
const treasuries = ['house', 'jackpot'].map(
  (s) => PublicKey.findProgramAddressSync([Buffer.from(s)], GAME)[0].toBase58());

// Every ledger the vault still owns on basenet. A delegated one is owned by the delegation
// program instead, so those are listed separately below.
for (const owner of [VAULT, DELEGATION]) {
  const found = await base.getProgramAccounts(owner, {
    filters: [{ memcmp: { offset: 0, bytes: '8DiEB2worzb' } }],   // Ledger discriminator
  }).catch(() => []);
  for (const { pubkey, account } of found) {
    const d = account.data;
    if (d.length < 124) continue;
    const l = decodeLedger(d);
    if (!l) continue;
    const ledgerOwner = l.owner.toBase58();
    const { pdaAuth, slots, sol } = l;
    const rentPayer = l.rentPayer.toBase58();
    const perm = PublicKey.findProgramAddressSync(
      [Buffer.from('permission:'), pubkey.toBuffer()], PERM)[0];
    const p = await base.getAccountInfo(perm);
    const tag = treasuries.includes(ledgerOwner) ? '  (treasury)' : '';
    console.log(
      `${pubkey.toBase58()}\n  owner ${ledgerOwner}${tag}\n` +
      `  pda ${pdaAuth}  slots ${slots}  sol ${Number(sol) / 1e9}  ` +
      `delegated ${owner.equals(DELEGATION)}  permission ${p ? p.data.length + 'B' : 'none'}\n` +
      `  rent_payer ${rentPayer}`,
    );
  }
}
