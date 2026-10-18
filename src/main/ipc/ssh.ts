import { ipcMain, WebContents } from 'electron'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { readFile, stat as lstat, readdir } from 'fs/promises'
import { basename as localBasename, join as localJoin } from 'path'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}
const posixJoin = (dir: string, name: string): string => dir.replace(/\/+$/, '') + '/' + name
const posixDir = (p: string): string => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
const posixBase = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
// Single-quote a path for safe use in a remote shell command.
const q = (p: string): string => "'" + p.replace(/'/g, "'\\''") + "'"

/**
 * SSH connection manager. Each connection holds an ssh2 Client plus its open
 * shell channels (remote terminals). Phase 1: connect/disconnect + status.
 * Phase 2: interactive shells piped into the terminal panel.
 */

export interface SshConnectConfig {
  name?: string
  host: string
  port?: number
  username: string
  authType: 'password' | 'key'
  password?: string
  keyPath?: string
  passphrase?: string
}

interface Conn {
  client: Client
  cfg: SshConnectConfig
  channels: Map<string, ClientChannel>
  wc: WebContents
  sftp?: Promise<SFTPWrapper>
}

const conns = new Map<string, Conn>()

export function matchesSshTarget(id: string, target: { host: string; port: number; username: string }, owner: number): boolean {
  const conn = conns.get(id)
  return !!conn && conn.wc.id === owner && conn.cfg.host.toLowerCase() === target.host.toLowerCase()
    && (conn.cfg.port || 22) === target.port && conn.cfg.username === target.username
}

/** Access the live ssh2 client for a connection (used by the remote agent). */
export function getSshClient(id: string): Client | undefined {
  return conns.get(id)?.client
}

/** Run a command on a remote connection (used by remote auth management). */
export function sshExec(id: string, cmd: string): Promise<{ code: number; out: string; err: string }> {
  return exec(id, cmd)
}

function getSftp(id: string): Promise<SFTPWrapper> {
  const c = conns.get(id)
  if (!c) return Promise.reject(new Error('Conexão SSH não encontrada.'))
  if (!c.sftp) {
    c.sftp = new Promise<SFTPWrapper>((res, rej) =>
      c.client.sftp((err, sftp) => (err ? rej(err) : res(sftp)))
    )
  }
  return c.sftp
}

function exec(id: string, cmd: string): Promise<{ code: number; out: string; err: string }> {
  const c = conns.get(id)
  if (!c) return Promise.resolve({ code: 1, out: '', err: 'sem conexão' })
  return new Promise((res) => {
    c.client.exec(cmd, (e, stream) => {
      if (e) return res({ code: 1, out: '', err: e.message })
      let out = ''
      let err = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (err += d.toString()))
      stream.on('close', (code: number) => res({ code: code ?? 0, out, err }))
    })
  })
}
let connSeq = 0
let chanSeq = 0

export function registerSshHandlers(): void {
  const send = (wc: WebContents, channel: string, data: unknown): void => {
    if (!wc.isDestroyed()) wc.send(channel, data)
  }

  ipcMain.handle('ssh:connect', async (e, cfg: SshConnectConfig) => {
    const id = `ssh${connSeq++}`
    const wc = e.sender
    const client = new Client()
    const debugLines: string[] = []

    let connectCfg: ConnectConfig
    try {
      connectCfg = {
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        keepaliveInterval: 15000,
        readyTimeout: 35000,
        // Accept any host key (ssh2 skips verification when no hostVerifier is set).
        debug: (m: string) => {
          debugLines.push(m)
          if (debugLines.length > 400) debugLines.shift()
        }
      }
      if (cfg.authType === 'key') {
        if (!cfg.keyPath) return { ok: false, error: 'Caminho da chave privada não informado.' }
        connectCfg.privateKey = await readFile(cfg.keyPath)
        if (cfg.passphrase) connectCfg.passphrase = cfg.passphrase
      } else {
        connectCfg.password = cfg.password
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    return new Promise((resolve) => {
      let settled = false
      const done = (r: { ok: boolean; id?: string; error?: string }): void => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }

      client.on('ready', () => {
        conns.set(id, { client, cfg, channels: new Map(), wc })
        send(wc, 'ssh:status', { id, status: 'connected', host: cfg.host, name: cfg.name })
        done({ ok: true, id })
      })
      client.on('error', (err) => {
        // Surface a concise handshake trace so timeouts can be diagnosed:
        // whether we got the server's SSH banner, and the last KEX step reached.
        const ident = debugLines.find((l) => /Remote ident/i.test(l))
        const lastKex = [...debugLines]
          .reverse()
          .find((l) => /handshake|kex|cipher|host key|algorithm|ident/i.test(l))
        const trace = [ident, lastKex && lastKex !== ident ? lastKex : '']
          .filter(Boolean)
          .map((l) => (l as string).replace(/^.*?:\s*/, '').trim())
          .join(' · ')
        const msg =
          err.message +
          (trace ? ` — ${trace}` : ' — sem resposta SSH do servidor (porta/firewall?)')
        if (settled) send(wc, 'ssh:status', { id, status: 'error', message: msg })
        else done({ ok: false, error: msg })
      })
      client.on('close', () => {
        const c = conns.get(id)
        c?.channels.forEach((ch) => ch.end())
        conns.delete(id)
        send(wc, 'ssh:status', { id, status: 'closed' })
      })

      try {
        client.connect(connectCfg)
      } catch (err) {
        done({ ok: false, error: (err as Error).message })
      }
    })
  })

  ipcMain.on('ssh:disconnect', (_e, id: string) => {
    const c = conns.get(id)
    c?.channels.forEach((ch) => ch.end())
    c?.client.end()
    conns.delete(id)
  })

  // Resolve the remote home directory (used as the default remote cwd).
  ipcMain.handle('ssh:home', async (_e, id: string) => {
    const c = conns.get(id)
    if (!c) return null
    return new Promise<string | null>((resolve) => {
      c.client.exec('echo "$HOME"', (err, stream) => {
        if (err) return resolve(null)
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('close', () => resolve(out.trim() || '/'))
      })
    })
  })

  // ---- Phase 2: remote terminal (interactive shell) ----
  ipcMain.handle(
    'ssh:term:create',
    (e, payload: { id: string; cols?: number; rows?: number }) => {
      const c = conns.get(payload.id)
      if (!c) return { ok: false }
      const termId = `chan${chanSeq++}`
      const wc = e.sender
      c.client.shell(
        { term: 'xterm-256color', cols: payload.cols || 80, rows: payload.rows || 24 },
        (err, stream) => {
          if (err) {
            send(wc, 'ssh:term:error', { termId, message: err.message })
            return
          }
          c.channels.set(termId, stream)
          stream.on('data', (d: Buffer) => send(wc, 'ssh:term:data', { termId, data: d.toString() }))
          stream.stderr?.on('data', (d: Buffer) =>
            send(wc, 'ssh:term:data', { termId, data: d.toString() })
          )
          stream.on('close', () => {
            c.channels.delete(termId)
            send(wc, 'ssh:term:exit', { termId })
          })
          send(wc, 'ssh:term:ready', { termId })
        }
      )
      return { ok: true, termId }
    }
  )

  ipcMain.on('ssh:term:input', (_e, payload: { id: string; termId: string; data: string }) => {
    conns.get(payload.id)?.channels.get(payload.termId)?.write(payload.data)
  })

  ipcMain.on(
    'ssh:term:resize',
    (_e, payload: { id: string; termId: string; cols: number; rows: number }) => {
      try {
        conns
          .get(payload.id)
          ?.channels.get(payload.termId)
          ?.setWindow(payload.rows, payload.cols, 0, 0)
      } catch {
        /* ignore */
      }
    }
  )

  ipcMain.on('ssh:term:kill', (_e, payload: { id: string; termId: string }) => {
    const ch = conns.get(payload.id)?.channels.get(payload.termId)
    ch?.end()
    conns.get(payload.id)?.channels.delete(payload.termId)
  })

  // ---- Phase 3: remote files over SFTP ----
  ipcMain.handle('ssh:fs:readDir', async (_e, id: string, path: string) => {
    const sftp = await getSftp(id)
    return new Promise<DirEntry[]>((res, rej) => {
      sftp.readdir(path, (err, list) => {
        if (err) return rej(err)
        const entries = list
          .filter((it) => it.filename !== '.' && it.filename !== '..')
          .map((it) => ({
            name: it.filename,
            path: posixJoin(path, it.filename),
            isDir: it.attrs.isDirectory() || it.longname.startsWith('d')
          }))
        entries.sort((a, b) =>
          a.isDir !== b.isDir
            ? a.isDir
              ? -1
              : 1
            : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        )
        res(entries)
      })
    })
  })

  ipcMain.handle('ssh:fs:readFile', async (_e, id: string, path: string) => {
    const sftp = await getSftp(id)
    return new Promise<string>((res, rej) =>
      sftp.readFile(path, (err, buf) => (err ? rej(err) : res(buf.toString('utf8'))))
    )
  })

  ipcMain.handle('ssh:fs:readFileBytes', async (_e, id: string, path: string) => {
    const sftp = await getSftp(id)
    return new Promise<string>((res, rej) =>
      sftp.readFile(path, (err, buf) => (err ? rej(err) : res(buf.toString('base64'))))
    )
  })

  ipcMain.handle('ssh:fs:writeFile', async (_e, id: string, path: string, content: string) => {
    const sftp = await getSftp(id)
    return new Promise<boolean>((res, rej) =>
      sftp.writeFile(path, content, (err) => (err ? rej(err) : res(true)))
    )
  })

  ipcMain.handle('ssh:fs:stat', async (_e, id: string, path: string) => {
    const sftp = await getSftp(id)
    return new Promise<{ exists: boolean; isDir: boolean }>((res) =>
      sftp.stat(path, (err, st) => res({ exists: !err, isDir: !!st && st.isDirectory() }))
    )
  })

  ipcMain.handle('ssh:fs:createFile', async (_e, id: string, path: string) => {
    const sftp = await getSftp(id)
    return new Promise((res, rej) =>
      sftp.writeFile(path, '', (err) =>
        err ? rej(err) : res({ name: posixBase(path), path, isDir: false })
      )
    )
  })

  ipcMain.handle('ssh:fs:createDir', async (_e, id: string, path: string) => {
    const sftp = await getSftp(id)
    return new Promise((res, rej) =>
      sftp.mkdir(path, (err) => (err ? rej(err) : res({ name: posixBase(path), path, isDir: true })))
    )
  })

  ipcMain.handle('ssh:fs:rename', async (_e, id: string, oldPath: string, newPath: string) => {
    const sftp = await getSftp(id)
    return new Promise<boolean>((res, rej) =>
      sftp.rename(oldPath, newPath, (err) => (err ? rej(err) : res(true)))
    )
  })

  ipcMain.handle('ssh:fs:delete', async (_e, id: string, path: string) => {
    const r = await exec(id, `rm -rf ${q(path)}`)
    if (r.code !== 0) throw new Error(r.err || 'Falha ao excluir')
    return true
  })

  ipcMain.handle('ssh:fs:move', async (_e, id: string, src: string, destDir: string) => {
    const dest = posixJoin(destDir, posixBase(src))
    const r = await exec(id, `mv -n ${q(src)} ${q(dest)}`)
    if (r.code !== 0) throw new Error(r.err || 'Falha ao mover')
    return dest
  })

  ipcMain.handle('ssh:fs:copy', async (_e, id: string, src: string, destDir: string) => {
    const dest = posixJoin(destDir, posixBase(src))
    const r = await exec(id, `cp -r ${q(src)} ${q(dest)}`)
    if (r.code !== 0) throw new Error(r.err || 'Falha ao copiar')
    return dest
  })

  ipcMain.handle('ssh:fs:duplicate', async (_e, id: string, src: string) => {
    const dir = posixDir(src)
    const base = posixBase(src)
    const dot = base.lastIndexOf('.')
    const name = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    const dest = posixJoin(dir, `${name} copy${ext}`)
    const r = await exec(id, `cp -r ${q(src)} ${q(dest)}`)
    if (r.code !== 0) throw new Error(r.err || 'Falha ao duplicar')
    return dest
  })

  // Upload OS files/folders dropped into the explorer to the remote (recursive).
  ipcMain.handle('ssh:fs:upload', async (_e, id: string, localPaths: string[], destDir: string) => {
    const sftp = await getSftp(id)
    const mkdir = (p: string): Promise<void> =>
      new Promise((res) => sftp.mkdir(p, () => res())) // ignore "exists"
    const putFile = (local: string, remote: string): Promise<void> =>
      new Promise((res, rej) => sftp.fastPut(local, remote, (err) => (err ? rej(err) : res())))
    const upload = async (local: string, remote: string): Promise<void> => {
      const st = await lstat(local)
      if (st.isDirectory()) {
        await mkdir(remote)
        for (const name of await readdir(local))
          await upload(localJoin(local, name), posixJoin(remote, name))
      } else {
        await putFile(local, remote)
      }
    }
    const done: string[] = []
    for (const lp of localPaths) {
      try {
        const dest = posixJoin(destDir, localBasename(lp))
        await upload(lp, dest)
        done.push(dest)
      } catch {
        /* skip files that fail */
      }
    }
    return done
  })

  // Flat file list for Quick Open (capped). Skips heavy dirs.
  ipcMain.handle('ssh:fs:listFiles', async (_e, id: string, root: string) => {
    const skip = `\\( -name node_modules -o -name .git -o -name dist -o -name .next -o -name vendor \\) -prune`
    const r = await exec(
      id,
      `find ${q(root)} ${skip} -o -type f -print 2>/dev/null | head -n 8000`
    )
    const rootClean = root.replace(/\/+$/, '')
    return r.out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => ({ path: p, rel: p.startsWith(rootClean) ? p.slice(rootClean.length + 1) : p }))
  })
}

// Exposed for the SFTP layer (Phase 3) to reuse live connections.
export function getConnection(id: string): Client | undefined {
  return conns.get(id)?.client
}
