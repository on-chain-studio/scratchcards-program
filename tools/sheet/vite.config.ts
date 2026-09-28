import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

const repo = resolve(__dirname, '../..')
/** The operator CLI (`cli/`, `scratch-ops`), run through cargo so it is built on first use. */
const ops = (args: string[]) => ['run', '--quiet', '--manifest-path', resolve(repo, 'cli/Cargo.toml'), '--', ...args]
const keys = process.env.KEYS_DIR ?? resolve(homedir(), 'keys')
/** casino_admin signs every admin instruction on both clusters. */
const admin = ['--keypair', resolve(keys, 'casino_admin.json')]
/** The key each cluster's house-ledger permission names: the dev key on devnet, casino_admin on mainnet. */
const reader = (cluster: string) => ['--keypair', resolve(keys, cluster === 'mainnet' ? 'casino_admin.json' : 'dev.json')]
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

      // Treasury snapshot: house ledger, basenet pools, worst collect per token — the admin
      // key stays server-side, and a short cache keeps tab re-renders from spawning runs.
      const balancesCache: Record<string, { t: number; body: string }> = {}
      server.middlewares.use('/__sheet/balances', (req: any, res: any) => {
        const q = new URL(req.url, 'http://x').searchParams
        const cluster = q.get('cluster') === 'devnet' ? 'devnet' : 'mainnet'
        res.setHeader('content-type', 'application/json')
        const hit = balancesCache[cluster]
        if (!q.get('fresh') && hit && Date.now() - hit.t < 30_000) return res.end(hit.body)
        const args = ops(['balances', ...reader(cluster), ...(cluster === 'mainnet' ? ['--mainnet'] : [])])
        execFile('cargo', args, { cwd: repo, timeout: 600_000 }, (err, stdout, stderr) => {
          const line = String(stdout).trim().split('\n').reverse()
            .find(l => { try { JSON.parse(l); return true } catch { return false } })
          if (!line) {
            res.statusCode = 500
            return res.end(JSON.stringify({ ok: false, error: String(stderr || err || 'no output').trim().slice(-2000) }))
          }
          balancesCache[cluster] = { t: Date.now(), body: line }
          res.end(line)
        })
      })

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
          const args = ops(['publish', '--cards-only', ...admin, ...(cluster === 'mainnet' ? ['--mainnet'] : [])])
          execFile('cargo', args, { cwd: repo, timeout: 600_000 }, (err: any, stdout: any, stderr: any) => {
            res.setHeader('content-type', 'application/json')
            if (err) {
              res.statusCode = 500
              return res.end(JSON.stringify({ ok: false, error: String(stderr || err).slice(-4000) }))
            }
            res.end(JSON.stringify({ ok: true, log: String(stdout).slice(-4000) }))
          })
        })
      })

      // Re-pull token prices: runs `scratch-ops fetch-prices` and returns the fresh prices.json.
      server.middlewares.use('/__sheet/prices', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        // Generous: the first run builds the CLI.
        execFile('cargo', ops(['fetch-prices']), { cwd: repo, timeout: 600_000 }, (err, stdout, stderr) => {
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
