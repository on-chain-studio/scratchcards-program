import rawPrices from '@prices'

export const TOTAL = 2 ** 32

export const MAX_POOL = 10
export const MAX_BLOCKS = 8
export const MAX_PAYS = 32
export const MAX_TIERS = 4
export const MAX_CELLS = 32
export const CELL_PAYLOAD_MAX = 4095

export const JACKPOT_SHARE = 0.10
export const TARGET_RTP = 0.80

/**
 * The jackpot chance a card's price obliges it to carry.
 *
 * Chance has to scale with price, or the cheapest card is the efficient way to farm the pot: the
 * shelf spans 125× in price, so a flat chance made a 0.002 SOL card a 125× better buy per lamport
 * than the 0.25 one. Tying it to [JACKPOT_SHARE] is what makes "a tenth of the price comes back
 * as jackpot" true of each card rather than only of the shelf averaged together.
 *
 * It is not a tuning knob, which is why it is derived here instead of typed per card, and why
 * [validate] fails a sheet that has drifted off it.
 */
export const jackpotHitFor = (priceLamports: number): number =>
  Math.round(TOTAL * (priceLamports / 1e9) * JACKPOT_SHARE)

export type Role = 'plate' | 'number' | 'mark' | 'jackpot'
export type Mode = 'count' | 'compare'

/**
 * How the pay entries relate to each other.
 *
 * `exclusive` — at most one entry fires. Right when the entries are competing readings of the
 * same board (three alike vs four alike) or sit on overlapping cells, where independent rolls
 * cannot be exact: plant three columns of the Vault and every row and diagonal comes with them.
 *
 * `independent` — every entry rolls on its own and the payouts add up. Right when the entries
 * occupy disjoint cells, so nothing one plants can complete another: rows of a multi-row
 * Straight, duels of Beat the House.
 */
export type Roll = 'exclusive' | 'independent'

export const DISTINCT = 1
export const MULT_OK = 2

export const MARKED = 1
export const LINEAR = 2

export interface Block {
  role: Role
  count: number
  cols: number
  flags: number
  a: number
  b: number
}

export interface Pay {
  scope: number
  weight: number
  min: number
  flags: number
  mult: number
}

export interface Tier {
  factor: number
  weight: number
}

export interface PoolEntry {
  token: string
  weight: number
  amount: number
}

/**
 * What `Build ladder` was last set to.
 *
 * Deliberately not part of `Card`: the chain has no use for it, and anything on the card ends
 * up in what gets published. It is the tool's own state, saved beside the sheet and keyed by
 * card id.
 */
export interface LadderSettings {
  min: number
  max: number
  bend: number
  /** hold the top prize at this rarity, exempt from the bend curve. 0 leaves it on the curve. */
  top: number
  /** what the solver aims the win rate at, as 1 in this many cards */
  winOneIn: number
  /** SOL of sales the solver aims to take per top prize — the headline's rarity, priced */
  turnover: number
}

export const DEFAULT_LADDER: LadderSettings = { min: 1, max: 100, bend: 1, top: 0, winOneIn: 3, turnover: 1_000 }

export type Design = Record<string, LadderSettings>

export interface Card {
  id: string
  name: string
  mode: Mode
  roll: Roll
  priceLamports: number
  modeArgs: [number, number, number, number]
  jackpotHitWeight: number
  jackpotNearWeight: number
  blocks: Block[]
  pays: Pay[]
  tiers: Tier[]
  pool: PoolEntry[]
}

/**
 * Mainnet decimals, read from the mint accounts by `fetch-prices.mjs`.
 *
 * A prize is stored in base units, so this is what decides its value. Devnet's stand-ins are
 * 0-decimal and cannot express a fraction of a token — that is a publish-time limit, not a
 * design one, so the design is done against the mints that will actually pay.
 */
const RAW = rawPrices as Record<string, unknown>
const DECIMALS = (RAW._decimals ?? {}) as Record<string, number>
export const MINTS = (RAW._mints ?? {}) as Record<string, string>

/** How liquid a payout token is — the house has to be able to buy what it owes. */
export const MCAP = (RAW._mcap ?? {}) as Record<string, number>
export const VOLUME = (RAW._volume ?? {}) as Record<string, number>

export const FALLBACK_DECIMALS = 6
export const decimalsOf = (token: string) => DECIMALS[token] ?? FALLBACK_DECIMALS
export const knownDecimals = (token: string) => typeof DECIMALS[token] === 'number'
export const whole = (token: string, units: number) => units / 10 ** decimalsOf(token)

export const popcount = (n: number) => {
  let c = 0
  for (let v = n >>> 0; v; v &= v - 1) c++
  return c
}

export const cellsOf = (scope: number) => {
  const out: number[] = []
  for (let i = 0; i < MAX_CELLS; i++) if ((scope >>> i) & 1) out.push(i)
  return out
}

export const maskOf = (cells: number[]) => cells.reduce((m, c) => m | (1 << c), 0) >>> 0

export const bodyLen = (card: Card) =>
  card.blocks.filter(b => b.role !== 'jackpot').reduce((n, b) => n + b.count, 0)

export const cellCount = (card: Card) => card.blocks.reduce((n, b) => n + b.count, 0)

/** Where a block's cells start, in card-cell indices. */
export const blockOffset = (card: Card, index: number) =>
  card.blocks.slice(0, index).reduce((n, b) => n + b.count, 0)

/**
 * Beat's five duels each roll their pay entry independently, so its weights are
 * per-duel rather than per-card. Everything else rolls once.
 */
export const duelsOf = (card: Card) =>
  card.mode === 'compare' ? (card.blocks[card.modeArgs[0]]?.count ?? 1) : 1

/**
 * A sheet written before `roll` existed carries the old assumption: compare rolled every duel
 * on its own, count fired one entry. Backfilled rather than inferred from the scopes, so a card
 * that should now be independent shows up wrong in the toggle instead of being silently
 * reinterpreted into different odds.
 */
export const backfill = (cards: Card[]): Card[] => cards.map(settleRoll)

/**
 * Overlapping scopes can never roll independently — plant three columns of the Vault and every
 * row and both diagonals come with them, so the declared per-line odds are violated upward.
 * Disjoint scopes can go either way, and independent is the useful default, so that is what an
 * unset or now-invalid card lands on.
 */
export function settleRoll(card: Card): Card {
  const free = disjoint(card.pays.map(p => p.scope))
  if (!free) return card.roll === 'exclusive' ? card : { ...card, roll: 'exclusive' }
  return card.roll ? card : { ...card, roll: 'independent' }
}

/** Scopes that share no cell can be rolled independently without one completing another. */
export function disjoint(masks: number[]): boolean {
  for (let i = 0; i < masks.length; i++) {
    for (let j = i + 1; j < masks.length; j++) {
      if ((masks[i] & masks[j]) !== 0) return false
    }
  }
  return true
}

/** Relative weights → exact integers summing to `total`, by largest remainder. */
export function normalize(rel: number[], total = TOTAL): number[] {
  const sum = rel.reduce((a, b) => a + b, 0)
  if (sum <= 0) return rel.map(() => 0)
  const raw = rel.map(r => (r * total) / sum)
  const out = raw.map(Math.floor)
  const short = total - out.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < short; k++) out[order[k % order.length].i]++
  return out
}

/** A probability as a weight out of 2^32. */
export const w = (p: number) => Math.round(p * TOTAL)
