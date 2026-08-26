import { Card, TOTAL, LINEAR, TARGET_RTP, decimalsOf, normalize } from './types'
import { Prices } from './analytics'

/**
 * The nearest round number a prize would sensibly be printed as — the same steps
 * `scripts/sheet.mjs` snaps to, so both agree on what "round" means.
 */
export function nice(units: number, token: string): number {
  if (units <= 0) return 0
  const scale = 10 ** decimalsOf(token)
  const x = units / scale
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]
  const base = 10 ** Math.floor(Math.log10(x))
  let best: number | null = null
  for (const s of steps) {
    const v = Math.round(s * base * scale)
    if (v < 1) continue
    if (best === null || Math.abs(v - units) < Math.abs(best - units)) best = v
  }
  return best ?? 1
}

/** The nearest round number at or above `units` — for a prize that must not fall below a floor. */
export function niceUp(units: number, token: string): number {
  if (units <= 0) return 0
  const scale = 10 ** decimalsOf(token)
  const x = units / scale
  const base = 10 ** Math.floor(Math.log10(x))
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) {
    const v = Math.round(s * base * scale)
    if (v >= units && v >= 1) return v
  }
  return Math.max(1, Math.round(10 * base * scale))
}

/** Whether a prize is already printed on the round steps `nice` snaps to. */
export const isNice = (units: number, token: string) => units === nice(units, token)

/** A prize worth about what this card's other prizes are worth, in round units. */
export function matchingAmount(card: Card, prices: Prices, token: string): number {
  const values = card.pool
    .map(p => p.amount * (prices[p.token] ?? 0) / 10 ** decimalsOf(p.token))
    .filter(v => v > 0)
    .sort((a, b) => a - b)
  const price = prices[token] ?? 0
  if (!values.length || price <= 0) return 1
  const median = values[Math.floor(values.length / 2)]
  return nice((median / price) * 10 ** decimalsOf(token), token)
}

/**
 * USD returned per one base unit of each pool amount.
 *
 * The payout is exactly linear in the amounts: the outcome draw and the token draw are
 * independent, so the expectation needs no sampling.
 */
export function unitRates(card: Card, prices: Prices): number[] {
  const poolSum = card.pool.reduce((n, p) => n + p.weight, 0) || 1
  const tierSum = card.tiers.reduce((n, t) => n + t.weight, 0)
  const tiers = [
    { factor: 1, p: 1 - tierSum / TOTAL },
    ...card.tiers.map(t => ({ factor: t.factor, p: t.weight / TOTAL })),
  ]

  return card.pool.map(entry => {
    const price = prices[entry.token] ?? 0
    const perWhole = price / 10 ** decimalsOf(entry.token)
    const pToken = entry.weight / poolSum
    let rate = 0
    for (const pay of card.pays) {
      const pPay = pay.weight / TOTAL
      const scale = pay.mult * ((pay.flags & LINEAR) ? pay.min : 1)
      for (const tier of tiers) {
        rate += pPay * pToken * tier.p * scale * tier.factor * perWhole
      }
    }
    return rate
  })
}

export interface SolvedOdds {
  weights: number[]
  rtp: number
  before: number
  /** hit the ceiling before reaching target — exclusive weights cannot exceed 2³² together */
  clamped: boolean
}

/**
 * Balances on the card's own odds: scales every pay weight by one factor, leaving prizes and
 * pool untouched. A player sees this as the card paying more or less often, never as the
 * printed prize changing.
 */
export function solveOdds(card: Card, prices: Prices, target = TARGET_RTP): SolvedOdds {
  const rates = unitRates(card, prices)
  const priceUsd = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const current = card.pool.reduce((n, p, i) => n + p.amount * rates[i], 0)
  const before = priceUsd > 0 ? current / priceUsd : 0
  const weights = card.pays.map(p => p.weight)
  if (current <= 0 || priceUsd <= 0 || before <= 0) {
    return { weights, rtp: before, before, clamped: false }
  }

  let k = target / before
  let clamped = false
  const sum = weights.reduce((n, w) => n + w, 0)
  if (card.roll === 'exclusive' && sum * k > TOTAL) {
    k = TOTAL / sum
    clamped = true
  } else if (card.roll === 'independent') {
    const worst = Math.max(...weights)
    if (worst * k > TOTAL) { k = TOTAL / worst; clamped = true }
  }

  const scaled = weights.map(w => Math.round(w * k))
  return { weights: scaled, rtp: before * k, before, clamped }
}

export interface Ladder {
  amounts: number[]
  weights: number[]
  payWeights: number[]
  rtp: number
  /** what the top prize actually landed on, once the pin and the odds solve settled */
  topOdds: number
  /** the pay table alone already spans more than the requested range */
  overrun: number
  span: number
}

/**
 * Builds the whole pool from the two ends of the prize ladder.
 *
 * A multiple is `token value x pay mult x tier factor / ticket`, so min and max pin the cheapest
 * and dearest token outright; the rest interpolate geometrically. `bend` then decides how the
 * weight sits on that ladder — weight proportional to value^-bend, so 0 is uniform, 1 gives every
 * token an equal share of the return, and above 1 piles the mass onto the cheap end, which is what
 * makes most wins small.
 *
 * That fixes prizes and pool weights, which leaves RTP to the pay table: every pay weight is
 * scaled by one factor at the end. The player sees the card pay more or less often; no printed
 * prize moves.
 */
export function solveLadder(
  card: Card, prices: Prices, minX: number, maxX: number, bend: number,
  target = TARGET_RTP, topOneIn = 0,
): Ladder {
  const priceUsd = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const n = card.pool.length
  const empty: Ladder = {
    amounts: card.pool.map(p => p.amount), weights: card.pool.map(p => p.weight),
    payWeights: card.pays.map(p => p.weight), rtp: 0, overrun: 1, span: 1, topOdds: Infinity,
  }
  if (priceUsd <= 0 || n === 0 || !card.pays.length) return empty

  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const lo = (minX * priceUsd) / Math.min(...mults)
  const paySpan = (Math.max(...mults) * topTier) / Math.min(...mults)

  // how much wider the pay table already is than the range asked for
  const span = maxX / Math.max(minX, 1e-9)
  const overrun = paySpan / span

  // Never let the ladder run backwards. Once the pay table spans more than the range asked for
  // there is nothing left for the tokens to add, so they all take the same value — the top prize
  // is then min x paySpan whatever `max` says, which is what the caller is told.
  const hi = Math.max((maxX * priceUsd) / (Math.max(...mults) * topTier), lo)
  const ratio = hi / lo
  const values = card.pool.map((_, i) => lo * Math.pow(ratio, n <= 1 ? 0 : i / (n - 1)))
  // Position 0 is the bottom of the ladder, so it may only round up: snapping it down would
  // put outcomes below the `min` the whole card was designed around, and with weight piled on
  // the cheap end that one rounding takes a large share of the return under the ticket price.
  const raw = card.pool.map((p, i) => {
    const price = prices[p.token] ?? 0
    return price > 0 ? (values[i] / price) * 10 ** decimalsOf(p.token) : p.amount
  })
  // Every position rounds up, so no token's value can land under the bottom of the ladder and
  // drag outcomes below the `min` the card was designed around. Rounding up overshoots RTP a
  // little; the odds solve below takes that back out of the win rate, which is the whole point
  // of separating the two — prizes are the design, frequency is the balance.
  //
  // The top rung is the one exception: it rounds to the NEAREST step. It is the headline, and
  // an ideal landing just past a step must not leap a fifth higher — a 125,600 ideal printing
  // as 150,000 both overshoots the max the card was designed to and makes the top far rarer
  // than its design position, since the curve prices the realised value.
  // Only the bottom rung must round UP — it is what keeps every outcome at or above the
  // `min` the card was designed around. The rest round NEAREST: an ideal sitting just past
  // a step must not overshoot a third (302 JUP printing as 400), because overshot mid rungs
  // wall in the headline and hand the odds solve extra return to claw back.
  const amounts = raw.map((u, i) =>
    i === 0 ? niceUp(u, card.pool[i].token) : Math.max(1, nice(u, card.pool[i].token)))
  if (n > 1) {
    // The headline rung answers to two rules the body doesn't. It rounds NEAREST — an ideal
    // just past a step must not leap a fifth higher, overshooting the designed max and thinning
    // its own odds. And it must stay the dearest print on the card: a mid rung whose token only
    // offers coarse steps can round up past it (400 JUP dethroning the PUMP top), and then the
    // card's face is the wrong token. Nearest first, then step up until it out-values them all.
    const i = n - 1
    const tok = card.pool[i].token
    const price = prices[tok] ?? 0
    if (price > 0) {
      const scale = 10 ** decimalsOf(tok)
      const below = Math.max(...card.pool.slice(0, i).map((p, j) =>
        (amounts[j] / 10 ** decimalsOf(p.token)) * (prices[p.token] ?? 0)))
      let a = Math.max(1, nice(raw[i], tok))
      if ((a / scale) * price <= below) a = niceUp(((below * 1.02) / price) * scale, tok)
      amounts[i] = a
    }
  }

    const out = weighAmounts(card, prices, amounts, values, bend, target, topOneIn)
  return { amounts, ...out, overrun, span }
}

/**
 * The balance half of every solve: pool weights from the bend, pay weights landing RTP, and
 * the optional top-prize pin. Takes the amounts as given — where they came from (the ladder,
 * the printed sheet, or a compromise between the two) is the caller's philosophy, not this
 * function's.
 */
function weighAmounts(
  card: Card, prices: Prices, amounts: number[], ideals: number[], bend: number,
  target: number, topOneIn: number,
): { weights: number[]; payWeights: number[]; rtp: number; topOdds: number } {
  const n = card.pool.length
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))

  // Bend is a statement about multiples, not about tokens: an outcome paying m should be
  // weighted m^-bend wherever that m comes from. Applying it only to the pool made it inert on
  // a card whose spread is in the pay table — every token there holds the same value, so
  // value^-bend is uniform for any bend. At bend 1 each rung returns the same share of RTP,
  // which is the halve-the-chance-as-the-prize-doubles ladder written as one number.
  const bendOf = (x: number) => Math.pow(Math.max(x, 1e-12), -bend)

  /**
   * Split each multiple's weight across the routes that reach it.
   *
   * The Vault has two lines paying ×1, four paying ×2 and two paying ×5. A player sees the
   * amount, not which line produced it, so without this the ×2 prizes arrive twice as often as
   * the curve says and end up more common than dearer ×1 prizes on a better token.
   */
  const routes = new Map<number, number>()
  for (const m of mults) routes.set(m, (routes.get(m) ?? 0) + 1)

  /**
   * Weight against what a token actually pays, not what the ladder asked for.
   *
   * `niceUp` moves a value by up to a fifth to reach a round number, so weighting the ideal
   * value leaves the weight and the payout disagreeing — and a prize ends up rarer than one
   * paying more. Against the realised value the pool and pay curves multiply out to
   * payout^-bend exactly, which is monotone by construction.
   */
  const realised = card.pool.map((p, i) =>
    (amounts[i] / 10 ** decimalsOf(p.token)) * (prices[p.token] ?? 0) || ideals[i])
  const topPool = n - 1
  // every pay entry reaching the top multiple is another route to the same prize, and a player
  // only sees the amount — so the pin counts them all rather than one
  const topMult = Math.max(...mults)
  const topRoutes = mults.map((m, i) => (m === topMult ? i : -1)).filter(i => i >= 0)

  /**
   * Assemble the sheet: pool weights from the design bend (optionally holding the dearest
   * token at a fixed share), pay weights from their own exponent, one RTP solve at the end.
   */
  const shapedAt = (bp: number) =>
    normalize(mults.map(m => Math.pow(Math.max(m, 1e-12), -bp) / (routes.get(m) ?? 1)))
  const poolFlat = realised[n - 1] <= realised[0] * 1.3

  const assemble = (share: number | null, bp = bend) => {
    let weights: number[]
    if (share === null || share === undefined) {
      weights = normalize(realised.map(bendOf))
    } else {
      // A share above 1/n cannot be monotone -- the top would beat a cheaper rung by pigeonhole.
      const pinned = Math.max(1, Math.min(Math.floor(TOTAL / n), Math.round(share * TOTAL)))
      let rest = normalize(realised.filter((_, i) => i !== topPool).map(bendOf), TOTAL - pinned)
      /**
       * No cheaper prize may be rarer than the pinned top. The curve decays past the pin's
       * level near its high end, which read as "the best prize has the best odds" on the
       * sheet -- so rungs that fall under the pin are floored at it, and the curve keeps
       * only what remains. Waterfill: flooring one rung shrinks the rest, which may push
       * another under the floor, so repeat until the floored set is stable.
       */
      for (let pass = 0; pass < n; pass++) {
        const low = rest.map((w, i) => w < pinned ? i : -1).filter(i => i >= 0)
        if (!low.length) break
        const freeIdx = rest.map((_, i) => i).filter(i => !low.includes(i))
        if (!freeIdx.length) { rest = rest.map(() => pinned); break }
        const freeTotal = TOTAL - pinned - low.length * pinned
        const redone = normalize(freeIdx.map(i => rest[i]), Math.max(freeIdx.length, freeTotal))
        const next = rest.slice()
        low.forEach(i => { next[i] = pinned })
        freeIdx.forEach((i, j) => { next[i] = redone[j] })
        rest = next
      }
      let j = 0
      weights = realised.map((_, i) => (i === topPool ? pinned : rest[j++]))
    }
    const staged: Card = {
      ...card,
      pool: card.pool.map((p, i) => ({ ...p, amount: amounts[i], weight: weights[i] })),
      pays: card.pays.map((p, i) => ({ ...p, weight: shapedAt(bp)[i] })),
    }
    const solved = solveOdds(staged, prices, target)
    /**
     * What event the pin aims at depends on the pool's shape. A spread pool makes the
     * headline "top mult on the dearest token" -- mult chance times pool share. A flat pool
     * (every token worth about the same) makes any token at the top mult pay the headline,
     * so the big-win event is the mult chance alone, and share would overshoot it tenfold.
     */
    const achieved = topRoutes.reduce((n2, i) => n2 + solved.weights[i] / TOTAL, 0)
      * (poolFlat ? 1 : weights[topPool] / TOTAL)
    return { weights, payWeights: solved.weights, rtp: solved.rtp, achieved }
  }

  let out = assemble(null)
  if (topOneIn && topOneIn > 0 && n > 1) {
    /**
     * The pin has one dial, picked by the card's shape.
     *
     * A card with a mult chain corrects through the chain's own exponent: the pays keep a
     * power law, just a gentler one than the pool's, so the chain stays strictly decreasing
     * and the correction spreads over every rung instead of piling onto one. achieved falls
     * monotonically as the exponent rises, so a bisection lands it deterministically.
     *
     * A flat-mult card has no chain to tilt -- there the dearest rung's pool share is the
     * dial, walked to the target with the waterfill keeping the ladder monotone.
     *
     * Either dial only makes the top more common than its curve position. Rarer is not a
     * pin's job -- that is what max and bend are for.
     */
    const want = 1 / topOneIn
    const spanM = Math.max(...mults) / Math.min(...mults)
    if (spanM > 1) {
      const natural = assemble(null, bend)
      if (natural.achieved < want) {
        let lo = 0, hi = bend
        for (let i = 0; i < 40; i++) {
          const bp = (lo + hi) / 2
          const r = assemble(null, bp)
          // lower exponent -> flatter chain -> commoner top
          if (r.achieved > want) lo = bp; else hi = bp
        }
        out = assemble(null, (lo + hi) / 2)
      } else {
        out = natural
      }
    } else {
      let share = out.weights[topPool] / TOTAL
      let best = assemble(share)
      for (let i = 0; i < 40; i++) {
        if (Math.abs(best.achieved - want) <= want * 1e-3) break
        const f = want / Math.max(best.achieved, 1e-18)
        share = Math.max(1e-12, Math.min(0.2, share * f))
        best = assemble(share)
      }
      out = best
    }
  }

  return {
    weights: out.weights, payWeights: out.payWeights,
    rtp: out.rtp, topOdds: out.achieved > 0 ? 1 / out.achieved : Infinity,
  }
}

/**
 * The bend that lands a win rate. Bend is not a taste knob: steeper piles the return onto
 * cheap outcomes, which at a fixed RTP means more of them — so the win-one-in aim picks the
 * bend, at today's prices, and a rebalance re-derives it rather than reusing yesterday's.
 */
export function solveBend(
  card: Card, prices: Prices, minX: number, maxX: number, winOneIn: number,
  target = TARGET_RTP, topOneIn = 0,
): number {
  let lo = 0.5
  let hi = 6
  for (let i = 0; i < 40; i++) {
    const bend = (lo + hi) / 2
    const L = solveLadder(card, prices, minX, maxX, bend, target, topOneIn)
    const poolSum = L.weights.reduce((a, w) => a + w, 0)
    const win = L.payWeights.reduce((a, w) => a + w, 0) / TOTAL * (poolSum / TOTAL)
    if (1 / win > winOneIn) lo = bend; else hi = bend
  }
  return (lo + hi) / 2
}

/** No card's headline may be rarer than this — scarcer stops being a prize and starts being a lie. */
// A whisker under the stated 1:300k limit: the solver's internal odds measure and the
// player-facing merged ladder differ by a few percent, and the limit binds the latter.
export const TOP_ONE_IN_CAP = 280_000

/** The slice of every ticket the top prize costs — equal on every card, so prize scales with spend. */
export const TOP_EV_SHARE = 0.001

/**
 * The whole per-card solve: bend from the win aim, and — on a card whose top rides the
 * natural curve — max walked down until the headline's odds respect the cap. On a mixed
 * card the top's rarity is bought with max and nothing else honors a ceiling, so the
 * ceiling owns max; a pinned card holds its odds by the pin and keeps the max it asked for.
 */
export function solveShelf(
  card: Card, prices: Prices,
  d: { min: number; max: number; winOneIn: number; top: number },
  target = TARGET_RTP, share = TOP_EV_SHARE,
): { max: number; bend: number; ladder: Ladder } {
  const solveAt = (mx: number) => {
    const bend = solveBend(card, prices, d.min, mx, d.winOneIn, target, 0)
    return { bend, L: solveLadder(card, prices, d.min, mx, bend, target, 0) }
  }
  /**
   * The cap binds the PRINTED top prize — the odds a player reads beside the headline —
   * not the ladder's internal pin event, which on a near-flat pool is "the top multiple on
   * any token" and can be ten times commoner than the headline row itself.
   */
  const capMults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const capTop = Math.max(...capMults)
  const headlineOneIn = (L: Ladder) => {
    const poolSum = L.weights.reduce((a, w) => a + w, 0) || 1
    const pRoute = capMults.reduce((a, m, i) => a + (m === capTop ? L.payWeights[i] : 0), 0) / TOTAL
    const p = pRoute * (L.weights[L.weights.length - 1] / poolSum)
    return p > 0 ? 1 / p : Infinity
  }
  const priceUsd2 = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const tok2 = card.pool[card.pool.length - 1].token
  const scale2 = 10 ** decimalsOf(tok2)
  /**
   * The headline's odds are not a free knob: every ticket spends the same slice of itself
   * on the top prize, on every card. Odds derive from the printed prize — one-in equals the
   * headline multiple over the share — so doubling the prize always costs exactly double
   * the spend, never fourteen times. The cap still bounds the rarest allowed.
   */
  const printedTarget = (L: Ladder) => {
    const topVal = (L.amounts[L.amounts.length - 1] / scale2) * (prices[tok2] ?? 0) * capTop
    return Math.min(TOP_ONE_IN_CAP, Math.round(topVal / priceUsd2 / share))
  }
  let max = d.max
  let r = solveAt(max)
  {
    // How hard the pin may pull without distorting: a flat-mult card's share dial is always
    // clean, and a near-flat pool has no cross-dimension value ties for a tilt to invert —
    // both take any pull. A genuinely mixed card caps at ~3x; beyond that, the headline
    // steps down the printed ladder until its target is within reach.
    const vals = r.L.amounts.map((u, j) => (u / 10 ** decimalsOf(card.pool[j].token)) * (prices[card.pool[j].token] ?? 0))
    const poolSpan = Math.max(...vals) / Math.max(1e-9, Math.min(...vals))
    const cleanPull = capTop <= 1 || poolSpan < 1.5 ? Infinity : 3
    const mults = capMults
    const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
    const paysTop = Math.max(...mults) * topTier
    for (let i = 0; i < 14 && headlineOneIn(r.L) > printedTarget(r.L) * cleanPull; i++) {
      const cur = r.L.amounts[r.L.amounts.length - 1]
      const down = Math.max(1, nice(cur * 0.79, tok2))
      if (down >= cur) break
      const next = ((down / scale2) * (prices[tok2] ?? 0) * paysTop) / priceUsd2
      if (!(next > d.min * 1.1)) break
      max = next
      r = solveAt(max)
    }
    // Land the derived odds through the pin, aimed by measurement. A flat-mult card's
    // share dial moves both ways, so it also engages when the natural top is too COMMON
    // for the share; a tilt card can only pull commoner, so rarer-than-natural is accepted.
    const off = () => headlineOneIn(r.L) / printedTarget(r.L)
    const engage = () => off() > 1.02 || (capTop <= 1 && off() < 1 / 1.02)
    if (engage()) {
      let t = printedTarget(r.L)
      for (let i = 0; i < 8 && engage(); i++) {
        r = { bend: r.bend, L: solveLadder(card, prices, d.min, max, r.bend, target, t) }
        t = Math.max(1000, Math.round(t / off()))
      }
      // The pin's tail EV comes out of the win rate and stays out: re-solving bend with the
      // pin active couples two searches that chase each other (tried three times, diverged
      // three times). The win-rate cost is the honest price of a proportional top.
    }
  }
  return { max, bend: r.bend, ladder: r.L }
}

/**
 * Rebalances a card treating its commitments as aims rather than rules.
 *
 * Three things compete when prices move: the printed amounts (a player recognises their card),
 * the design ladder (the USD shape the card was tuned to), and RTP (the house edge). The first
 * two are scored against each other per rung — a prize moves only when its value has drifted
 * far enough off the ladder that the reprint beats the churn — and RTP is then landed exactly
 * by the pay-table solve, which touches neither of the other two.
 *
 * `sticky` prices the reprint: 0 rebuilds every amount from the ladder (solveLadder's answer),
 * 1 holds a prize until its value drifts roughly a third off its rung, higher holds longer.
 */
export function solveBalanced(
  card: Card, prices: Prices, minX: number, maxX: number, bend: number,
  target = TARGET_RTP, topOneIn = 0, sticky = 1,
): Ladder {
  const priceUsd = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const n = card.pool.length
  const empty: Ladder = {
    amounts: card.pool.map(p => p.amount), weights: card.pool.map(p => p.weight),
    payWeights: card.pays.map(p => p.weight), rtp: 0, overrun: 1, span: 1, topOdds: Infinity,
  }
  if (priceUsd <= 0 || n === 0 || !card.pays.length) return empty

  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const lo = (minX * priceUsd) / Math.min(...mults)
  const paySpan = (Math.max(...mults) * topTier) / Math.min(...mults)
  const span = maxX / Math.max(minX, 1e-9)
  const overrun = paySpan / span
  const hi = Math.max((maxX * priceUsd) / (Math.max(...mults) * topTier), lo)
  const ratio = hi / lo
  const values = card.pool.map((_, i) => lo * Math.pow(ratio, n <= 1 ? 0 : i / (n - 1)))

  const amounts = card.pool.map((p, i) => {
    const price = prices[p.token] ?? 0
    if (price <= 0 || p.amount < 1) return p.amount
    const scale = 10 ** decimalsOf(p.token)
    const usdOf = (a: number) => (a / scale) * price
    // candidates: hold, the rung's ideal, and the round steps between them
    const options = new Set<number>([p.amount, niceUp((values[i] / price) * scale, p.token)])
    for (const f of [0.5, 0.667, 0.8, 1.25, 1.5, 2]) options.add(nice(p.amount * f, p.token))
    // nothing may land under the bottom of the ladder (see solveLadder) — unless even the
    // rung's own ideal sits there, which happens when the pay table spans the whole range
    const floor = Math.min(lo, values[i]) * 0.999
    const legal = [...options].filter(a => a >= 1 && usdOf(a) >= floor)
    if (!legal.length) return niceUp((values[i] / price) * scale, p.token)
    // shape error against the ladder, plus what the move itself costs — holding is free
    const cost = (a: number) =>
      Math.abs(Math.log(usdOf(a) / values[i])) +
      (a === p.amount ? 0 : sticky * (0.15 + 0.5 * Math.abs(Math.log(a / p.amount))))
    return legal.reduce((best, a) => (cost(a) < cost(best) ? a : best))
  })

  const out = weighAmounts(card, prices, amounts, values, bend, target, topOneIn)
  return { amounts, ...out, overrun, span }
}

/**
 * How the requested range divides between the card and the pool.
 *
 * A top multiple is `min x card spread x pool spread`. The card's is fixed by its own design —
 * Match Three doubles seven times and carries a x10 tier, so it spans 640x before a token is
 * drawn. Whatever the range leaves over is what the pool can contribute, and on a card like that
 * there is nothing left: the spread genuinely lives in the pay table, not the prizes.
 */
export function ladderSplit(card: Card, minX: number, maxX: number) {
  if (!card.pays.length) return { rungs: 1, tiers: 1, pay: 1, pool: 1, top: minX }
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const rungs = Math.max(...mults) / Math.min(...mults)
  const tiers = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const pay = rungs * tiers
  const pool = Math.max(1, maxX / Math.max(minX, 1e-9) / pay)
  return { rungs, tiers, pay, pool, top: minX * pay * pool }
}

export interface Targets {
  bend: number
  max: number
  winOneIn: number
  turnover: number
}

/**
 * Finds the `bend` and `max` that hit a win rate and a headline turnover together, staying on
 * the curve.
 *
 * The alternative — pinning the top prize off the curve — buys the frequency but makes that
 * token's whole column common, so its lesser prizes overtake dearer ones from other tokens and
 * the published table reads as broken. Here nothing leaves the curve, so the table stays
 * monotone; the price is a lower ceiling, since bringing the headline within reach on the curve
 * means shortening the ladder.
 *
 * The two knobs are nearly independent — bend moves the win rate, max moves the headline — so
 * bisecting each in turn converges in a handful of passes.
 */
export function solveTargets(
  card: Card, prices: Prices, minX: number,
  winOneIn = 3, turnover = 1000, target = TARGET_RTP,
): Targets {
  const priceSol = card.priceLamports / 1e9
  const measure = (bend: number, max: number) => {
    const L = solveLadder(card, prices, minX, max, bend, target, 0)
    const p = L.payWeights.map(w => w / TOTAL)
    const winRate = card.roll === 'independent'
      ? 1 - p.reduce((n, x) => n * (1 - x), 1)
      : p.reduce((n, x) => n + x, 0)
    return { winRate, turnover: priceSol * L.topOdds }
  }

  // The pool only adds spread beyond what the pay table already provides. Below
  // minX × paySpan the overrun clamp flattens the pool, so every ceiling down there is the
  // same card — turnover stops responding, and a bisection that wanders in converges on the
  // meaningless floor (a Match Three "solve" collapsed max to 1.1× exactly this way). The
  // pay table's own span is the honest lower bound for the ceiling.
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const paySpan = mults.length ? (Math.max(...mults) * topTier) / Math.min(...mults) : 1
  const ceilingFloor = minX * Math.max(paySpan, 1.05)

  let bend = 2
  let max = Math.max(ceilingFloor, minX * 2, 50)

  for (let pass = 0; pass < 8; pass++) {
    // higher bend piles weight on the cheap end, so the card pays more often
    let lo = 0.05, hi = 8
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (measure(mid, max).winRate < 1 / winOneIn) lo = mid; else hi = mid
    }
    bend = (lo + hi) / 2

    // a higher ceiling makes the dearest prize rarer, so more sales per hit
    let l2 = ceilingFloor, h2 = 20_000
    for (let i = 0; i < 40; i++) {
      const mid = (l2 + h2) / 2
      if (measure(bend, mid).turnover < turnover) l2 = mid; else h2 = mid
    }
    max = (l2 + h2) / 2
  }

  const got = measure(bend, max)
  return { bend, max, winOneIn: 1 / got.winRate, turnover: got.turnover }
}
