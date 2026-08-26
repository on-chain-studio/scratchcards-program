import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * The deployed game's counters — live tiles fed by the dev server's rollup subscription, and
 * the recorded history graphed over a chosen range. History exists only while a dev server was
 * running to record it: the on-chain account holds lifetime totals, not a time series.
 */

type Live = {
  ok: boolean; error?: string; where?: string
  lamportsIn: string; jackpotIn: string; jackpotPaid: string; jackpotHits: number
  cardsSold: number[]; cardsCollected: number[]
  payouts: { token: string; amount: string; whole: number }[]
}
type Row = Live & { t: number }
type Cluster = 'mainnet' | 'devnet'

const PRESETS: [string, number][] = [
  ['1h', 3600e3], ['24h', 86400e3], ['7d', 7 * 86400e3], ['30d', 30 * 86400e3],
]

const sol = (lamports: string | number) => Number(lamports) / 1e9
const sum = (a: number[]) => a.reduce((n, v) => n + v, 0)

/** metric key → label + how to read it off a state row */
function metricsOf(rows: Row[], live: Live | null): Record<string, { label: string; read: (r: Live) => number; unit: string }> {
  const m: Record<string, { label: string; read: (r: Live) => number; unit: string }> = {
    takenIn: { label: 'Taken in', read: r => sol(r.lamportsIn), unit: 'SOL' },
    potFed: { label: 'Jackpot pot fed', read: r => sol(r.jackpotIn), unit: 'SOL' },
    jackpotsPaid: { label: 'Jackpots paid', read: r => sol(r.jackpotPaid), unit: 'SOL' },
    sold: { label: 'Cards sold', read: r => sum(r.cardsSold), unit: 'cards' },
    collected: { label: 'Cards collected', read: r => sum(r.cardsCollected), unit: 'cards' },
  }
  const tokens = new Set<string>()
  for (const r of rows) for (const p of r.payouts ?? []) tokens.add(p.token)
  for (const p of live?.payouts ?? []) tokens.add(p.token)
  for (const t of [...tokens].sort()) {
    m[`paid:${t}`] = {
      label: `Paid out · ${t}`, unit: t,
      read: r => (r.payouts ?? []).find(p => p.token === t)?.whole ?? 0,
    }
  }
  return m
}

function Tile({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="tile">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  )
}

const fmtVal = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 3 : 1 })
const fmtTime = (t: number, spanMs: number) => {
  const d = new Date(t)
  return spanMs > 2 * 86400e3
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
const toLocalInput = (t: number) => {
  const d = new Date(t - new Date().getTimezoneOffset() * 60e3)
  return d.toISOString().slice(0, 16)
}

/** Round tick times over the viewed window: pick a step that yields ~4-6 ticks, align to it. */
function timeTicks(t0: number, t1: number): number[] {
  const steps = [60e3, 300e3, 900e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
    86400e3, 2 * 86400e3, 7 * 86400e3, 30 * 86400e3]
  const step = steps.find(s => (t1 - t0) / s <= 6) ?? steps[steps.length - 1]
  // day-sized steps align to local midnight (t ≡ offset mod day), smaller ones to plain multiples
  const align = step >= 86400e3 ? new Date().getTimezoneOffset() * 60e3 : 0
  const ticks: number[] = []
  for (let t = Math.ceil((t0 - align) / step) * step + align; t <= t1; t += step) ticks.push(t)
  return ticks.length ? ticks : [t0, t1]
}

/** One series over time: 2px line in series-1, recessive grid, crosshair + tooltip on hover. */
function LineChart({ points, unit, domain }: {
  points: { t: number; v: number }[]; unit: string; domain: [number, number]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const W = 720, H = 220, left = 56, right = 16, top = 12, bottom = 26

  if (points.length === 0) {
    return <div className="note" style={{ padding: 24 }}>
      No history in this range. The recorder runs while the sheet tool's dev server is up —
      history starts accumulating from the first time this tab is opened.
    </div>
  }

  // the axis is the window the user asked for, not the data extent — one lonely sample
  // still sits on a full, legible timeline
  const [t0, t1] = domain
  const span = Math.max(t1 - t0, 1)
  const vMin = Math.min(...points.map(p => p.v)), vMax = Math.max(...points.map(p => p.v))
  const pad = (vMax - vMin) * 0.08 || Math.max(vMax * 0.08, 1e-9)
  const lo = Math.max(0, vMin - pad), hi = vMax + pad
  const x = (t: number) => left + ((t - t0) / span) * (W - left - right)
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (H - top - bottom)

  // counters hold between changes: step-after segments, and the last value carries to the edge
  const last = points[points.length - 1]
  const path = points.map((p, i) =>
    i === 0 ? `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
      : `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`).join('')
    + (last.t < t1 ? `H${x(t1).toFixed(1)}` : '')
  const yTicks = [lo, (lo + hi) / 2, hi]
  const xTicks = timeTicks(t0, t1)
  const hovered = hover !== null ? points[hover] : null

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = ((e.clientX - rect.left) / rect.width) * W
    let best = 0, bestD = Infinity
    points.forEach((p, i) => {
      const d = Math.abs(x(p.t) - mx)
      if (d < bestD) { bestD = d; best = i }
    })
    setHover(best)
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={left} x2={W - right} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
            <text x={left - 8} y={y(v) + 4} textAnchor="end" fontSize={10} fill="var(--muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtVal(v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)">
            {fmtTime(t, span)}
          </text>
        ))}
        <line x1={left} x2={W - right} y1={H - bottom} y2={H - bottom} stroke="var(--axis)" strokeWidth={1} />
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round" />
        {/* the newest value, labeled directly — text in ink, identity from the mark beside it */}
        <circle cx={x(last.t)} cy={y(last.v)} r={3.5} fill="var(--series-1)" />
        <text x={Math.min(x(last.t) + 8, W - right - 4)} y={y(last.v) - 8} fontSize={11}
          textAnchor={x(last.t) > W - 120 ? 'end' : 'start'}
          fill="var(--text-primary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtVal(last.v)} {unit}
        </text>
        {hovered && (
          <g>
            <line x1={x(hovered.t)} x2={x(hovered.t)} y1={top} y2={H - bottom}
              stroke="var(--axis)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hovered.t)} cy={y(hovered.v)} r={4.5} fill="var(--series-1)"
              stroke="var(--surface-1)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hovered && (
        <div style={{
          position: 'absolute', left: `${(x(hovered.t) / W) * 100}%`, top: 0,
          transform: `translateX(${x(hovered.t) > W * 0.7 ? '-105%' : '8px'})`,
          background: 'var(--raised)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '5px 9px', pointerEvents: 'none', fontSize: 11, whiteSpace: 'nowrap',
        }}>
          <div style={{ color: 'var(--muted)' }}>{new Date(hovered.t).toLocaleString()}</div>
          <div style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtVal(hovered.v)} {unit}
          </div>
        </div>
      )}
    </div>
  )
}

export function AnalyticsView({ cardNames, solUsd }: { cardNames: string[]; solUsd: number }) {
  const [cluster, setCluster] = useState<Cluster>('mainnet')
  const [live, setLive] = useState<Live | null>(null)
  const [to, setTo] = useState(() => Date.now())
  const [from, setFrom] = useState(() => Date.now() - 86400e3)
  const [pinnedToNow, setPinnedToNow] = useState(true)
  const [rows, setRows] = useState<Row[]>([])
  const [metric, setMetric] = useState('takenIn')
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    setLive(null)
    const es = new EventSource(`/__sheet/analytics/stream?cluster=${cluster}`)
    es.onmessage = ev => {
      try { setLive(JSON.parse(ev.data) as Live) } catch { /* not a state line */ }
    }
    return () => es.close()
  }, [cluster])

  // the graph follows the live feed: a new event refreshes the range when "to" rides now
  useEffect(() => {
    const end = pinnedToNow ? Date.now() : to
    fetch(`/__sheet/analytics/history?cluster=${cluster}&from=${from}&to=${end}`)
      .then(r => r.json()).then(r => Array.isArray(r) ? setRows(r) : setRows([]))
      .catch(() => setRows([]))
  }, [cluster, from, to, pinnedToNow, live])

  const metrics = useMemo(() => metricsOf(rows, live), [rows, live])
  const m = metrics[metric] ?? metrics.takenIn
  const points = useMemo(() => rows.map(r => ({ t: r.t, v: m.read(r) })), [rows, m])
  const delta = points.length >= 2 ? points[points.length - 1].v - points[0].v : 0
  const perCard = (a: number[]) => a
    .map((n, i) => (n > 0 ? `${cardNames[i] ?? `#${i}`} ×${n}` : null))
    .filter(Boolean).join(' · ') || undefined

  return (
    <>
      {live && !live.ok && (
        <div className="banner"><strong>Analytics unavailable</strong><span>{live.error}</span></div>
      )}
      {live?.ok && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <Tile k="Taken in" v={`${fmtVal(sol(live.lamportsIn))} SOL`}
            s={`$${(sol(live.lamportsIn) * solUsd).toFixed(2)} — ${live.where}`} />
          <Tile k="Jackpot pot fed" v={`${fmtVal(sol(live.jackpotIn))} SOL`} s="10% of every sale" />
          <Tile k="Jackpots hit" v={`${live.jackpotHits}`} s={`${fmtVal(sol(live.jackpotPaid))} SOL paid`} />
          <Tile k="Cards sold" v={`${sum(live.cardsSold)}`} s={perCard(live.cardsSold)} />
          <Tile k="Collected" v={`${sum(live.cardsCollected)}`} s={perCard(live.cardsCollected)} />
          <Tile k="Paid out" v={live.payouts.length ? `${live.payouts.length} token${live.payouts.length === 1 ? '' : 's'}` : '—'}
            s={live.payouts.map(p => `${fmtVal(p.whole)} ${p.token}`).join(' · ') || 'nothing yet'} />
        </div>
      )}

      <div className="card">
        <h2>{m.label} over time</h2>
        <div className="poolsolve" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {(['mainnet', 'devnet'] as Cluster[]).map(c => (
              <button key={c} className="tab" aria-selected={cluster === c} onClick={() => setCluster(c)}>{c}</button>
            ))}
          </span>
          <select value={metric} onChange={e => setMetric(e.target.value)}>
            {Object.entries(metrics).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          {PRESETS.map(([label, ms]) => (
            <button key={label} className="mini" onClick={() => {
              setFrom(Date.now() - ms); setTo(Date.now()); setPinnedToNow(true)
            }}>{label}</button>
          ))}
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            from
            <input type="datetime-local" value={toLocalInput(from)}
              onChange={e => { const t = Date.parse(e.target.value); if (t) setFrom(t) }} />
          </label>
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            to
            <input type="datetime-local" value={toLocalInput(pinnedToNow ? Date.now() : to)}
              onChange={e => { const t = Date.parse(e.target.value); if (t) { setTo(t); setPinnedToNow(false) } }} />
          </label>
          {!pinnedToNow && <button className="mini" onClick={() => setPinnedToNow(true)}>follow now</button>}
        </div>
        <LineChart points={points} unit={m.unit} domain={[from, pinnedToNow ? Date.now() : to]} />
        <div className="note">
          {points.length
            ? <>In range: <strong>{fmtVal(delta)} {m.unit}</strong> across {points.length} recorded change{points.length === 1 ? '' : 's'}.</>
            : 'Lifetime totals live on chain; the time series is recorded by this tool while it runs.'}
          {' '}<button className="mini" onClick={() => setShowTable(s => !s)}>{showTable ? 'hide table' : 'table'}</button>
        </div>
        {showTable && (
          <div className="scroll" style={{ maxHeight: 220 }}>
            <table>
              <thead><tr><th>time</th><th>{m.label}</th></tr></thead>
              <tbody>
                {points.map((p, i) => (
                  <tr key={i}>
                    <td>{new Date(p.t).toLocaleString()}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtVal(p.v)} {m.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
