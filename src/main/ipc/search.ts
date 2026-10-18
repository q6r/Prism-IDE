import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename } from 'path'
import { listFiles } from './fs'
import { sshExec } from './ssh'

const shq = (s: string): string => "'" + String(s).replace(/'/g, "'\\''") + "'"

// Definition-recognising patterns for `word`, language-agnostic (mirrors the
// renderer's codeNav.ts). Group 0 is the whole match; we locate the word's col.
function definitionRegex(word: string): RegExp {
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = [
    `(?:async\\s+)?function\\s*\\*?\\s*${w}\\b`,
    `(?:const|let|var)\\s+${w}\\b`,
    `class\\s+${w}\\b`,
    `(?:interface|type|enum|trait|struct)\\s+${w}\\b`,
    `def\\s+${w}\\b`,
    `func\\s+(?:\\([^)]*\\)\\s*)?${w}\\b`,
    `fn\\s+${w}\\b`,
    `${w}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\([^)]*\\)\\s*=>)`,
    `(?:public|private|protected|static|async|get|set|\\s)*${w}\\s*\\([^)]*\\)\\s*[:{]`
  ]
  return new RegExp('(?:' + parts.join('|') + ')')
}

const MAX_FILE_SIZE = 1024 * 1024 // skip files > 1MB
const MAX_RESULTS = 2000 // total matching lines
const MAX_PER_FILE = 200
const NUL = String.fromCharCode(0) // null byte → treat file as binary

interface Match {
  line: number
  col: number
  preview: string
}

// A monotonically increasing token; only the newest search is allowed to emit,
// so rapid typing instantly abandons stale work (no delay, no leftover results).
let activeToken = 0

export function registerSearchHandlers(): void {
  ipcMain.on('search:cancel', () => {
    activeToken++
  })

  ipcMain.on(
    'search:run',
    async (
      e,
      payload: {
        id: number
        root: string
        query: string
        caseSensitive: boolean
        remoteId?: string
      }
    ) => {
      const { id, root, query, caseSensitive, remoteId } = payload
      const token = ++activeToken
      const send = (channel: string, data: unknown): void => {
        if (!e.sender.isDestroyed() && token === activeToken) e.sender.send(channel, data)
      }

      if (!root || !query || query.length < 2) {
        send('search:done', { id, files: 0, matches: 0, truncated: false })
        return
      }

      // Remote workspace: grep over SSH (the files live on the server).
      if (remoteId) {
        const flags = '-rnIH' + (caseSensitive ? '' : 'i')
        const cmd =
          `grep ${flags} -F --exclude-dir=.git --exclude-dir=node_modules ` +
          `-e ${shq(query)} ${shq(root)} 2>/dev/null | head -n ${MAX_RESULTS}`
        let out = ''
        try {
          const r = await sshExec(remoteId, cmd)
          out = r.out
        } catch {
          send('search:done', { id, files: 0, matches: 0, truncated: false })
          return
        }
        if (token !== activeToken) return
        const byFile = new Map<string, Match[]>()
        let total = 0
        for (const raw of out.split(/\r?\n/)) {
          // grep -H output: path:line:content
          const m = raw.match(/^(.*?):(\d+):(.*)$/)
          if (!m) continue
          const fpath = m[1]
          const line = parseInt(m[2], 10)
          const content = m[3]
          const hay = caseSensitive ? content : content.toLowerCase()
          const col = hay.indexOf(caseSensitive ? query : query.toLowerCase()) + 1
          const arr = byFile.get(fpath) || []
          if (arr.length >= MAX_PER_FILE) continue
          arr.push({ line, col: col > 0 ? col : 1, preview: content.length > 240 ? content.slice(0, 240) : content })
          byFile.set(fpath, arr)
          total++
        }
        for (const [fpath, matches] of byFile) {
          if (token !== activeToken) return
          const rel = fpath.startsWith(root) ? fpath.slice(root.length).replace(/^\//, '') : fpath
          send('search:result', { id, path: fpath, rel, name: basename(fpath), matches })
        }
        send('search:done', { id, files: byFile.size, matches: total, truncated: total >= MAX_RESULTS })
        return
      }

      const needle = caseSensitive ? query : query.toLowerCase()
      let fileCount = 0
      let matchCount = 0
      let truncated = false

      const files = await listFiles(root)
      if (token !== activeToken) return

      for (const file of files) {
        if (token !== activeToken) return // superseded by a newer search
        if (matchCount >= MAX_RESULTS) {
          truncated = true
          break
        }

        let content: string
        try {
          const stat = await fs.stat(file.path)
          if (stat.size > MAX_FILE_SIZE) continue
          content = await fs.readFile(file.path, 'utf-8')
        } catch {
          continue
        }
        if (content.includes(NUL)) continue // binary file

        const lines = content.split(/\r?\n/)
        const matches: Match[] = []
        for (let i = 0; i < lines.length && matches.length < MAX_PER_FILE; i++) {
          const hay = caseSensitive ? lines[i] : lines[i].toLowerCase()
          const idx = hay.indexOf(needle)
          if (idx !== -1) {
            matches.push({
              line: i + 1,
              col: idx + 1,
              preview: lines[i].length > 240 ? lines[i].slice(0, 240) : lines[i]
            })
          }
        }

        if (matches.length > 0) {
          fileCount++
          matchCount += matches.length
          send('search:result', {
            id,
            path: file.path,
            rel: file.rel,
            name: basename(file.path),
            matches
          })
        }
      }

      send('search:done', { id, files: fileCount, matches: matchCount, truncated })
    }
  )

  // Cross-file "Go to Definition": find where `word` is *declared* in the
  // workspace (function/class/const/def/…). Returns ranked candidate locations.
  ipcMain.handle(
    'nav:findDef',
    async (
      _e,
      payload: { root: string; word: string; remoteId?: string; fromPath?: string }
    ): Promise<{ matches: { path: string; rel: string; name: string; line: number; col: number; preview: string }[] }> => {
      const { root, word, remoteId, fromPath } = payload
      if (!root || !word || !/^[A-Za-z_$][\w$]*$/.test(word)) return { matches: [] }
      const out: { path: string; rel: string; name: string; line: number; col: number; preview: string }[] = []

      if (remoteId) {
        const w = word.replace(/[.[\]*^$\\]/g, '\\$&')
        const ere =
          `(function|def|fn|func|class|struct|interface|type|enum|trait|const|let|var)[[:space:]]+${w}\\b` +
          `|\\b${w}[[:space:]]*[:=][[:space:]]*(function|\\()`
        const cmd =
          `grep -rnIHE --exclude-dir=.git --exclude-dir=node_modules ` +
          `-e ${shq(ere)} ${shq(root)} 2>/dev/null | head -n 40`
        try {
          const r = await sshExec(remoteId, cmd)
          for (const raw of r.out.split(/\r?\n/)) {
            const m = raw.match(/^(.*?):(\d+):(.*)$/)
            if (!m) continue
            const fpath = m[1]
            const content = m[3]
            const col = Math.max(1, content.indexOf(word) + 1)
            const rel = fpath.startsWith(root) ? fpath.slice(root.length).replace(/^\//, '') : fpath
            out.push({ path: fpath, rel, name: basename(fpath), line: parseInt(m[2], 10), col, preview: content.slice(0, 240) })
          }
        } catch {
          /* ignore */
        }
        out.sort((a, b) => (a.path === fromPath ? -1 : b.path === fromPath ? 1 : 0))
        return { matches: out.slice(0, 40) }
      }

      const re = definitionRegex(word)
      const files = await listFiles(root)
      for (const file of files) {
        if (out.length >= 40) break
        let content: string
        try {
          const stat = await fs.stat(file.path)
          if (stat.size > MAX_FILE_SIZE) continue
          content = await fs.readFile(file.path, 'utf-8')
        } catch {
          continue
        }
        if (content.includes(NUL) || !content.includes(word)) continue
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 400 || !re.test(lines[i])) continue
          const col = Math.max(1, lines[i].indexOf(word) + 1)
          out.push({
            path: file.path,
            rel: file.rel,
            name: basename(file.path),
            line: i + 1,
            col,
            preview: lines[i].slice(0, 240)
          })
          if (out.length >= 40) break
        }
      }
      // Prefer matches in the file the user came from.
      out.sort((a, b) => (a.path === fromPath ? -1 : b.path === fromPath ? 1 : 0))
      return { matches: out }
    }
  )
}
