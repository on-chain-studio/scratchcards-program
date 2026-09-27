import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'

const repo = resolve(__dirname, '../..')
const SHEET = resolve(__dirname, 'cards.json')
const DESIGN = resolve(__dirname, 'design.json')

/** Lets the browser write the tuned sheet back to disk, so edits outlive the tab. */
function sheetIO(): Plugin {
  return {
    name: 'sheet-io',
    configureServer(server) {
      const write = (target: string) => async (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          JSON.parse(body) // refuse to write anything that isn't valid JSON
          writeFileSync(target, body.endsWith('\n') ? body : `${body}\n`)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, path: target }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: String(e) }))
        }
      }

      server.middlewares.use('/__sheet/save', write(SHEET))
      server.middlewares.use('/__sheet/design', write(DESIGN))

      // ── analytics ─────────────────────────────────────────────────────────
      // One recorder per cluster feeds both the history file and every open tab. The child
      // holds accountSubscribe on the rollup (admin-token auth lives server-side) and prints a
      // JSON line per change; each line is timestamped into analytics-history.<cluster>.jsonl
      // and broadcast to SSE listeners. Recording runs for as long as the dev server does —
      // the graph can only show what somebody was around to record.
      type Rec = { child: ReturnType<typeof execFile>; listeners: Set<(l: string) => void>; last?: string }
      const recorders: Record<string, Rec> = {}
      const lastRecorded: Record<string, string | undefined> = {}
      const historyFile = (cluster: string) => resolve(__dirname, `analytics-history.${cluster}.jsonl`)
      const stripT = (line: string) => { try { const { t, ...rest } = JSON.parse(line); return JSON.stringify(rest) } catch { return line } }
      const recorder = (cluster: string): Rec => {
        const live = recorders[cluster]
        if (live && live.child.exitCode === null) return live
        if (lastRecorded[cluster] === undefined && existsSync(historyFile(cluster))) {
          const lines = readFileSync(historyFile(cluster), 'utf8').trim().split('\n')
          lastRecorded[cluster] = lines.length ? stripT(lines[lines.length - 1]) : undefined
        }
        const args = ['scripts/_analytics-stream.mjs', ...(cluster === 'mainnet' ? ['--mainnet'] : [])]
        const rec: Rec = { child: execFile('node', args, { cwd: repo }), listeners: new Set() }
        let buf = ''
        rec.child.stdout?.on('data', (chunk: any) => {
          buf += String(chunk)
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            // Only state lines travel: the child also prints banners (net.mjs), and a non-JSON
            // line broadcast as SSE would crash every listening tab's parser.
            let state
            try { state = JSON.parse(line) } catch { continue }
            rec.last = line
            if (line !== lastRecorded[cluster]) {
              appendFileSync(historyFile(cluster), JSON.stringify({ t: Date.now(), ...state }) + '\n')
              lastRecorded[cluster] = line
            }
            rec.listeners.forEach(l => l(line))
          }
        })
        recorders[cluster] = rec
        return rec
      }

      server.middlewares.use('/__sheet/analytics/stream', (req: any, res: any) => {
        const cluster = new URL(req.url, 'http://x').searchParams.get('cluster') === 'devnet' ? 'devnet' : 'mainnet'
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        res.flushHeaders?.()
        const rec = recorder(cluster)
        const push = (line: string) => res.write(`data: ${line}\n\n`)
        if (rec.last) push(rec.last)
        rec.listeners.add(push)
        req.on('close', () => rec.listeners.delete(push))
      })

      server.middlewares.use('/__sheet/analytics/history', (req: any, res: any) => {
        const q = new URL(req.url, 'http://x').searchParams
        const cluster = q.get('cluster') === 'devnet' ? 'devnet' : 'mainnet'
        const from = Number(q.get('from') ?? 0)
        const to = Number(q.get('to') ?? Date.now())
        recorder(cluster) // reading the graph is also the cue to start recording
        res.setHeader('content-type', 'application/json')
        try {
          const all = existsSync(historyFile(cluster))
            ? readFileSync(historyFile(cluster), 'utf8').trim().split('\n')
                .map(l => { try { return JSON.parse(l) } catch { return null } })
                .filter((r: any) => r && r.t <= to)
            : []
          // include the last row before the range as a baseline, so the client can take
          // deltas without attributing the counter's whole prior lifetime to the first bucket
          const baseline = all.filter((r: any) => r.t < from).pop()
          const rows = [...(baseline ? [baseline] : []), ...all.filter((r: any) => r.t >= from)]
          res.end(JSON.stringify(rows))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // Treasury snapshot: house ledger, basenet pools, worst collect per token — the admin
      // key stays server-side, and a short cache keeps tab re-renders from spawning runs.
      const balancesCache: Record<string, { t: number; body: string }> = {}
      server.middlewares.use('/__sheet/balances', (req: any, res: any) => {
        const q = new URL(req.url, 'http://x').searchParams
        const cluster = q.get('cluster') === 'devnet' ? 'devnet' : 'mainnet'
        res.setHeader('content-type', 'application/json')
        const hit = balancesCache[cluster]
        if (!q.get('fresh') && hit && Date.now() - hit.t < 30_000) return res.end(hit.body)
        const args = ['scripts/_balances-json.mjs', ...(cluster === 'mainnet' ? ['--mainnet'] : [])]
        execFile('node', args, { cwd: repo, timeout: 60_000 }, (err, stdout) => {
          const line = String(stdout).trim().split('\n').reverse()
            .find(l => { try { JSON.parse(l); return true } catch { return false } })
          if (!line) {
            res.statusCode = 500
            return res.end(JSON.stringify({ ok: false, error: String(err ?? 'no output') }))
          }
          balancesCache[cluster] = { t: Date.now(), body: line }
          res.end(line)
        })
      })

      // Re-pull token prices: runs scripts/fetch-prices.mjs and returns the fresh prices.json.
      /** Publishes the sheet on disk to a cluster's card shelf. Writes the live prize table. */
      server.middlewares.use('/__sheet/publish', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          let cluster = ''
          try { cluster = JSON.parse(body || '{}').cluster } catch {}
          if (cluster !== 'mainnet' && cluster !== 'devnet') {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            return res.end(JSON.stringify({ ok: false, error: 'cluster must be mainnet or devnet' }))
          }
          const args = ['scripts/setup-devnet.mjs', '--cards-only']
          if (cluster === 'mainnet') args.push('--mainnet')
          execFile('node', args, { cwd: repo, timeout: 600_000 }, (err: any, stdout: any, stderr: any) => {
            res.setHeader('content-type', 'application/json')
            if (err) {
              res.statusCode = 500
              return res.end(JSON.stringify({ ok: false, error: String(stderr || err).slice(-4000) }))
            }
            res.end(JSON.stringify({ ok: true, log: String(stdout).slice(-4000) }))
          })
        })
      })

      server.middlewares.use('/__sheet/prices', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        execFile('node', ['scripts/fetch-prices.mjs'], { cwd: repo, timeout: 120_000 }, (err, stdout, stderr) => {
          res.setHeader('content-type', 'application/json')
          if (err) {
            res.statusCode = 500
            return res.end(JSON.stringify({ ok: false, error: String(stderr || err) }))
          }
          try {
            const prices = JSON.parse(readFileSync(resolve(repo, 'scripts/prices.json'), 'utf8'))
            res.end(JSON.stringify({ ok: true, prices, log: String(stdout).slice(-2000) }))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, error: String(e) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), sheetIO()],
  resolve: {
    alias: { '@prices': resolve(repo, 'scripts/prices.json') },
  },
  server: {
    port: 5180,
    fs: { allow: [repo] },
  },
})
