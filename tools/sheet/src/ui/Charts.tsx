import { useState } from 'react'
import { Summary } from '../model/analytics'
import { fmt } from './format'

const W = 660, H = 220

/** A bar with only its data-end rounded, anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.max(0, Math.min(r, w, h / 2))
  if (w <= 0) return ''
  return `M${x},${y} H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} ` +
    `V${y + h - rr} A${rr},${rr} 0 0 1 ${x + w - rr},${y + h} H${x} Z`
}

function Tip({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  const w = Math.max(...lines.map(l => l.length)) * 6.1 + 16
  const h = lines.length * 15 + 10
  const px = Math.min(Math.max(x + 10, 2), W - w - 2)
  const py = Math.min(Math.max(y - h - 8, 2), H - h - 2)
  return (
    <g pointerEvents="none">
      <rect x={px} y={py} width={w} height={h} rx={6}
        fill="var(--raised)" stroke="var(--border)" />
      {lines.map((l, i) => (
        <text key={i} x={px + 8} y={py + 17 + i * 15}
          fontSize={11} fill={i === 0 ? 'var(--text-primary)' : 'var(--text-secondary)'}>
          {l}
        </text>
      ))}
    </g>
  )
}

/**
 * Where the return sits, by prize size. One series, so the bars carry their own
 * labels and there is nothing to key off colour.
 */
export function BandChart({ summary }: { summary: Summary }) {
  const [hover, setHover] = useState<number | null>(null)
  const bands = summary.bands
  const left = 108, right = 58, top = 8, bottom = 22
  const plot = W - left - right
  const rowH = (H - top - bottom) / bands.length
  const max = Math.max(...bands.map(b => b.rtp), 0.01)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}
      role="img" aria-label="Share of return by prize size">
      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <line key={t} x1={left + plot * t} x2={left + plot * t} y1={top} y2={H - bottom}
          stroke="var(--grid)" strokeWidth={1} />
      ))}
      <line x1={left} x2={left} y1={top} y2={H - bottom} stroke="var(--axis)" strokeWidth={1} />

      {bands.map((b, i) => {
        const h = Math.max(rowH - 8, 6)
        const y = top + i * rowH + 4
        const w = (b.rtp / max) * plot
        return (
          <g key={b.label}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={0} y={top + i * rowH} width={W} height={rowH} fill="transparent" />
            <text x={left - 9} y={y + h / 2 + 4} fontSize={11} textAnchor="end"
              fill="var(--text-secondary)">{b.label}</text>
            <path d={barPath(left, y, w, h)} fill="var(--series-1)"
              opacity={hover === null || hover === i ? 1 : 0.45} />
            <text x={left + w + 7} y={y + h / 2 + 4} fontSize={11}
              fill="var(--text-secondary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {(b.rtp * 100).toFixed(1)}%
            </text>
          </g>
        )
      })}

      {[0, 0.5, 1].map(t => (
        <text key={t} x={left + plot * t} y={H - 7} fontSize={10} textAnchor="middle"
          fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {(max * t * 100).toFixed(0)}%
        </text>
      ))}

      {hover !== null && (
        <Tip x={left + (bands[hover].rtp / max) * plot} y={top + hover * rowH + rowH / 2}
          lines={[
            bands[hover].label,
            `${(bands[hover].rtp * 100).toFixed(2)}% of the card price`,
            `hits ${bands[hover].p > 0 ? `1 in ${fmt(1 / bands[hover].p)}` : 'never'}`,
          ]} />
      )}
    </svg>
  )
}
