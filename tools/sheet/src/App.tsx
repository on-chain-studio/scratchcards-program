import { useEffect, useMemo, useRef, useState } from 'react'
import rawPrices from '@prices'
import { onDisk, seed, readDraft, writeDraft, clearDraft, saveToDisk, same, parseSheet,
  designOnDisk, readDesign, writeDesign, clearDesign, saveDesign, readPick, writePick } from './model/store'
import { Card, Block, Pay, Design, TARGET_RTP, TOTAL, MCAP, DEFAULT_LADDER, normalize, bodyLen, popcount, settleRoll, jackpotHitFor } from './model/types'
import { analyse, Prices } from './model/analytics'
import { validate } from './model/validate'
import { toAuthoring, toJson } from './model/encode'
import { solveOdds, solveLadder, solveShelf, solveTargets, ladderSplit, matchingAmount, nice } from './model/solve'
import { CardPreview } from './ui/CardPreview'
import { PoolTable, PrizeList } from './ui/Tables'
import { BlockTable, PayTable } from './ui/Editors'
import { fmt, usd, pct } from './ui/format'
import { NumberField } from './ui/Weight'
import { BandChart } from './ui/Charts'
import { AnalyticsView } from './ui/AnalyticsView'
import { RangeSlider } from './ui/RangeSlider'

const PRICES: Prices = Object.fromEntries(
  Object.entries(rawPrices).filter(([, v]) => typeof v === 'number'),
) as Prices

const FETCHED = typeof rawPrices._fetched === 'string' ? rawPrices._fetched : null
const AGE_DAYS = FETCHED ? Math.floor((Date.now() - Date.parse(FETCHED)) / 86_400_000) : null

function Tile({ k, v, s, tone }: { k: string; v: string; s?: string; tone?: string }) {
  return (
    <div className="tile">
      <div className="k">{k}</div>
      <div className={`v${tone ? ` ${tone}` : ''}`}>{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  )
}

const DISK = onDisk()
const DESIGN = designOnDisk()
const CARD_COUNT = DISK.length




export function App() {
  const [cards, setCards] = useState<Card[]>(() => readDraft() ?? DISK)
  const [disk, setDisk] = useState<Card[]>(DISK)
  const [pick, setPick] = useState(() => Math.min(readPick(), CARD_COUNT - 1))
  const [hover, setHover] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pricing, setPricing] = useState(false)
  const [asJson, setAsJson] = useState(false)
  const [copied, setCopied] = useState(false)
  const [design, setDesign] = useState<Design>(() => readDesign() ?? DESIGN)
  const [view, setView] = useState<'cards' | 'analytics'>('cards')

  // The design (min/max/bend per card) is part of the draft too: it feeds every rebalance,
  // so a slider twitch that only touched the browser copy must show as unsaved, not hide in
  // localStorage steering solves while the disk says otherwise.
  const [designDisk, setDesignDisk] = useState<Design>(DESIGN)
  const dirty = !same(cards, disk) || JSON.stringify(design) !== JSON.stringify(designDisk)

  // a reload should never cost an afternoon of tuning
  useEffect(() => {
    if (dirty) writeDraft(cards); else clearDraft()
  }, [cards, dirty])

  useEffect(() => { writeDesign(design) }, [design])
  useEffect(() => { writePick(pick) }, [pick])

  const save = async () => {
    try {
      await saveToDisk(cards)
      await saveDesign(design)
      clearDraft()
      // the written file is the new baseline; no reload, so the open card stays open
      setDisk(structuredClone(cards))
      setDesignDisk(structuredClone(design))
      setStatus('saved')
      setTimeout(() => setStatus(null), 1500)
    } catch (e) {
      setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Re-pull token prices (scripts/fetch-prices.mjs, via the dev server), then reload so the value
  // columns reflect them. Prizes do not follow — rebuild the ladder separately.
  const updatePrices = async () => {
    setPricing(true)
    setStatus('fetching prices…')
    try {
      const r = await fetch('/__sheet/prices', { method: 'POST' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'fetch failed')
      setStatus('prices updated — reloading')
      setTimeout(() => window.location.reload(), 500)
    } catch (e) {
      setStatus(`price update failed — ${e instanceof Error ? e.message : String(e)}`)
      setPricing(false)
    }
  }

  const file = useRef<HTMLInputElement>(null)

  const upload = async (chosen: File) => {
    try {
      const next = parseSheet(await chosen.text())
      setCards(next)
      setPick(0)
      setSelected(null)
      setStatus(`loaded ${chosen.name} — ${next.length} cards, not saved yet`)
    } catch (e) {
      setStatus(`upload failed — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const discard = () => {
    clearDraft()
    clearDesign()
    setCards(disk)
    setDesign(structuredClone(designDisk))
    setSelected(null)
    setStatus(null)
  }
  const resetSeed = () => { setCards(seed()); setSelected(null); setStatus(null) }

  const card = cards[pick]
  const { min: minX, max: maxX, bend, top: topOneIn, winOneIn, turnover } =
    { ...DEFAULT_LADDER, ...design[card.id] }
  const setLadder = (next: Partial<typeof DEFAULT_LADDER>) =>
    setDesign(d => ({ ...d, [card.id]: { ...(d[card.id] ?? DEFAULT_LADDER), ...next } }))

  const summary = useMemo(() => analyse(card, PRICES), [card])
  const checks = useMemo(() => validate(card), [card])
  const broken = checks.filter(c => !c.ok).length

  // editing scopes can make an independent card overlap; settle it rather than let it lie
  const patch = (next: Card) =>
    setCards(cs => cs.map((c, i) => (i === pick ? settleRoll(next) : c)))

  /**
   * The machine-owned numbers — pool amounts, pool weights, pay weights — are solver outputs:
   * the five design knobs plus the card's shape decide them, and editing them by hand makes
   * the sheet and the curve two competing truths (every "prizes keep drifting" episode was
   * that). Hand-tuning stays possible, but as an explicit unlock, not the default.
   */
  const [handTune, setHandTune] = useState(false)
  const guard = (what: string, run: () => void) => {
    if (handTune) return run()
    flashTool(`${what} is machine-owned — the solver sets it from the knobs. Unlock hand-tune to override.`)
  }
  const flashTool = (msg: string) => {
    setStatus(msg)
    setTimeout(() => setStatus(s => (s === msg ? null : s)), 3000)
  }

  /**
   * What the card costs, and everything the chain derives from that.
   *
   * Jackpot chance rides along because it is not a separate decision — it is a tenth of the price
   * by policy, so a card repriced without it becomes either a jackpot farm or a dead line, and
   * the two fields would have to be kept in step by whoever remembered.
   *
   * Prizes do not follow automatically: they are multiples of the price, so re-pricing changes
   * what the sheet returns until the ladder is rebuilt. That is deliberately a separate button —
   * the amounts are rounded to numbers a player can read, and silently re-rounding them on every
   * keystroke would churn the whole pool while you typed.
   */
  const setPrice = (sol: number) => {
    const priceLamports = Math.round(sol * 1e9)
    patch({ ...card, priceLamports, jackpotHitWeight: jackpotHitFor(priceLamports) })
  }

  // ── pool
  const setPoolAmount = (i: number, amount: number) => guard('A printed prize', () =>
    patch({ ...card, pool: card.pool.map((p, j) => (j === i ? { ...p, amount } : p)) }))

  /** A new token arrives live: a share like the rarest existing one, and a comparable prize. */
  const addToken = (token: string) => {
    const weight = Math.min(...card.pool.map(p => p.weight).filter(w => w > 0), TOTAL)
    const pool = [...card.pool, { token, weight, amount: matchingAmount(card, PRICES, token) }]
    const fixed = normalize(pool.map(p => p.weight))
    patch({ ...card, pool: pool.map((p, i) => ({ ...p, weight: fixed[i] })) })
  }

  const removeToken = (i: number) =>
    patch({ ...card, pool: card.pool.filter((_, j) => j !== i) })

  /** Reorder the ladder — position decides the weight, so moving a token changes its rarity. */
  const reorderToken = (from: number, to: number) => {
    if (from === to) return
    const pool = [...card.pool]
    const [moved] = pool.splice(from, 1)
    pool.splice(to, 0, moved)
    patch({ ...card, pool })
  }

  /** Cheapest prize first, so the ladder reads the way the weights are about to be laid on it. */
  const sortByValue = () => {
    const value = (p: { token: string; amount: number }) =>
      (p.amount / 10 ** (p.token === 'SOL' ? 9 : 0)) * (PRICES[p.token] ?? 0)
    patch({ ...card, pool: [...card.pool].sort((a, b) => value(a) - value(b)) })
  }

  /** Deepest token last, so the rarest slot goes to whatever the house can most easily buy. */
  const sortByCap = () =>
    patch({
      ...card,
      pool: [...card.pool].sort((a, b) => (MCAP[a.token] ?? 0) - (MCAP[b.token] ?? 0)),
    })

  /**
   * Sets the pin so the headline lands once per `TOP_TURNOVER` of sales, whatever the ticket
   * costs. A 1-in-500,000 top prize is generous on a 0.002 card and unreachable on a 0.25 one —
   * the same logic as `hitBp = price × 1000 bp per SOL` for the jackpot.
   */
  const solveForTargets = () => {
    const t = solveTargets(card, PRICES, minX, winOneIn, turnover, TARGET_RTP)
    setLadder({ bend: t.bend, max: t.max, top: 0 })
    setStatus(`bend ${t.bend.toFixed(2)}, max ${Math.round(t.max)}× → wins 1 in ` +
      `${t.winOneIn.toFixed(1)}, top prize every ${Math.round(t.turnover).toLocaleString()} SOL — press Build ladder`)
  }

  /** Prizes from the two ends of the ladder, weights from the bend, RTP from the pay table. */
  const applyLadder = () => {
    const { amounts, weights, payWeights, rtp, overrun, topOdds } =
      solveLadder(card, PRICES, minX, maxX, bend, TARGET_RTP, topOneIn)
    patch({
      ...card,
      pool: card.pool.map((p, i) => ({ ...p, amount: amounts[i], weight: weights[i] })),
      pays: card.pays.map((p, i) => ({ ...p, weight: payWeights[i] })),
    })
    setStatus(overrun > 1
      ? `pay table alone spans ${(overrun * (maxX / minX)).toFixed(0)}×, so every token takes the ` +
        `same value and the top prize lands at ${Math.round(minX * overrun * (maxX / minX))}×, not ${Math.round(maxX)}× ` +
        `— shorten the pay ladder or raise max`
      : Math.abs(rtp - TARGET_RTP) > 0.02
        ? `landed at ${pct(rtp)}, not ${pct(TARGET_RTP, 0)} — the odds hit their ceiling`
        : topOneIn > 0 && Math.abs(topOdds - topOneIn) > topOneIn * 0.05
          ? `top prize pinned at 1 in ${fmt(topOneIn)} but landed 1 in ${fmt(topOdds)}`
          : null)
  }

  /**
   * Every card back on its design curve at today's prices: prizes re-fitted and rounded, odds
   * landing RTP. Prizes drift off the curve continuously as tokens move, so both halves update
   * — the rebalance is around the RTP, not around the printed numbers.
   */
  const rebalanceAll = () => {
    const moved: string[] = []
    const solved: Record<string, { bend: number }> = {}
    const next = cards.map(c => {
      const d = { ...DEFAULT_LADDER, ...design[c.id] }
      // bend and (under the odds cap) max are outputs of the aims, not stored taste:
      // both re-derive at today's prices, and the design records what was solved
      // the solved max is derived, never stored: writing it back would ratchet the design down
      const { bend, ladder: L } = solveShelf(c, PRICES, d, TARGET_RTP)
      solved[c.id] = { bend }
      const reprinted = c.pool.filter((p, i) => p.amount !== L.amounts[i]).map(p => p.token)
      if (reprinted.length) moved.push(`${c.id}: ${reprinted.join(' ')}`)
      return settleRoll({
        ...c,
        jackpotHitWeight: jackpotHitFor(c.priceLamports),
        pool: c.pool.map((p, i) => ({ ...p, amount: L.amounts[i], weight: L.weights[i] })),
        pays: c.pays.map((p, i) => ({ ...p, weight: L.payWeights[i] })),
      })
    })
    setCards(next)
    setDesign(ds => ({ ...ds, ...Object.fromEntries(cards.map(c =>
      [c.id, { ...(ds[c.id] ?? DEFAULT_LADDER), ...solved[c.id] }])) }))
    setStatus(moved.length ? `rebalanced — prizes moved on ${moved.join('; ')}` : 'rebalanced — no prize moved')
  }


  const renormalisePool = () => guard('The pool partition', () => {
    const fixed = normalize(card.pool.map(p => p.weight))
    patch({ ...card, pool: card.pool.map((p, i) => ({ ...p, weight: fixed[i] })) })
  })

  /**
   * Lands token RTP on target using printable prize amounts only. Weights are untouched —
   * the odds a player is shown do not move when only the prices did.
   */

  const solveTheOdds = () => {
    const { weights, clamped } = solveOdds(card, PRICES, TARGET_RTP)
    patch({ ...card, pays: card.pays.map((p, i) => ({ ...p, weight: weights[i] })) })
    setStatus(clamped ? 'odds hit the 2³² ceiling before reaching target' : null)
  }


  const snapAmounts = () => guard('The printed prizes', () =>
    patch({ ...card, pool: card.pool.map(p => ({ ...p, amount: nice(p.amount, p.token) })) }))

  // ── pays: shape (scope, min, mult, flags) is the designer's; weights are the solver's
  const setPay = (i: number, next: Partial<Pay>) => {
    if ('weight' in next) return guard('A pay weight', () =>
      patch({ ...card, pays: card.pays.map((p, j) => (j === i ? { ...p, ...next } : p)) }))
    patch({ ...card, pays: card.pays.map((p, j) => (j === i ? { ...p, ...next } : p)) })
  }

  const firstCells = (n: number) => {
    const body = bodyLen(card)
    let mask = 0
    for (let i = 0; i < Math.min(n, body); i++) mask |= 1 << i
    return mask >>> 0
  }

  const addPay = () => {
    const scope = firstCells(3)
    const pay: Pay = { scope, weight: 0, min: Math.max(1, popcount(scope)), flags: 0, mult: 1 }
    patch({ ...card, pays: [...card.pays, pay] })
    setSelected(card.pays.length)
  }

  const duplicatePay = (i: number) => {
    const copy = { ...card.pays[i] }
    const pays = [...card.pays]
    pays.splice(i + 1, 0, copy)
    patch({ ...card, pays })
    setSelected(i + 1)
  }

  const removePay = (i: number) => {
    patch({ ...card, pays: card.pays.filter((_, j) => j !== i) })
    setSelected(null)
  }

  /** Every outcome takes an equal share of what the pay table already commits. */
  const evenSplit = () => guard('The pay weights', () => {
    const total = card.pays.reduce((n, p) => n + p.weight, 0)
    const each = normalize(card.pays.map(() => 1), total)
    patch({ ...card, pays: card.pays.map((p, i) => ({ ...p, weight: each[i] })) })
  })

  /** Click a body cell to add or drop it from the selected scope. */
  const toggleCell = (cell: number) => {
    if (selected === null) return
    const pay = card.pays[selected]
    const scope = (pay.scope ^ (1 << cell)) >>> 0
    setPay(selected, { scope, min: Math.min(pay.min, Math.max(popcount(scope), 1)) })
  }

  // ── blocks
  const setBlock = (i: number, next: Partial<Block>) =>
    patch({ ...card, blocks: card.blocks.map((b, j) => (j === i ? { ...b, ...next } : b)) })

  const addBlock = () => {
    const block: Block = { role: 'plate', count: 3, cols: 3, flags: 0, a: 0, b: 0 }
    const at = card.blocks.findIndex(b => b.role === 'jackpot')
    const blocks = [...card.blocks]
    blocks.splice(at < 0 ? blocks.length : at, 0, block)
    patch({ ...card, blocks })
  }

  const removeBlock = (i: number) =>
    patch({ ...card, blocks: card.blocks.filter((_, j) => j !== i) })

  const scope = hover ?? (selected !== null ? card.pays[selected]?.scope ?? null : null)
  const rtpTone =
    Math.abs(summary.tokenRtp - TARGET_RTP) < 0.02 ? 'good'
      : summary.tokenRtp > TARGET_RTP ? 'bad' : 'warn'

  return (
    <div className="app">
      <div className="topbar">
        <h1>Sheet</h1>
        <div className="tabs" role="tablist">
          {cards.map((c, i) => (
            <button key={c.id} className="tab" role="tab"
              aria-selected={view === 'cards' && i === pick}
              onClick={() => { setView('cards'); setPick(i); setSelected(null); setHover(null) }}>
              {c.name}
            </button>
          ))}
          <button className="tab" role="tab" aria-selected={view === 'analytics'}
            onClick={() => setView('analytics')}
            title="the deployed game's counters — live tiles and the recorded history, graphed">
            Analytics
          </button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="tab" onClick={rebalanceAll}
            title="every card back on its curve at today's prices — prizes re-fitted and rounded, odds landing RTP">
            Rebalance all
          </button>
          <button className="tab" aria-selected={handTune} onClick={() => setHandTune(h => !h)}
            title="the solver owns prizes and weights; unlock to override them by hand">
            {handTune ? 'Hand-tune 🔓' : 'Hand-tune 🔒'}
          </button>
          {handTune && <button className="tab" onClick={renormalisePool}>Renormalise pool</button>}
          {handTune && <button className="tab" onClick={snapAmounts}>Snap prizes</button>}
          <button className="tab" onClick={updatePrices} disabled={pricing}
            title="re-pull token prices from the live feed">
            {pricing ? 'Updating…' : 'Update prices'}
          </button>
          <button className="tab" onClick={resetSeed} title="back to today's sheet, converted">
            Reset to seed
          </button>
          <input
            ref={file} type="file" accept="application/json,.json" hidden
            onChange={e => {
              const chosen = e.target.files?.[0]
              e.target.value = ''
              if (chosen) upload(chosen)
            }}
          />
          <button className="tab" onClick={() => file.current?.click()}
            title="load a cards.json from anywhere">
            Upload config
          </button>
          <button className="tab" onClick={discard} disabled={!dirty}>Discard</button>
          <button className={`tab save${dirty ? ' dirty' : ''}`} onClick={save} disabled={!dirty}>
            {dirty ? 'Save to disk' : 'Saved'}
          </button>
        </div>
      </div>

      {(dirty || status) && (
        <div className="banner save">
          <strong>{status ?? 'Unsaved changes'}</strong>
          <span>
            {dirty
              ? 'kept in this browser until you save — writes to tools/sheet/cards.json'
              : 'in sync with tools/sheet/cards.json'}
          </span>
        </div>
      )}

      {AGE_DAYS !== null && AGE_DAYS > 1 && (
        <div className="banner">
          <strong>Prices are {AGE_DAYS} days old</strong>
          <span>
            fetched {FETCHED!.slice(0, 10)} — refresh before trusting any value column.{' '}
            <button className="mini" onClick={updatePrices} disabled={pricing}>
              {pricing ? 'Updating…' : 'Update prices'}
            </button>
          </span>
        </div>
      )}

      {view === 'analytics' && (
        <AnalyticsView cardNames={cards.map(c => c.name)} solUsd={PRICES.SOL ?? 0} />
      )}

      {view === 'cards' && <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <Tile k="Token RTP" v={pct(summary.tokenRtp)} tone={rtpTone} s={`target ${pct(TARGET_RTP, 0)}`} />
        <Tile k="Jackpot" v={pct(summary.jackpotShare, 0)} s="take, pot-funded" />
        <Tile k="House edge" v={pct(summary.houseEdge)}
          tone={summary.houseEdge < 0 ? 'bad' : undefined} s="after both" />
        <Tile k="Wins something" v={summary.winRate > 0 ? `1 in ${fmt(1 / summary.winRate, 1)}` : '—'}
          s={pct(summary.winRate, 1)} />
        <Tile k="Top prize" v={summary.top ? `${fmt(summary.top.multiple)}×` : '—'}
          s={summary.top ? `${usd(summary.top.usd)} · 1 in ${fmt(1 / summary.top.p)}` : undefined} />
        <Tile k="Ticket" v={`${summary.priceSol} SOL`} s={usd(summary.priceUsd)} />
        <Tile k="Checks" v={broken === 0 ? 'pass' : `${broken} fail`}
          tone={broken === 0 ? 'good' : 'bad'} s={`${checks.length} rules`} />
      </div>


      <div className="grid cols-preview" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Layout</h2>
          <CardPreview card={card} scope={scope} editing={selected !== null}
            onToggleCell={toggleCell} />
          <h2 style={{ marginTop: 16 }}>Blocks</h2>
          <BlockTable card={card} onBlock={setBlock} onAdd={addBlock} onRemove={removeBlock} />
        </div>
        <div className="card">
          <h2>Pay table — {card.pays.length} outcomes</h2>
          <PayTable
            card={card} summary={summary} selected={selected}
            onSelect={setSelected} onHover={setHover} onPay={setPay}
            onAdd={addPay} onDuplicate={duplicatePay} onRemove={removePay} onEven={evenSplit}
            onRoll={roll => patch({ ...card, roll })}
          />
          <div className="note">
            {card.roll === 'exclusive'
              ? <>One draw out of 2³². The shortfall is the miss rate: <strong>{pct(1 - summary.paySum / TOTAL)}</strong> of cards pay nothing in tokens.</>
              : <>One draw per entry. <strong>{pct(1 - summary.winRate)}</strong> of cards pay nothing, averaging {summary.expectedWins.toFixed(2)} wins per card.</>}
            {' '}Click a row to edit its scope on the grid.
          </div>
          <div className="poolsolve">
            <button className="tab" onClick={solveTheOdds}>
              Balance on the odds → {pct(TARGET_RTP, 0)}
            </button>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              scales every weight by one factor · prizes untouched · a player sees the card pay
              more or less often
            </span>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Pool</h2>
          <PoolTable card={card} summary={summary} prices={PRICES}
            onAmount={setPoolAmount}
            onAddToken={addToken} onRemoveToken={removeToken} onReorder={reorderToken} />
          <div className="poolsolve">
            <button className="tab" onClick={sortByValue}>Order by prize value</button>
            <button className="tab" onClick={sortByCap}>Order by market cap</button>
          </div>
          <div className="poolsolve">
            <label>
              Ticket
              <NumberField value={card.priceLamports / 1e9} width={76} min={0}
                onChange={setPrice} />
              SOL
              <strong style={{ width: 56 }}>{usd(summary.priceUsd)}</strong>
            </label>
            <label>
              Prize range
              <RangeSlider lo={minX} hi={maxX} min={0.05} max={2000}
                onChange={(a, b) => setLadder({ min: a, max: b })} />
              <strong style={{ width: 92 }}>
                {minX < 1 ? minX.toFixed(2) : Math.round(minX)}× – {Math.round(maxX)}×
              </strong>
            </label>
            <label>
              Bend
              <input type="range" min={0} max={8} step={0.05} value={bend}
                onChange={e => setLadder({ bend: Number(e.target.value) })} />
              <strong>{bend.toFixed(2)}</strong>
            </label>
            <label>
              Top prize 1 in
              <NumberField
                value={topOneIn} width={84} min={1} emptyValue={0} placeholder="on curve"
                onChange={top => setLadder({ top })}
              />
            </label>
            <button className="tab" onClick={applyLadder}>Build ladder</button>
          </div>
          {/* Not knobs: these two derive bend and max from goals, then are done. Kept behind a
              fold so the always-on surface stays the five numbers that actually steer. */}
          <details className="note" style={{ marginTop: 6 }}>
            <summary>Derive bend &amp; max from targets…</summary>
            <div className="poolsolve" style={{ marginTop: 6 }}>
              <label>
                Wins 1 in
                <NumberField
                  value={winOneIn} width={56} min={1}
                  onChange={w => setLadder({ winOneIn: w })}
                />
              </label>
              <label>
                per
                <NumberField
                  value={turnover} width={72} min={1}
                  onChange={t => setLadder({ turnover: t })}
                />
                SOL
              </label>
              <button className="tab" onClick={solveForTargets}
                title={`Solve bend and max for a 1-in-${winOneIn} win rate and one top prize per ${turnover} SOL of sales, without lifting anything off the curve`}>
                Solve
              </button>
            </div>
          </details>
          <div className="note" style={{ marginTop: 6 }}>
            {(() => {
              const { rungs, tiers, pay, pool, top } = ladderSplit(card, minX, maxX)
              return (
                <>
                  Spread: rungs <strong>{fmt(rungs, 1)}×</strong> · multiplier tiers{' '}
                  <strong>{fmt(tiers, 1)}×</strong> · pool <strong>{fmt(pool, 2)}×</strong>
                  {' '}→ top prize <strong>{fmt(top, 0)}×</strong>
                  {pool <= 1 && (
                    <> — the pay table alone spans {fmt(pay, 0)}×, past the {Math.round(maxX)}× you
                    asked for, so every token takes the same value. Shorten whichever of the two is
                    larger to give the pool room back.</>
                  )}
                </>
              )
            })()}
          </div>
          <div className="note">
            The ends pin the cheapest and dearest token; the rest interpolate. <strong>Bend</strong>
            {' '}decides how the weight sits on that ladder — 0 uniform, 1 equal share of return per
            token, above 1 piles the mass onto the cheap end so most wins are small. Prizes and pool
            weights come out of this; RTP is then landed on the pay table, so the card pays more or
            less often and no printed prize moves.
          </div>

          {summary.missingPrices.length > 0 && (
            <div className="note">
              No price for {summary.missingPrices.join(', ')} — counted as zero, so RTP is understated.
            </div>
          )}
        </div>
        <div className="card">
          <h2>Where the return sits</h2>
          <BandChart summary={summary} />
          <div className="note">
            A retail scratch card puts roughly 70% of its prize pool below 5× the ticket and buys a
            headline with 2–4%. This is the panel that shows whether the money is in the wrong place.
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Prizes</h2>
          <PrizeList summary={summary} />
          <div className="note">
            One row per distinct prize, largest first — several outcomes can pay the same amount,
            and the player only sees the amount. Biggest single payout{' '}
            <strong>{summary.top ? usd(summary.top.usd) : '—'}</strong>
            {card.roll === 'independent' && summary.top &&
              `, up to ${usd(summary.maxCardUsd)} if every outcome lands at once`}.
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Validation</h2>
          <div className="checks">
            {checks.map(c => (
              <div key={c.label} className={`check ${c.ok ? 'ok' : 'no'}`}>
                <span className="dot">{c.ok ? '●' : '▲'}</span>
                <span className="label">{c.label}</span>
                <span className="detail">{c.detail}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Export</h2>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
              <button className="tab" aria-selected={!asJson} onClick={() => setAsJson(false)}>
                sheet
              </button>
              <button className="tab" aria-selected={asJson} onClick={() => setAsJson(true)}>
                json
              </button>
              <button className="tab" onClick={() => {
                navigator.clipboard.writeText(asJson ? toJson(card) : toAuthoring(card))
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}>
                {copied ? 'copied' : 'copy'}
              </button>
            </span>
          </div>
          <pre>{asJson ? toJson(card) : toAuthoring(card)}</pre>
        </div>
      </div>
      </>}
    </div>
  )
}
