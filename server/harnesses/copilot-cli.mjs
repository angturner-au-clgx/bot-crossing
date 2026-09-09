/**
 * Harness adapter: GitHub Copilot CLI.
 *
 * Copilot CLI keeps one directory per session under ~/.copilot/session-state. The
 * workspace YAML is the cheap metadata index; events.jsonl is bounded to the head
 * and tail so discovery never loads a complete transcript. ACP is not used here:
 * an ACP connection owns the stdio of the Copilot process it launches and cannot
 * observe an arbitrary existing session.
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
const WAITING_EVENTS = new Set([
  'permission.requested',
  'input.requested',
  'input.requested_for_user',
  'prompt.requested',
  'user.input.requested',
])
const WAITING_COMPLETION_EVENTS = new Set([
  'input.completed',
  'input.responded',
  'prompt.completed',
  'user.input.completed',
])
const ACTIVE_EVENTS = new Set([
  'assistant.message',
  'assistant.turn_start',
  'tool.execution_start',
  'tool.execution_complete',
  'external_tool.requested',
  'external_tool.completed',
])

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

function eventTime(record) {
  const value = record?.timestamp ?? record?.data?.startTime
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(String(value || ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

function eventKey(record) {
  if (record?.id) return `id:${record.id}`
  const data = record?.data && typeof record.data === 'object' ? record.data : {}
  return [
    record?.type || '',
    record?.timestamp || '',
    data.requestId || '',
    data.toolCallId || '',
    data.turnId || '',
  ].join('\u0000')
}

function mergeRecords(head, tail) {
  const seen = new Set()
  return [...head, ...tail].filter((record) => {
    const key = eventKey(record)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function requestKey(record) {
  const data = record?.data && typeof record.data === 'object' ? record.data : {}
  return data.requestId || data.toolCallId || record?.type
}

/**
 * Reduce known Copilot JSONL lifecycle events to the normalized state used by the scanner.
 * Unknown event types are deliberately ignored rather than treated as prompts or failures.
 */
export function deriveEventState(records) {
  const meta = {
    firstPrompt: '',
    model: '',
    effort: '',
    startedAt: 0,
    lastEventAt: 0,
    lifecycle: 'unknown',
    waiting: false,
    hasError: false,
  }
  const pendingRequests = new Set()
  let lastErrorAt = 0
  let lastTerminalAt = 0

  for (const record of records) {
    const data = record?.data && typeof record.data === 'object' ? record.data : {}
    const at = eventTime(record)
    if (at > meta.lastEventAt) meta.lastEventAt = at
    if (!meta.startedAt && record?.type === 'session.start') meta.startedAt = at
    if (!meta.firstPrompt && record?.type === 'user.message') {
      const prompt = cleanPrompt(promptText(data.content))
      if (prompt && !prompt.startsWith('<')) meta.firstPrompt = prompt.slice(0, 240)
    }
    if (record?.type === 'session.start') {
      meta.model = meta.model || data.selectedModel || ''
      meta.effort = meta.effort || data.reasoningEffort || ''
      meta.lifecycle = 'idle'
      meta.hasError = false
      pendingRequests.clear()
    } else if (record?.type === 'session.resume') {
      meta.model = data.selectedModel || meta.model
      meta.effort = data.reasoningEffort || meta.effort
      meta.lifecycle = 'idle'
      meta.hasError = false
      pendingRequests.clear()
    } else if (record?.type === 'session.model_change') {
      meta.model = data.newModel || meta.model
      meta.effort = data.reasoningEffort || meta.effort
    } else if (record?.type === 'user.message') {
      meta.lifecycle = 'active'
      meta.hasError = false
      pendingRequests.clear()
    } else if (ACTIVE_EVENTS.has(record?.type)) {
      meta.lifecycle = 'active'
      meta.hasError = false
    } else if (record?.type === 'assistant.turn_end') {
      meta.lifecycle = 'idle'
      pendingRequests.clear()
    } else if (WAITING_EVENTS.has(record?.type)) {
      pendingRequests.add(requestKey(record))
      meta.lifecycle = 'waiting'
    } else if (record?.type === 'permission.completed' || WAITING_COMPLETION_EVENTS.has(record?.type)) {
      pendingRequests.delete(requestKey(record))
      meta.lifecycle = pendingRequests.size ? 'waiting' : 'active'
    } else if (record?.type === 'session.task_complete' || record?.type === 'session.shutdown' || record?.type === 'abort') {
      pendingRequests.clear()
      meta.lifecycle = 'idle'
    } else if (record?.type === 'session.error') {
      pendingRequests.clear()
      meta.lifecycle = 'idle'
      meta.hasError = true
      lastErrorAt = at || lastErrorAt || 1
    }
    if (record?.type === 'session.shutdown' || record?.type === 'session.task_complete') {
      lastTerminalAt = at || lastTerminalAt || 1
    }
  }

  meta.waiting = pendingRequests.size > 0 || meta.lifecycle === 'waiting'
  if (lastTerminalAt >= lastErrorAt) meta.hasError = false
  return meta
}

async function eventMeta(entry) {
  const cached = metaCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size) return cached.meta

  let records = []
  try {
    const head = await readHead(entry.file, HEAD_BYTES)
    const tail = entry.size > HEAD_BYTES ? await readTail(entry.file, TAIL_BYTES, entry.size) : ''
    records = mergeRecords(jsonLines(head), jsonLines(tail))
  } catch {
    records = []
  }

  const meta = deriveEventState(records)
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
    const meta = entry.events ? await eventMeta(entry.events) : deriveEventState([])
    const { cwd, projectPath, project } = projectOf(workspace)
    const createdAt = Date.parse(workspace.created_at || '') || meta.startedAt || 0
    const workspaceUpdatedAt = Date.parse(workspace.updated_at || '') || 0
    const updatedAt = Math.max(workspaceUpdatedAt, meta.lastEventAt, createdAt)
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
      running: active.has(entry.id) &&
        meta.lifecycle === 'active' &&
        !meta.waiting &&
        !meta.hasError &&
        now - meta.lastEventAt < ACTIVE_WINDOW_MS,
      unread: meta.waiting,
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
