/**
 * Harness adapter: GitHub Copilot CLI.
 *
 * Copilot CLI keeps one directory per session under ~/.copilot/session-state. The
 * workspace YAML is the cheap metadata index; events.jsonl is bounded to the head
 * and tail so discovery never loads a complete transcript.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exists, jsonLines, listDirs, listFiles, readHead } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const SESSION_STATE = path.join(HOME, '.copilot', 'session-state')
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 96 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCK = /^inuse\.(\d+)\.lock$/

function scalar(value) {
  const text = String(value || '').trim()
  if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"') {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") return text.slice(1, -1)
  return text
}

/** Parse the small, flat subset of workspace.yaml used by the adapter. */
export function parseWorkspace(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (match) out[match[1]] = scalar(match[2])
  }
  return out
}

function cleanPrompt(value) {
  return String(value || '')
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function promptText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === 'string') return part
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return ''
}

async function readTail(file, bytes, size) {
  const fh = await fsp.open(file, 'r')
  try {
    const start = Math.max(0, size - bytes)
    const buf = Buffer.allocUnsafe(Math.min(bytes, size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text
  } finally {
    await fh.close()
  }
}

const metaCache = new Map()

async function eventMeta(entry) {
  const cached = metaCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size) return cached.meta

  let records = []
  try {
    const head = await readHead(entry.file, HEAD_BYTES)
    const tail = entry.size > HEAD_BYTES ? await readTail(entry.file, TAIL_BYTES, entry.size) : ''
    records = [...jsonLines(head), ...jsonLines(tail)]
  } catch {
    records = []
  }

  const meta = {
    firstPrompt: '',
    model: '',
    effort: '',
    startedAt: 0,
    hasError: false,
  }
  let lastError = 0
  let lastShutdown = 0

  for (const record of records) {
    const data = record?.data && typeof record.data === 'object' ? record.data : {}
    const timestamp = Date.parse(record?.timestamp || data.startTime || '')
    const at = Number.isNaN(timestamp) ? 0 : timestamp
    if (!meta.startedAt && record?.type === 'session.start') meta.startedAt = at
    if (!meta.firstPrompt && record?.type === 'user.message') {
      const prompt = cleanPrompt(promptText(data.content))
      if (prompt && !prompt.startsWith('<')) meta.firstPrompt = prompt.slice(0, 240)
    }
    if (record?.type === 'session.start') {
      meta.model = meta.model || data.selectedModel || ''
      meta.effort = meta.effort || data.reasoningEffort || ''
    }
    if (record?.type === 'session.model_change') {
      meta.model = data.newModel || meta.model
      meta.effort = data.reasoningEffort || meta.effort
    }
    if (record?.type === 'session.error') lastError = at || lastError || 1
    if (record?.type === 'session.shutdown') lastShutdown = at || lastShutdown || 1
  }
  meta.hasError = lastError > lastShutdown
  metaCache.set(entry.id, { mtime: entry.mtime, size: entry.size, meta })
  return meta
}

async function sessionEntries() {
  const out = []
  for (const dir of await listDirs(SESSION_STATE)) {
    const id = path.basename(dir)
    if (!UUID.test(id)) continue
    const workspaceFile = path.join(dir, 'workspace.yaml')
    const eventsFile = path.join(dir, 'events.jsonl')
    let workspace
    try {
      workspace = parseWorkspace(await fsp.readFile(workspaceFile, 'utf8'))
    } catch {
      continue
    }
    if (workspace.id && workspace.id !== id) continue

    let events
    try {
      const stat = await fsp.stat(eventsFile)
      events = { file: eventsFile, size: stat.size, mtime: stat.mtimeMs }
    } catch {
      events = null
    }
    out.push({ id, dir, workspace, events })
  }
  return out
}

async function activeSessions() {
  const active = new Set()
  for (const dir of await listDirs(SESSION_STATE)) {
    const id = path.basename(dir)
    if (!UUID.test(id)) continue
    for (const file of await listFiles(dir, (name) => LOCK.test(name))) {
      const match = LOCK.exec(path.basename(file))
      const pid = Number(match?.[1])
      if (!pid) continue
      try {
        process.kill(pid, 0)
        active.add(id)
      } catch {
        /* stale lock */
      }
    }
  }
  return active
}

function projectOf(workspace) {
  const cwd = typeof workspace.cwd === 'string' && path.isAbsolute(workspace.cwd) ? workspace.cwd : ''
  const gitRoot = typeof workspace.git_root === 'string' && path.isAbsolute(workspace.git_root)
    ? workspace.git_root
    : ''
  const projectPath = gitRoot || cwd
  const repository = typeof workspace.repository === 'string' ? workspace.repository : ''
  const project = path.basename(projectPath) || repository.split('/').at(-1) || projectPath || repository || 'unknown'
  return { cwd, projectPath, project }
}

async function scanThreads() {
  const [entries, active] = await Promise.all([sessionEntries(), activeSessions()])
  const now = Date.now()
  const threads = []

  for (const entry of entries) {
    const workspace = entry.workspace
    const meta = entry.events ? await eventMeta(entry.events) : {
      firstPrompt: '',
      model: '',
      effort: '',
      startedAt: 0,
      hasError: false,
    }
    const { cwd, projectPath, project } = projectOf(workspace)
    const createdAt = Date.parse(workspace.created_at || '') || meta.startedAt || 0
    const workspaceUpdatedAt = Date.parse(workspace.updated_at || '') || 0
    const updatedAt = Math.max(workspaceUpdatedAt, entry.events?.mtime || 0, createdAt)
    const title = String(workspace.name || meta.firstPrompt || 'Untitled thread').slice(0, 240)

    threads.push({
      id: `copilot-cli:${entry.id}`,
      title,
      preview: meta.firstPrompt,
      project,
      projectPath,
      worktree: '',
      cwd,
      gitBranch: workspace.branch || '',
      model: meta.model,
      effort: meta.effort,
      createdAt,
      lastActivityAt: updatedAt,
      lastFocusedAt: 0,
      running: active.has(entry.id) && now - updatedAt < ACTIVE_WINDOW_MS,
      unread: false,
      hasError: meta.hasError,
      archived: false,
      starred: false,
      routine: '',
      prState: '',
      sizeBytes: entry.events?.size || 0,
      hasTranscript: Boolean(entry.events),
      canOpen: false,
      canArchive: false,
      source: 'session-state',
      ref: { sessionId: entry.id },
    })
  }
  return threads
}

async function setArchived() {
  return { ok: false, error: 'GitHub Copilot CLI session records do not support archiving' }
}

export default {
  id: 'copilot-cli',
  name: 'GitHub Copilot CLI',
  detect: async () => {
    if (!(await exists(SESSION_STATE))) return false
    return (await listDirs(SESSION_STATE)).some((dir) => UUID.test(path.basename(dir)))
  },
  scanThreads,
  setArchived,
  paths: { SESSION_STATE },
}
