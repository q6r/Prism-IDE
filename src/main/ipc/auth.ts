import { ipcMain, WebContents } from 'electron'
import { spawn } from 'child_process'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { homedir } from 'os'
import type { ClientChannel } from 'ssh2'
import { sshExec, getSshClient } from './ssh'
import { localClaudeBin, findRemoteClaude, clearRemoteClaude } from './claudeAgent'

// Single-quote for a POSIX shell.
const shq = (s: string): string => "'" + String(s).replace(/'/g, "'\\''") + "'"

/**
 * Manage the Claude Code login used by the agent — locally or, when an SSH
 * connection id is passed, on the remote host. Login itself is interactive
 * (OAuth), so the renderer drives `claude auth login` through a terminal; here
 * we only expose the non-interactive `status` and `logout`.
 */

interface RunResult {
  code: number
  out: string
}

function localRun(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (code: number): void => {
      if (done) return
      done = true
      resolve({ code, out: out.trim() })
    }
    try {
      const c = spawn(localClaudeBin(), args, { shell: false })
      c.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      c.stderr?.on('data', (d: Buffer) => (out += d.toString()))
      c.on('close', (code) => finish(code ?? 0))
      c.on('error', (e) => {
        out += e.message
        finish(1)
      })
      setTimeout(() => {
        try {
          c.kill()
        } catch {
          /* noop */
        }
        finish(1)
      }, 15000)
    } catch (e) {
      out += (e as Error).message
      finish(1)
    }
  })
}

async function run(remoteId: string | undefined, args: string[]): Promise<RunResult> {
  if (remoteId) {
    // Resolve the remote claude's full path (~/.local/bin isn't on the
    // non-interactive SSH PATH), or report "not installed".
    const bin = await findRemoteClaude(remoteId)
    if (!bin) return { code: 127, out: 'claude: not found' }
    const r = await sshExec(remoteId, `${shq(bin)} ${args.join(' ')}`)
    return { code: r.code, out: (r.out + r.err).trim() }
  }
  return localRun(args)
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:status', async (_e, remoteId?: string) => {
    const r = await run(remoteId, ['auth', 'status'])
    if (remoteId && r.code === 127) return { loggedIn: false, notInstalled: true, raw: r.out }
    try {
      return JSON.parse(r.out)
    } catch {
      return { loggedIn: /logged in|authenticated/i.test(r.out), raw: r.out }
    }
  })

  ipcMain.handle('auth:logout', async (_e, remoteId?: string) => {
    const r = await run(remoteId, ['auth', 'logout'])
    return { ok: r.code === 0, out: r.out }
  })

  // ---- Interactive login (runs `claude auth login` in a PTY, streams its
  // output — the URL + "paste code" prompt — back to the login screen). ----
  let loginPty: pty.IPty | null = null
  let loginStream: ClientChannel | null = null

  const endLogin = (): void => {
    try {
      loginPty?.kill()
    } catch {
      /* noop */
    }
    try {
      loginStream?.end()
    } catch {
      /* noop */
    }
    loginPty = null
    loginStream = null
  }

  ipcMain.on(
    'auth:loginStart',
    (e, { remoteId, mode }: { remoteId?: string; mode: 'claudeai' | 'console' }) => {
      endLogin()
      const wc: WebContents = e.sender
      const send = (ch: string, d: unknown): void => {
        if (!wc.isDestroyed()) wc.send(ch, d)
      }
      const flag = mode === 'console' ? '--console' : '--claudeai'

      if (remoteId) {
        const client = getSshClient(remoteId)
        if (!client) {
          send('auth:login-data', 'Conexão SSH não encontrada.\r\n')
          send('auth:login-exit', { code: 1 })
          return
        }
        ;(async () => {
        const bin = await findRemoteClaude(remoteId)
        if (!bin) {
          send('auth:login-data', 'Claude Code não está instalado no servidor. Instale-o primeiro.\r\n')
          send('auth:login-exit', { code: 127 })
          return
        }
        client.exec(
          `${shq(bin)} auth login ${flag}`,
          { pty: { term: 'xterm-256color', cols: 100, rows: 30 } },
          (err, stream) => {
            if (err) {
              send('auth:login-data', err.message + '\r\n')
              send('auth:login-exit', { code: 1 })
              return
            }
            loginStream = stream
            stream.on('data', (d: Buffer) => send('auth:login-data', d.toString()))
            stream.stderr.on('data', (d: Buffer) => send('auth:login-data', d.toString()))
            stream.on('close', (code: number) => {
              send('auth:login-exit', { code: code ?? 0 })
              loginStream = null
            })
          }
        )
        })()
      } else {
        // Spawn the resolved claude binary directly (it may live in ~/.local/bin,
        // which isn't on the app's PATH until a restart).
        try {
          loginPty = pty.spawn(localClaudeBin(), ['auth', 'login', flag], {
            name: 'xterm-256color',
            cols: 100,
            rows: 30,
            cwd: homedir(),
            env: process.env as { [key: string]: string }
          })
          loginPty.onData((d) => send('auth:login-data', d))
          loginPty.onExit(({ exitCode }) => {
            send('auth:login-exit', { code: exitCode })
            loginPty = null
          })
        } catch (err) {
          send('auth:login-data', (err as Error).message + '\r\n')
          send('auth:login-exit', { code: 1 })
        }
      }
    }
  )

  ipcMain.on('auth:loginInput', (_e, data: string) => {
    if (loginPty) loginPty.write(data)
    else if (loginStream) loginStream.write(data)
  })

  ipcMain.on('auth:loginCancel', () => endLogin())

  // ---- Install the Claude Code CLI locally (official installer, no Node
  // needed) and stream its output to the install screen. ----
  let installPty: pty.IPty | null = null
  ipcMain.on('cli:install', (e, opts?: { remoteId?: string }) => {
    const wc: WebContents = e.sender
    const send = (ch: string, d: unknown): void => {
      if (!wc.isDestroyed()) wc.send(ch, d)
    }
    try {
      installPty?.kill()
    } catch {
      /* noop */
    }
    installPty = null

    // Remote install: run the official installer over SSH on the server.
    const remoteId = opts?.remoteId
    if (remoteId) {
      const client = getSshClient(remoteId)
      if (!client) {
        send('cli:install-data', 'Conexão SSH não encontrada (reconecte o servidor).\r\n')
        send('cli:install-exit', { code: 1 })
        return
      }
      client.exec(
        'curl -fsSL https://claude.ai/install.sh | bash 2>&1',
        { pty: { term: 'xterm-256color', cols: 100, rows: 30 } },
        (err, stream) => {
          if (err) {
            send('cli:install-data', err.message + '\r\n')
            send('cli:install-exit', { code: 1 })
            return
          }
          stream.on('data', (d: Buffer) => send('cli:install-data', d.toString()))
          stream.stderr.on('data', (d: Buffer) => send('cli:install-data', d.toString()))
          stream.on('close', (code: number) => {
            // Drop the cached "not found" so status/login re-probe immediately.
            clearRemoteClaude(remoteId)
            send('cli:install-exit', { code: code ?? 0 })
          })
        }
      )
      return
    }

    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
    const args = isWin
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']
      : ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash']
    try {
      installPty = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: homedir(),
        env: process.env as { [key: string]: string }
      })
      installPty.onData((d) => send('cli:install-data', d))
      installPty.onExit(({ exitCode }) => {
        send('cli:install-exit', { code: exitCode })
        installPty = null
      })
    } catch (err) {
      send('cli:install-data', (err as Error).message + '\r\n')
      send('cli:install-exit', { code: 1 })
    }
  })

  ipcMain.on('cli:install-cancel', () => {
    try {
      installPty?.kill()
    } catch {
      /* noop */
    }
    installPty = null
  })
}
