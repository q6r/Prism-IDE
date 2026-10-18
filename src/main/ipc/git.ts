import { ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { localClaudeBin } from './claudeAgent'
import { sshExec } from './ssh'

const shq = (s: string): string => "'" + String(s).replace(/'/g, "'\\''") + "'"
const rjoin = (dir: string, file: string): string => dir.replace(/\/$/, '') + '/' + file

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

// Run git in `cwd` — locally, or on the remote host over SSH when a connection
// id is given (so the Source Control panel works on a VPS workspace too).
function git(cwd: string, args: string[], remoteId?: string): Promise<GitResult> {
  if (remoteId) {
    const cmd = `cd ${shq(cwd)} && GIT_TERMINAL_PROMPT=0 git ${args.map(shq).join(' ')}`
    return sshExec(remoteId, cmd).then((r) => ({ code: r.code, stdout: r.out, stderr: r.err }))
  }
  return new Promise((resolve) => {
    // GIT_TERMINAL_PROMPT=0 stops fetch/pull/push from hanging on a credential
    // prompt — they fail fast instead, and we surface the error.
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', (e) => resolve({ code: 1, stdout: '', stderr: e.message }))
  })
}

interface GitStats {
  insertions: number
  deletions: number
  binary: boolean
}

interface GitFile {
  path: string
  origPath?: string
  x: string
  y: string
  staged: boolean
  untracked: boolean
  /** HEAD → index line counts (`git diff --cached --numstat`). */
  stagedStats?: GitStats
  /** index → working tree line counts (`git diff --numstat`). */
  workingStats?: GitStats
}

/** Parses `git diff --numstat -z`; a rename record is `a\td\t\0src\0dst\0`. */
export function parseNumstat(out: string): Map<string, GitStats> {
  const stats = new Map<string, GitStats>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i])
    if (!m) continue
    let path = m[3]
    if (!path) { path = parts[i + 2] ?? ''; i += 2 }
    const binary = m[1] === '-' && m[2] === '-'
    if (path) stats.set(path, { insertions: binary ? 0 : +m[1], deletions: binary ? 0 : +m[2], binary })
  }
  return stats
}

export function parseGitStatus(out: string): { branch: string; ahead: number; behind: number; files: GitFile[] } {
  const parts = out.split('\0')
  let branch = ''
  let ahead = 0
  let behind = 0
  const files: GitFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('## ')) {
      const b = p.slice(3)
      branch = b.replace(/^(?:No commits yet on |Initial commit on )/, '').split('...')[0].split(' ')[0]
      const am = b.match(/ahead (\d+)/)
      if (am) ahead = +am[1]
      const bm = b.match(/behind (\d+)/)
      if (bm) behind = +bm[1]
      continue
    }
    const x = p[0]
    const y = p[1]
    const path = p.slice(3)
    const untracked = x === '?' && y === '?'
    const staged = !untracked && x !== ' '
    const origPath = /[RC]/.test(x + y) ? parts[++i] : undefined
    files.push({ path, ...(origPath ? { origPath } : {}), x, y, staged, untracked })
  }
  return { branch, ahead, behind, files }
}

interface StatusOptions { stats?: boolean }
async function getStatus(dir: string, remoteId?: string, options?: StatusOptions): Promise<{
  isRepo: boolean; root?: string; branch?: string; ahead?: number; behind?: number; files?: GitFile[]
}> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'], remoteId)
  if (top.code !== 0) return { isRepo: false }
  const root = top.stdout.trim()
  const st = await git(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z'], remoteId)
  if (st.code !== 0) throw new Error(st.stderr.trim() || 'Não foi possível carregar o status Git')
  const { branch, ahead, behind, files } = parseGitStatus(st.stdout)
  if (options?.stats && files.length) {
    // Per-file +/− for the changed-files rows (Traycer's diff stat overlay).
    const [cached, working] = await Promise.all([
      git(root, ['diff', '--cached', '--numstat', '-z'], remoteId),
      git(root, ['diff', '--numstat', '-z'], remoteId)
    ])
    const stagedStats = cached.code === 0 ? parseNumstat(cached.stdout) : new Map<string, GitStats>()
    const workingStats = working.code === 0 ? parseNumstat(working.stdout) : new Map<string, GitStats>()
    for (const f of files) {
      f.stagedStats = stagedStats.get(f.path)
      f.workingStats = workingStats.get(f.path)
    }
  }
  return { isRepo: true, root, branch, ahead, behind, files }
}

async function getBranches(
  root: string,
  remoteId?: string
): Promise<{
  current: string
  local: string[]
  remote: string[]
}> {
  let cur = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], remoteId)
  if (cur.code !== 0) cur = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], remoteId)
  const loc = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], remoteId)
  const rem = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], remoteId)
  const lines = (s: string): string[] =>
    s.split('\n').map((l) => l.trim()).filter(Boolean)
  return {
    current: cur.stdout.trim(),
    local: lines(loc.stdout),
    // Keep only real remote branches: drop the remote HEAD symref (short name is
    // just "origin") and "origin/HEAD" pointer entries — neither is a target.
    remote: lines(rem.stdout).filter((b) => b.includes('/') && !b.endsWith('/HEAD'))
  }
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_e, dir: string, remoteId?: string, options?: StatusOptions) => getStatus(dir, remoteId, options))

  // Status for every workspace folder, deduped by repo root (so a multi-root
  // workspace shows each distinct repository once).
  ipcMain.handle('git:statusAll', async (_e, folders: string[], remoteId?: string, options?: StatusOptions) => {
    const seen = new Set<string>()
    const out: Awaited<ReturnType<typeof getStatus>>[] = []
    for (const f of folders) {
      const s = await getStatus(f, remoteId, options)
      if (s.isRepo && s.root && !seen.has(s.root)) {
        seen.add(s.root)
        out.push(s)
      }
    }
    return out
  })

  ipcMain.handle('git:branches', (_e, root: string, remoteId?: string) =>
    getBranches(root, remoteId)
  )

  ipcMain.handle('git:checkout', async (_e, root: string, branch: string, remoteId?: string) => {
    const r = await git(root, ['checkout', branch], remoteId)
    return { code: r.code, message: (r.stdout + r.stderr).trim() }
  })

  ipcMain.handle('git:createBranch', async (_e, root: string, name: string, remoteId?: string) => {
    const r = await git(root, ['checkout', '-b', name], remoteId)
    return { code: r.code, message: (r.stdout + r.stderr).trim() }
  })

  ipcMain.handle('git:fetch', async (_e, root: string, remoteId?: string) => {
    const r = await git(root, ['fetch', '--all', '--prune'], remoteId)
    return { code: r.code, message: (r.stdout + r.stderr).trim() }
  })

  ipcMain.handle('git:pull', async (_e, root: string, remoteId?: string) => {
    const r = await git(root, ['pull', '--ff-only'], remoteId)
    return { code: r.code, message: (r.stdout + r.stderr).trim() }
  })

  ipcMain.handle('git:push', async (_e, root: string, remoteId?: string) => {
    // Push the current branch, setting upstream if it has none yet.
    let r = await git(root, ['push'], remoteId)
    if (r.code !== 0 && /has no upstream branch|set-upstream/i.test(r.stderr)) {
      const cur = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], remoteId)
      r = await git(root, ['push', '--set-upstream', 'origin', cur.stdout.trim()], remoteId)
    }
    return { code: r.code, message: (r.stdout + r.stderr).trim() }
  })
  ipcMain.handle('git:stage', (_e, root: string, file: string, remoteId?: string) =>
    git(root, ['add', '--', file], remoteId)
  )
  ipcMain.handle('git:unstage', (_e, root: string, file: string, remoteId?: string) =>
    git(root, ['reset', '-q', 'HEAD', '--', file], remoteId)
  )
  ipcMain.handle('git:stageAll', (_e, root: string, remoteId?: string) =>
    git(root, ['add', '-A'], remoteId)
  )
  ipcMain.handle('git:unstageAll', (_e, root: string, remoteId?: string) =>
    git(root, ['reset', '-q', 'HEAD', '--'], remoteId)
  )

  ipcMain.handle(
    'git:discard',
    async (_e, root: string, file: string, untracked: boolean, remoteId?: string) => {
      if (untracked) {
        // Status returns individual paths. Never treat a folder or an escaped
        // relative path as a request to discard its whole subtree.
        if (!file || /^(?:[\\/]|[A-Za-z]:)/.test(file) || /[\\/]$/.test(file) || file.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
          return { code: 1, message: 'Caminho inválido para descartar arquivo' }
        }
        if (remoteId) {
          const result = await sshExec(remoteId, `rm -f -- ${shq(rjoin(root, file))}`)
          return { code: result.code, message: (result.out + result.err).trim() }
        }
        try {
          const target = join(root, file)
          if ((await fs.lstat(target)).isDirectory()) return { code: 1, message: 'Selecione um arquivo para descartar' }
          await shell.trashItem(target)
          return { code: 0 }
        } catch (error) {
          return { code: 1, message: error instanceof Error ? error.message : 'Não foi possível mover o arquivo para a lixeira' }
        }
      }
      return git(root, ['checkout', '--', file], remoteId)
    }
  )

  ipcMain.handle('git:commit', async (_e, root: string, message: string, remoteId?: string) => {
    const r = await git(root, ['commit', '-m', message], remoteId)
    return { code: r.code, message: (r.stdout + r.stderr).trim() }
  })

  // Generate a commit message from the current diff using the local Claude CLI
  // (subscription). Uses staged changes if any, else all tracked changes.
  ipcMain.handle('git:aiCommitMessage', async (_e, root: string, remoteId?: string) => {
    let diff = (await git(root, ['diff', '--staged'], remoteId)).stdout
    if (!diff.trim()) diff = (await git(root, ['diff', 'HEAD'], remoteId)).stdout
    if (!diff.trim()) diff = (await git(root, ['diff'], remoteId)).stdout
    const untracked = (
      await git(root, ['ls-files', '--others', '--exclude-standard'], remoteId)
    ).stdout.trim()
    if (untracked) diff += `\n\n# Novos arquivos (não rastreados):\n${untracked}`
    if (!diff.trim()) return { ok: false, error: 'Sem alterações para resumir.' }

    const prompt =
      'Escreva uma mensagem de commit git concisa para este diff. Use uma linha de título ' +
      'no imperativo (máx. ~70 caracteres); adicione poucos bullet points só se a mudança ' +
      'for não-trivial. Responda APENAS com a mensagem do commit, sem aspas, sem preâmbulo, ' +
      'sem blocos de código.\n\n' +
      diff.slice(0, 12000)

    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let done = false
      const finish = (r: { ok: boolean; message?: string; error?: string }): void => {
        if (done) return
        done = true
        resolve(r)
      }
      try {
        const c = spawn(localClaudeBin(), ['-p', '--model', 'claude-haiku-4-5'], {
          cwd: root,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        })
        c.stdout?.on('data', (d: Buffer) => (out += d.toString()))
        c.stderr?.on('data', (d: Buffer) => (err += d.toString()))
        c.on('close', (code) => {
          const msg = out
            .trim()
            .replace(/^```[a-z]*\n?/i, '')
            .replace(/\n?```$/, '')
            .trim()
          if (code === 0 && msg) finish({ ok: true, message: msg })
          else finish({ ok: false, error: err.trim() || 'Falha ao gerar a mensagem.' })
        })
        c.on('error', (e) => finish({ ok: false, error: e.message }))
        setTimeout(() => {
          try {
            c.kill()
          } catch {
            /* noop */
          }
          finish({ ok: false, error: 'Tempo esgotado ao gerar a mensagem.' })
        }, 30000)
        c.stdin?.write(prompt)
        c.stdin?.end()
      } catch (e) {
        finish({ ok: false, error: (e as Error).message })
      }
    })
  })

  ipcMain.handle('git:init', (_e, dir: string, remoteId?: string) => git(dir, ['init'], remoteId))

  ipcMain.handle(
    'git:diff',
    async (_e, root: string, file: string, untracked: boolean, remoteId?: string, scope?: 'staged' | 'working', origPath?: string) => {
      const show = async (rev: string): Promise<string | null> => {
        const r = await git(root, ['show', `${rev}:${rev === 'HEAD' ? origPath ?? file : file}`], remoteId)
        return r.code === 0 ? r.stdout : null
      }
      // scope 'staged': HEAD → index. scope 'working': index → disk (HEAD when
      // the path is not in the index). No scope keeps the legacy HEAD → disk.
      if (scope === 'staged') {
        return { original: untracked ? '' : (await show('HEAD')) ?? '', modified: (await show('')) ?? '' }
      }
      let original = ''
      if (!untracked) {
        original = (scope === 'working' ? (await show('')) ?? (await show('HEAD')) : await show('HEAD')) ?? ''
      }
      let modified = ''
      if (remoteId) {
        try {
          const r = await sshExec(remoteId, `cat ${shq(rjoin(root, file))}`)
          if (r.code === 0) modified = r.out
        } catch {
          modified = ''
        }
      } else {
        try {
          modified = await fs.readFile(join(root, file), 'utf-8')
        } catch {
          modified = ''
        }
      }
      return { original, modified }
    }
  )
}
