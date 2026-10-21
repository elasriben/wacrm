import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guard for the gateway design: every Meta Graph URL must be derived from
// resolveGraphApiBase(). If an upstream sync introduces a new hard-coded
// graph.facebook.com call, this test fails so the call can be routed through
// the configurable base (or consciously allow-listed here).
const ALLOWED = new Set([
  'src/lib/whatsapp/graph-base.ts', // the single definition of the default
  'src/lib/whatsapp/meta-error-explain.ts', // user-facing hint text, not a request
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('Graph API call sites', () => {
  it('does not hard-code graph.facebook.com outside the allow-list', () => {
    const root = process.cwd()
    const offenders = walk(join(root, 'src'))
      .map((p) => relative(root, p).split('\\').join('/'))
      .filter((p) => !ALLOWED.has(p))
      .filter((p) => /graph\.facebook\.com/.test(readFileSync(join(root, p), 'utf8')))
    expect(offenders).toEqual([])
  })
})
