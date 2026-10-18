import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { sshExec } from './ssh'

// Record separator used to frame each remote transcript in one SSH round-trip.
const RS = '\x1e'

/**
 * Reads the local Claude Code session transcripts that the official CLI writes
 * to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. We use these to
 * power a session browser: list past conversations (title, preview, project,
 * timestamp) and reconstruct a transcript so it can be reopened and resumed
 * via the Agent SDK (`resume: <id>`).
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

export interface SessionMeta {
  id: string
  title: string
  preview: string
  cwd: string
  project: string
  mtime: number
  firstTs: number
  messageCount: number
  gitBranch?: string
  file: string
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
type Line = {
  type?: string
  aiTitle?: string
  customTitle?: string
  sessionId?: string
  message?: { role?: string; content?: string | Block[] }
  cwd?: string
  timestamp?: string
  gitBranch?: string
  isSidechain?: boolean
}

function firstText(content: string | Block[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  const t = content.find((b) => b.type === 'text' && b.text)
  return t?.text ?? ''
}

// Parse a transcript's bytes into list metadata. Shared by the local reader and
// the remote (SSH) reader so both behave identically.
function metaFromContent(
  raw: string,
  opts: { id: string; file: string; dir: string; mtimeMs: number; birthMs: number }
): SessionMeta | null {
  const { id, file, dir, mtimeMs, birthMs } = opts
  const lines = raw.split('\n')

  // Title resolution: a user-set name (`custom-title`) always wins over the
  // auto-generated `ai-title`. Both can appear multiple times as the session is
  // refined/renamed, so keep the LAST one — and prefer the entry whose sessionId
  // matches this file (the transcript can carry titles from resumed sessions).
  let customOwn = ''
  let customAny = ''
  let aiOwn = ''
  let aiAny = ''
  let preview = ''
  let cwd = ''
  let gitBranch: string | undefined
  let firstTs = 0
  let messageCount = 0

  for (const ln of lines) {
    if (!ln.trim()) continue
    let obj: Line
    try {
      obj = JSON.parse(ln)
    } catch {
      continue
    }
    if (obj.type === 'custom-title' && obj.customTitle) {
      customAny = obj.customTitle
      if (!obj.sessionId || obj.sessionId === id) customOwn = obj.customTitle
    }
    if (obj.type === 'ai-title' && obj.aiTitle) {
      aiAny = obj.aiTitle
      if (!obj.sessionId || obj.sessionId === id) aiOwn = obj.aiTitle
    }
    if ((obj.type === 'user' || obj.type === 'assistant') && !obj.isSidechain) {
      messageCount++
      if (obj.cwd && !cwd) cwd = obj.cwd
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch
      if (obj.timestamp && !firstTs) firstTs = Date.parse(obj.timestamp) || 0
      if (obj.type === 'user' && !preview) {
        const t = firstText(obj.message?.content).trim()
        // Skip command/system-ish noise for the preview.
        if (t && !t.startsWith('<')) preview = t.replace(/\s+/g, ' ').slice(0, 140)
      }
    }
  }

  if (messageCount === 0) return null

  const title = customOwn || customAny || aiOwn || aiAny
  const project = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || dir : dir
  return {
    id,
    title: title || preview.slice(0, 60) || '(sem título)',
    preview,
    cwd,
    project,
    mtime: mtimeMs,
    firstTs: firstTs || birthMs,
    messageCount,
    gitBranch,
    file
  }
}

// Local reader: stat + read the file, then parse.
async function readSessionMeta(dir: string, fileName: string): Promise<SessionMeta | null> {
  const file = join(PROJECTS_DIR, dir, fileName)
  let stat: import('fs').Stats
  try {
    stat = await fs.stat(file)
  } catch {
    return null
  }
  if (!fileName.endsWith('.jsonl') || stat.size === 0) return null
  const raw = await fs.readFile(file, 'utf8')
  const id = fileName.replace(/\.jsonl$/, '')
  return metaFromContent(raw, {
    id,
    file,
    dir,
    mtimeMs: stat.mtimeMs,
    birthMs: stat.birthtimeMs
  })
}

// Remote reader: list the newest transcripts on the server and stream them all
// in ONE SSH round-trip (find + cat, framed by a record separator).
async function listRemoteSessions(remoteId: string): Promise<SessionMeta[]> {
  const cmd =
    'DIR="$HOME/.claude/projects"; [ -d "$DIR" ] || exit 0; ' +
    "find \"$DIR\" -maxdepth 2 -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null " +
    '| sort -rn | head -300 | while IFS="$(printf \'\\t\')" read -r mt p; do ' +
    `printf '${RS}%s\\t%s\\n' "$mt" "$p"; cat "$p"; done`
  let out = ''
  try {
    const r = await sshExec(remoteId, cmd)
    out = r.out
  } catch {
    return []
  }
  const metas: SessionMeta[] = []
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue
    const nl = chunk.indexOf('\n')
    if (nl < 0) continue
    const header = chunk.slice(0, nl)
    const content = chunk.slice(nl + 1)
    const tab = header.indexOf('\t')
    const mt = header.slice(0, tab)
    const path = header.slice(tab + 1).trim()
    if (!path.endsWith('.jsonl')) continue
    const segs = path.split('/')
    const fileName = segs[segs.length - 1]
    const dir = segs[segs.length - 2] || ''
    const mtimeMs = (parseFloat(mt) || 0) * 1000
    const m = metaFromContent(content, {
      id: fileName.replace(/\.jsonl$/, ''),
      file: path,
      dir,
      mtimeMs,
      birthMs: mtimeMs
    })
    if (m) metas.push(m)
  }
  return metas
}

export interface TranscriptSegment {
  kind: 'text' | 'thinking' | 'tool'
  text?: string
  toolId?: string
  name?: string
  input?: unknown
  result?: string
  resultIsError?: boolean
}

export interface TranscriptTurn {
  id: string
  role: 'user' | 'assistant'
  text?: string
  segments?: TranscriptSegment[]
}

function blockResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((x: { type: string; text?: string }) => (x.type === 'text' ? x.text : `[${x.type}]`))
      .join('')
  }
  return JSON.stringify(content)
}

function parseTranscript(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  const toolIndex = new Map<string, TranscriptSegment>()
  let seq = 0

  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue
    let obj: Line
    try {
      obj = JSON.parse(ln)
    } catch {
      continue
    }
    if (obj.isSidechain) continue
    const content = obj.message?.content

    if (obj.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) turns.push({ id: `s${seq++}`, role: 'user', text: content })
      } else if (Array.isArray(content)) {
        // tool_result blocks attach to a previous assistant tool segment
        let userText = ''
        for (const b of content) {
          if (b.type === 'text' && b.text) userText += b.text
          else if (b.type === 'tool_result' && b.tool_use_id) {
            const seg = toolIndex.get(b.tool_use_id)
            if (seg) {
              seg.result = blockResultText(b.content)
              seg.resultIsError = !!b.is_error
            }
          }
        }
        if (userText.trim()) turns.push({ id: `s${seq++}`, role: 'user', text: userText })
      }
    } else if (obj.type === 'assistant' && Array.isArray(content)) {
      const segments: TranscriptSegment[] = []
      for (const b of content) {
        if (b.type === 'text' && b.text) segments.push({ kind: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking)
          segments.push({ kind: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use' && b.id) {
          const seg: TranscriptSegment = {
            kind: 'tool',
            toolId: b.id,
            name: b.name,
            input: b.input
          }
          toolIndex.set(b.id, seg)
          segments.push(seg)
        }
      }
      if (segments.length) turns.push({ id: `s${seq++}`, role: 'assistant', segments })
    }
  }
  return turns
}

const shq = (s: string): string => "'" + String(s).replace(/'/g, "'\\''") + "'"

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:list', async (_e, filterCwd?: string, remoteId?: string) => {
    const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

    // Remote workspace: read the *server's* Claude sessions over SSH.
    if (remoteId) {
      const metas = await listRemoteSessions(remoteId)
      const filtered = filterCwd ? metas.filter((m) => norm(m.cwd) === norm(filterCwd)) : metas
      filtered.sort((a, b) => b.mtime - a.mtime)
      return filtered
    }

    let dirs: string[]
    try {
      dirs = await fs.readdir(PROJECTS_DIR)
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    await Promise.all(
      dirs.map(async (dir) => {
        let files: string[]
        try {
          files = await fs.readdir(join(PROJECTS_DIR, dir))
        } catch {
          return
        }
        await Promise.all(
          files.map(async (f) => {
            const m = await readSessionMeta(dir, f).catch(() => null)
            if (m) metas.push(m)
          })
        )
      })
    )
    const filtered = filterCwd ? metas.filter((m) => norm(m.cwd) === norm(filterCwd)) : metas
    filtered.sort((a, b) => b.mtime - a.mtime)
    return filtered
  })

  ipcMain.handle('sessions:read', async (_e, file: string, remoteId?: string) => {
    try {
      if (remoteId) {
        const r = await sshExec(remoteId, `cat ${shq(file)}`)
        return r.code === 0 ? parseTranscript(r.out) : []
      }
      return parseTranscript(await fs.readFile(file, 'utf8'))
    } catch {
      return []
    }
  })

  ipcMain.handle('sessions:delete', async (_e, file: string, remoteId?: string) => {
    try {
      if (remoteId) {
        const r = await sshExec(remoteId, `rm -f ${shq(file)}`)
        return r.code === 0
      }
      await fs.unlink(file)
      return true
    } catch {
      return false
    }
  })
}
