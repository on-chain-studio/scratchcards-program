import { Card, TOTAL, MARKED, LINEAR, DISTINCT, MULT_OK } from './types'

const pct = (n: number) => `${((n / TOTAL) * 100).toFixed(4)}%`
const int = (n: number) => n.toLocaleString('en-US').replace(/,/g, '_')

const blockFlags = (f: number) =>
  [f & DISTINCT ? 'DISTINCT' : '', f & MULT_OK ? 'MULT_OK' : ''].filter(Boolean).join(' | ') || '0'

const payFlags = (f: number) =>
  [f & MARKED ? 'MARKED' : '', f & LINEAR ? 'LINEAR' : ''].filter(Boolean).join(' | ') || '0'

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(3, '0')}`

/**
 * Every field this writer knows about. A key on the card that is missing here is reported in
 * the output itself — an export that silently drops a field is worse than no export, because
 * it looks like the setting did nothing.
 */
const EXPORTED = [
  'id', 'name', 'mode', 'roll', 'priceLamports', 'modeArgs',
  'jackpotHitWeight', 'jackpotNearWeight', 'blocks', 'pays', 'tiers', 'pool',
]

/** The card as a literal to paste into the sheet the way `rebalance.mjs` prints today. */
export function toAuthoring(card: Card): string {
  const L: string[] = []

  const unknown = Object.keys(card).filter(k => !EXPORTED.includes(k))
  if (unknown.length) L.push(`// ⚠ not exported by this writer: ${unknown.join(', ')}`)

  L.push(`{ id: '${card.id}', name: '${card.name}',`)
  L.push(`  mode: ${(card.mode ?? '?').toUpperCase()}, roll: ${(card.roll ?? '?').toUpperCase()}, ` +
    `price: ${card.priceLamports / 1e9},`)
  L.push(`  modeArgs: [${card.modeArgs.join(', ')}],`)
  L.push(`  jackpotHitWeight:  ${int(card.jackpotHitWeight)},   // ${pct(card.jackpotHitWeight)}`)
  L.push(`  jackpotNearWeight: ${int(card.jackpotNearWeight)},   // ${pct(card.jackpotNearWeight)}`)

  L.push('  blocks: [')
  for (const b of card.blocks) {
    const extra = b.role === 'number' || b.role === 'jackpot' ? `, a: ${b.a}, b: ${b.b}` : ''
    L.push(`    { role: ${b.role.toUpperCase()}, count: ${b.count}, cols: ${b.cols}, ` +
      `flags: ${blockFlags(b.flags)}${extra} },`)
  }
  L.push('  ],')

  const paySum = card.pays.reduce((n, p) => n + p.weight, 0)
  L.push(`  // ${card.roll === 'exclusive'
    ? `one draw; Σ ${pct(paySum)}, miss ${pct(TOTAL - paySum)}`
    : `one draw per entry, disjoint scopes; Σ chance ${pct(paySum)}`}`)
  L.push('  pays: [')
  for (const p of card.pays) {
    L.push(`    { scope: ${hex(p.scope)}, min: ${p.min}, mult: ${p.mult}, ` +
      `flags: ${payFlags(p.flags)}, weight: ${int(p.weight)} },   // ${pct(p.weight)}`)
  }
  L.push('  ],')

  if (card.tiers.length) {
    L.push('  tiers: [')
    for (const t of card.tiers) {
      L.push(`    { factor: ${t.factor}, weight: ${int(t.weight)} },   // ${pct(t.weight)}`)
    }
    L.push('  ],')
  } else {
    L.push('  tiers: [],')
  }

  L.push('  pool: [')
  const pad = Math.max(...card.pool.map(p => p.token.length))
  for (const p of card.pool) {
    L.push(`    { ${(p.token + ',').padEnd(pad + 1)} weight: ${int(p.weight).padStart(13)}, ` +
      `amount: ${int(p.amount)} },   // ${pct(p.weight)}`)
  }
  L.push('  ],')
  L.push('}')
  return L.join('\n')
}

export const toJson = (card: Card) => JSON.stringify(card, null, 2)
