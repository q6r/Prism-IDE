import { ipcMain } from 'electron'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { existsSync } from 'fs'
import { homedir } from 'os'

/**
 * Real PTY terminals (ConPTY on Windows) via prebuilt node-pty — fully
 * interactive, so the `claude` CLI, REPLs and TUI apps work. Multiple terminals
 * are supported (for splits / multiple shells), keyed by a renderer-supplied id.
 */
interface Term {
  pty: pty.IPty
  sub: pty.IDisposable | null
}
const terms = new Map<string, Term>()
let defaultCwd = homedir()

const shellPath =
  process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'

export function registerTerminalHandlers(): void {
  ipcMain.handle('terminal:init', () => defaultCwd)

  ipcMain.handle('terminal:setCwd', (_e, dir: string) => {
    if (dir && existsSync(dir)) {
      defaultCwd = dir
      // Reflect the change in every open shell.
      for (const t of terms.values()) {
        try {
          t.pty.write(`cd "${dir}"\r`)
        } catch {
          /* shell gone */
        }
      }
    }
    return defaultCwd
  })

  ipcMain.on(
    'terminal:create',
    (e, opts: { id: string; cols?: number; rows?: number; cwd?: string }) => {
      const { id } = opts
      let t = terms.get(id)
      if (!t) {
        const p = pty.spawn(shellPath, [], {
          name: 'xterm-256color',
          cols: opts.cols || 80,
          rows: opts.rows || 24,
          cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : defaultCwd,
          env: process.env as { [key: string]: string }
        })
        t = { pty: p, sub: null }
        terms.set(id, t)
        p.onExit(() => {
          // A replacement may already own this ID when an old PTY exits.
          if (terms.get(id)?.pty !== p) return
          terms.get(id)?.sub?.dispose()
          terms.delete(id)
          if (!e.sender.isDestroyed()) e.sender.send('terminal:exit', { id })
        })
      }
      // Rebind the data handler (the panel may have remounted).
      t.sub?.dispose()
      const session = t
      t.sub = t.pty.onData((data) => {
        if (terms.get(id) !== session) return
        if (!e.sender.isDestroyed()) e.sender.send('terminal:data', { id, data })
      })
      if (opts.cols && opts.rows) {
        try {
          t.pty.resize(opts.cols, opts.rows)
        } catch {
          /* ignore */
        }
      }
    }
  )

  ipcMain.on('terminal:input', (_e, p: { id: string; data: string }) => {
    terms.get(p.id)?.pty.write(p.data)
  })

  ipcMain.on('terminal:resize', (_e, p: { id: string; cols: number; rows: number }) => {
    try {
      terms.get(p.id)?.pty.resize(p.cols, p.rows)
    } catch {
      /* ignore */
    }
  })

  ipcMain.on('terminal:kill', (_e, p: { id: string }) => {
    const t = terms.get(p.id)
    if (t) {
      // Release ownership before kill, which may emit exit synchronously.
      terms.delete(p.id)
      t.sub?.dispose()
      try {
        t.pty.kill()
      } catch {
        /* ignore */
      }
    }
  })
}
