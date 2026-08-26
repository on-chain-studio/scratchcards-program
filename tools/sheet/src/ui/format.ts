export function fmt(n: number, dp = 0): string {
  if (!isFinite(n)) return '∞'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return Math.round(n).toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: dp })
}

export const usd = (n: number) =>
  n >= 1000 ? `$${fmt(n)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`

export const pct = (n: number, dp = 3) => `${(n * 100).toFixed(dp)}%`

export const oneIn = (p: number) => (p <= 0 ? '—' : `1 in ${fmt(1 / p)}`)

/** Market cap and volume, at a glance rather than to the dollar. */
export const big = (n: number | undefined) =>
  typeof n !== 'number' ? '—'
    : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
    : n >= 1e6 ? `$${Math.round(n / 1e6)}M`
    : `$${Math.round(n / 1e3)}k`
