import { useState } from 'react'
import { TOTAL, decimalsOf } from '../model/types'

/**
 * Weights are published out of 2³², which is unreadable and unusable to type.
 * Everything here is entered as a percentage and converted on the way in.
 */
export const toPct = (weight: number) => (weight / TOTAL) * 100
export const fromPct = (pct: number) => Math.round(Math.min(Math.max(pct, 0), 100) / 100 * TOTAL)

/** Enough digits to show a 1-in-a-billion outcome without trailing noise on a common one. */
export const showPct = (weight: number) => {
  const p = toPct(weight)
  if (p === 0) return '0'
  if (p >= 1) return String(+p.toFixed(4))
  return String(+p.toPrecision(4))
}

// log slider: 1e-6% (one in a hundred million) up to 100%, with 0 reserved for "never"
const MIN_L = -6, MAX_L = 2, STEPS = 1000

const sliderOf = (weight: number) => {
  const p = toPct(weight)
  if (p <= 0) return 0
  const t = ((Math.log10(p) - MIN_L) / (MAX_L - MIN_L)) * STEPS
  return Math.min(STEPS, Math.max(1, Math.round(t)))
}

const weightOf = (t: number) =>
  t <= 0 ? 0 : fromPct(10 ** (MIN_L + (t / STEPS) * (MAX_L - MIN_L)))

export function WeightInput({
  weight, onChange, slider = true,
}: {
  weight: number
  onChange: (weight: number) => void
  slider?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <span className="weight">
      <span className="pctwrap">
        <input
          type="text"
          inputMode="decimal"
          className="pct"
          value={draft ?? showPct(weight)}
          onChange={e => {
            const text = e.target.value
            setDraft(text)
            const n = Number(text)
            if (text.trim() !== '' && isFinite(n) && n >= 0) onChange(fromPct(n))
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="pctsign">%</span>
      </span>
      {slider && (
        <input
          type="range"
          min={0}
          max={STEPS}
          value={sliderOf(weight)}
          onChange={e => onChange(weightOf(Number(e.target.value)))}
          title={`${showPct(weight)}%  ·  weight ${weight.toLocaleString()}`}
        />
      )}
    </span>
  )
}

/** Prizes are stored in base units but read and typed as whole tokens. */
export function AmountInput({
  token, units, onChange,
}: {
  token: string
  units: number
  onChange: (units: number) => void
}) {
  const scale = 10 ** decimalsOf(token)
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(+(units / scale).toPrecision(9))

  return (
    <input
      type="text"
      inputMode="decimal"
      className="pct"
      style={{ width: 96 }}
      value={shown}
      onChange={e => {
        const text = e.target.value
        setDraft(text)
        const n = Number(text)
        if (text.trim() !== '' && isFinite(n) && n >= 0) onChange(Math.round(n * scale))
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

/**
 * A free-typed number. Keeps the raw text until blur so a half-finished "2." survives — a
 * controlled field that reformats on every keystroke eats the decimal point.
 */
export function NumberField({
  value, onChange, width = 56, min = 0, emptyValue, placeholder,
}: {
  value: number
  onChange: (value: number) => void
  width?: number
  min?: number
  emptyValue?: number
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <input
      type="text"
      inputMode="decimal"
      className="pct"
      style={{ width }}
      placeholder={placeholder}
      value={draft ?? (value ? String(value) : '')}
      onChange={e => {
        const text = e.target.value
        setDraft(text)
        if (text.trim() === '') {
          if (emptyValue !== undefined) onChange(emptyValue)
          return
        }
        const n = Number(text)
        if (isFinite(n) && n >= min) onChange(n)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
