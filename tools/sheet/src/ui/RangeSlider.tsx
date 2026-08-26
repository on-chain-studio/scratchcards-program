/** Two handles on one log track — the low and high end of the prize ladder. */
export function RangeSlider({
  lo, hi, min, max, onChange,
}: {
  lo: number
  hi: number
  min: number
  max: number
  onChange: (lo: number, hi: number) => void
}) {
  const L = Math.log10(min), H = Math.log10(max)
  const pos = (v: number) => ((Math.log10(v) - L) / (H - L)) * 1000
  const val = (t: number) => 10 ** (L + (t / 1000) * (H - L))

  return (
    <span className="dual">
      <span className="dual-track">
        <span
          className="dual-fill"
          style={{ left: `${pos(lo) / 10}%`, right: `${100 - pos(hi) / 10}%` }}
        />
      </span>
      <input
        type="range" min={0} max={1000} value={pos(lo)}
        onChange={e => onChange(Math.min(val(Number(e.target.value)), hi * 0.9), hi)}
      />
      <input
        type="range" min={0} max={1000} value={pos(hi)}
        onChange={e => onChange(lo, Math.max(val(Number(e.target.value)), lo * 1.1))}
      />
    </span>
  )
}
