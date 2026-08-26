import {
  Card, Block, Pay, PoolEntry,
  DISTINCT, MULT_OK, MARKED, LINEAR, w, normalize, maskOf,
} from './types'

const LOW = 26, MID = 12, HIGH = 4

const REL: Record<string, number> = {
  BONK: LOW, PENGU: LOW, WEN: LOW, MEW: LOW,
  WIF: MID, PUMP: MID, SKR: MID, POPCAT: MID, JTO: MID,
  FART: HIGH, PYTH: HIGH, RAY: HIGH, JUP: HIGH, SOL: HIGH,
}

function pool(amounts: Record<string, number>): PoolEntry[] {
  const tokens = Object.keys(amounts)
  const weights = normalize(tokens.map(t => REL[t] ?? 1))
  return tokens.map((token, i) => ({ token, weight: weights[i], amount: amounts[token] }))
}

const jack = (): Block => ({ role: 'jackpot', count: 4, cols: 4, flags: 0, a: 7, b: 9 })

/** Cells `from`..`from+n-1` as a scope mask. */
const span = (from: number, n: number) =>
  maskOf(Array.from({ length: n }, (_, i) => from + i))

const line = (cells: number[], mult: number, p: number): Pay =>
  ({ scope: maskOf(cells), weight: w(p), min: cells.length, flags: 0, mult })


/**
 * The five published cards restated in the weighted format.
 *
 * Layouts and multipliers are faithful to what ships today. The weights are NOT —
 * today's `win_bp` is a planting chance that incidental matches sit on top of, so
 * there is no number on the current sheet that means what a weight means here.
 * They are a starting point shaped from the old bp values, and rebalancing them is
 * what this tool is for.
 */
export const CARDS: Card[] = [
  {
    id: 'straight', name: 'Straight Three', mode: 'count', roll: 'independent',
    priceLamports: 2_000_000, modeArgs: [0, 0, 0, 0],
    jackpotHitWeight: w(0.0002), jackpotNearWeight: w(0.1398),
    blocks: [
      { role: 'plate', count: 3, cols: 3, flags: 0, a: 0, b: 0 },
      jack(),
    ],
    pays: [line([0, 1, 2], 1, 0.28)],
    tiers: [],
    pool: pool({ BONK: 8000000000, PENGU: 100000000, MEW: 60000000, WIF: 10000000 }),
  },

  {
    id: 'triple', name: 'Match Three', mode: 'count', roll: 'exclusive',
    priceLamports: 5_000_000, modeArgs: [0, 0, 0, 0],
    jackpotHitWeight: w(0.0005), jackpotNearWeight: w(0.1595),
    blocks: [
      { role: 'plate', count: 9, cols: 3, flags: MULT_OK, a: 0, b: 0 },
      jack(),
    ],
    // one scope, exclusive rungs: a group of exactly this many
    pays: [
      { scope: span(0, 9), weight: w(0.30),     min: 3, flags: 0, mult: 1 },
      { scope: span(0, 9), weight: w(0.04),     min: 4, flags: 0, mult: 2 },
      { scope: span(0, 9), weight: w(0.008),    min: 5, flags: 0, mult: 4 },
      { scope: span(0, 9), weight: w(0.0015),   min: 6, flags: 0, mult: 8 },
      { scope: span(0, 9), weight: w(0.0003),   min: 7, flags: 0, mult: 16 },
      { scope: span(0, 9), weight: w(0.00005),  min: 8, flags: 0, mult: 32 },
      { scope: span(0, 9), weight: w(0.000005), min: 9, flags: 0, mult: 64 },
    ],
    tiers: [],
    pool: pool({ BONK: 2000000000, PENGU: 15000000, MEW: 40000000, WIF: 1000000 }),
  },

  {
    id: 'five', name: 'Beat the House', mode: 'compare', roll: 'independent',
    priceLamports: 20_000_000, modeArgs: [0, 1, 2, 1],
    jackpotHitWeight: w(0.002), jackpotNearWeight: w(0.218),
    blocks: [
      { role: 'number', count: 5, cols: 5, flags: DISTINCT, a: 8, b: 22 },
      { role: 'number', count: 5, cols: 5, flags: 0, a: 1, b: 30 },
      { role: 'plate', count: 5, cols: 5, flags: 0, a: 0, b: 0 },
      jack(),
    ],
    // one entry per duel: cells [house, mine, prize]. Compare rolls each independently,
    // so unlike Count these are not exclusive — any number of them can pay on one card.
    pays: Array.from({ length: 5 }, (_, i) => ({
      scope: maskOf([i, 5 + i, 10 + i]), weight: w(0.35), min: 1, flags: 0, mult: 1,
    })),
    tiers: [],
    pool: pool({
      BONK: 2500000000, PENGU: 60000000, MEW: 50000000,
      WIF: 5000000, PUMP: 1000000000, SKR: 400000000, POPCAT: 30000000000,
    }),
  },

  {
    id: 'grid', name: 'Lucky Nine', mode: 'count', roll: 'exclusive',
    priceLamports: 50_000_000, modeArgs: [0, 1, 0, 0],
    jackpotHitWeight: w(0.005), jackpotNearWeight: w(0.275),
    blocks: [
      { role: 'mark', count: 2, cols: 2, flags: DISTINCT, a: 0, b: 0 },
      { role: 'plate', count: 9, cols: 3, flags: MULT_OK, a: 0, b: 0 },
      jack(),
    ],
    // LINEAR: each marked plate pays its own amount, so the payout scales with `min`
    pays: [0.30, 0.10, 0.03, 0.008, 0.002, 0.0004, 0.00008, 0.00001, 0.000001]
      .map((p, i) => ({
        scope: span(2, 9), weight: w(p), min: i + 1, flags: MARKED | LINEAR, mult: 1,
      })),
    tiers: [],
    pool: pool({
      MEW: 8000000, WIF: 1000000, PUMP: 100000000, SKR: 30000000, POPCAT: 5000000000,
      JTO: 2000000000, FART: 4000000, PYTH: 40000000, RAY: 6000000, SOL: 300000000,
    }),
  },

  {
    id: 'vault', name: 'The Vault', mode: 'count', roll: 'exclusive',
    priceLamports: 250_000_000, modeArgs: [0, 0, 0, 0],
    jackpotHitWeight: w(0.025), jackpotNearWeight: w(0.315),
    blocks: [
      { role: 'plate', count: 9, cols: 3, flags: 0, a: 0, b: 0 },
      jack(),
    ],
    pays: [
      line([3, 4, 5], 1, 0.10),    // Row 2
      line([1, 4, 7], 1, 0.10),    // Column 2
      line([0, 1, 2], 2, 0.05),    // Row 1
      line([6, 7, 8], 2, 0.05),    // Row 3
      line([0, 3, 6], 2, 0.05),    // Column 1
      line([2, 5, 8], 2, 0.05),    // Column 3
      line([0, 4, 8], 5, 0.0125),  // Diagonal
      line([2, 4, 6], 5, 0.0125),  // Diagonal
    ],
    tiers: [],
    pool: pool({
      SKR: 300000000, POPCAT: 20000000000, JTO: 3000000000, FART: 30000000,
      PYTH: 100000000, RAY: 20000000, JUP: 300000000, SOL: 1000000000,
    }),
  },
]

/** How a scope reads on the card, for a label. */
export function scopeName(card: Card, pay: Pay): string {
  if (card.mode === 'compare') {
    const house = card.blocks[card.modeArgs[0]]
    const base = card.blocks.slice(0, card.modeArgs[0]).reduce((n, b) => n + b.count, 0)
    for (let i = 0; i < (house?.count ?? 0); i++) {
      if ((pay.scope >>> (base + i)) & 1) return `Duel ${i + 1}`
    }
    return 'Duel'
  }
  const cells = []
  for (let i = 0; i < 32; i++) if ((pay.scope >>> i) & 1) cells.push(i)
  const grid = card.blocks.find(b => b.role === 'plate')
  if (!grid) return `${cells.length} cells`

  const base = card.blocks.slice(0, card.blocks.indexOf(grid)).reduce((n, b) => n + b.count, 0)
  const cols = grid.cols
  const local = cells.map(c => c - base)

  if (local.length === grid.count) return `Any ${pay.min}`
  const rows = new Set(local.map(c => Math.floor(c / cols)))
  const colsHit = new Set(local.map(c => c % cols))
  if (rows.size === 1) return `Row ${[...rows][0] + 1}`
  if (colsHit.size === 1) return `Column ${[...colsHit][0] + 1}`
  if (local.every((c, i) => c === i * (cols + 1))) return 'Diagonal ↘'
  if (local.every((c, i) => c === (i + 1) * (cols - 1))) return 'Diagonal ↙'
  return `${local.length} cells`
}
