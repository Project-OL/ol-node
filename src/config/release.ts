import { readFileSync } from 'fs'
import path from 'path'

/**
 * Phase 0 versioning: the commit this process runs. CI writes `dist/release.json`
 * (`{"commit": "<sha>", "builtAt": "<iso>"}`) into every artifact; local runs have none.
 * Shown by GET /health and /health/ready so every node can be compared with one curl.
 */
export type ReleaseInfo = { commit: string | null; builtAt: string | null }

function load(): ReleaseInfo {
  for (const file of [
    path.resolve(__dirname, '../release.json'), // dist/config -> dist/release.json
    path.resolve(process.cwd(), 'dist/release.json'),
  ]) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReleaseInfo>
      if (typeof j.commit === 'string' && j.commit) {
        return { commit: j.commit, builtAt: typeof j.builtAt === 'string' ? j.builtAt : null }
      }
    } catch {
      // try the next location
    }
  }
  return { commit: process.env.RELEASE_COMMIT || null, builtAt: null }
}

export const release: ReleaseInfo = load()
