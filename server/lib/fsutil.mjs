/**
 * Filesystem helpers shared by every harness adapter.
 *
 * Nothing in here knows about a particular harness — an adapter is free to ignore the lot
 * and read its data however it likes. See `server/harnesses/README.md` for the contract.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Read the first chunk of a file without pulling a 12MB transcript into memory. */
export async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    // Drop a trailing partial line so JSON.parse never sees half a record.
    return bytesRead === bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

/** Parse a JSONL blob, skipping the partial or malformed lines a live file always has. */
export function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* partial or malformed line — skip */
    }
  }
  return out
}

export async function listFiles(dir, filter) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => path.join(dir, e.name))
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** Does this path exist at all? Adapters use it to answer `detect()`. */
export async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** Only treat absolute paths that still resolve to directories as local workspaces. */
export async function isDirectory(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve a workspace to its repository root, collapsing linked worktrees onto their common
 * Git directory. A directory without a usable .git marker is not a local repository.
 */
export async function resolveGitProject(start) {
  if (!(await isDirectory(start))) return null

  let dir = path.resolve(start)
  while (true) {
    const marker = path.join(dir, '.git')
    const stat = await fsp.stat(marker).catch(() => null)
    if (stat?.isDirectory()) return { root: dir, worktree: '' }
    if (stat?.isFile()) {
      const text = await fsp.readFile(marker, 'utf8').catch(() => '')
      const match = /^\s*gitdir:\s*(.+?)\s*$/im.exec(text)
      if (match) {
        const gitDir = path.resolve(dir, match[1])
        const gitStat = await fsp.stat(gitDir).catch(() => null)
        if (gitStat?.isDirectory()) {
          let commonDir = gitDir
          const common = await fsp.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')
          if (common.trim()) commonDir = path.resolve(gitDir, common.trim())
          if (path.basename(commonDir) === '.git') {
            return { root: path.dirname(commonDir), worktree: path.basename(dir) }
          }
          const worktreeMatch = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitDir)
          if (worktreeMatch) return { root: worktreeMatch[1], worktree: path.basename(dir) }
          return { root: dir, worktree: '' }
        }
      }
      return null
    }

    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
