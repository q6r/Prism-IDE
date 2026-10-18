import type { HostClient } from '../client'
import type { FsEntry } from '../generated/FsEntry'
import type { FsListedFile } from '../generated/FsListedFile'
import { LONG_CALL_MS, baseName, readWithFallback } from './call'
import { fromBase64, toBase64, type HostTransfer } from './transfer'

/** `window.prism.fs` (local paths; SSH workspaces use `ssh.fs`). */
export interface FsApi {
  readDir(p: string): Promise<FsEntry[]>
  listFiles(root: string): Promise<FsListedFile[]>
  readFile(p: string): Promise<string>
  readFileBytes(p: string): Promise<string>
  writeFile(p: string, c: string): Promise<boolean>
  createFile(p: string): Promise<FsEntry>
  createDir(p: string): Promise<FsEntry>
  rename(a: string, b: string): Promise<boolean>
  move(src: string, destDir: string): Promise<string>
  copyPath(src: string, destDir: string): Promise<string>
  duplicate(src: string): Promise<string>
  delete(p: string): Promise<boolean>
  trash(p: string): Promise<boolean>
  importPaths(paths: string[], destDir: string): Promise<string[]>
  saveTempImage(dataUrl: string): Promise<string>
}

/** The user's own disk, where dragged-in files come from (desktop shell). */
export interface LocalFiles {
  /** `follow` resolves links (the dragged item itself); inside folders links are skipped. */
  kind(path: string, follow: boolean): Promise<'file' | 'dir' | null>
  list(dir: string): Promise<string[]>
}

/**
 * Text bigger than this is written over `/files` instead of JSON: even fully
 * escaped (6 bytes a character) it stays under the socket's 16 MB message
 * limit, past which the host drops the connection.
 */
export const WRITE_OVER_HTTP_CHARS = 2 * 1024 * 1024

/** The Explorer order the IPC side always had: folders first, then by name. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export function createHostFs(deps: { client: HostClient; transfer: HostTransfer; local?: LocalFiles; ipc: FsApi }): FsApi {
  const { client, transfer, local, ipc } = deps
  const call = <T>(verb: string, params: unknown, timeoutMs?: number): Promise<T> => client.call<T>(`fs.${verb}`, params, timeoutMs)

  /** Copies a local file or folder to `dest` on the host. */
  const importOne = async (src: string, dest: string, kind: 'file' | 'dir'): Promise<void> => {
    if (kind === 'file') {
      if (transfer.uploadLocal) await transfer.uploadLocal({ path: dest }, src)
      return
    }
    await call('createDir', { path: dest })
    for (const name of await local!.list(src)) {
      const child = `${src}${src.endsWith('/') || src.endsWith('\\') ? '' : '/'}${name}`
      const childKind = await local!.kind(child, false)
      if (!childKind) continue
      await importOne(child, await call<string>('uniquePath', { dir: dest, name }), childKind)
    }
  }

  return {
    readDir: (p) => readWithFallback(async () => sortEntries(await call<FsEntry[]>('readDir', { path: p })), () => ipc.readDir(p)),
    listFiles: (root) => readWithFallback(() => call<FsListedFile[]>('listFiles', { path: root }, LONG_CALL_MS), () => ipc.listFiles(root)),
    readFile: (p) => readWithFallback(() => call<string>('readFile', { path: p }, LONG_CALL_MS), () => ipc.readFile(p)),
    readFileBytes: (p) => readWithFallback(async () => toBase64(await transfer.download(p)), () => ipc.readFileBytes(p)),
    writeFile: async (p, c) => {
      if (c.length > WRITE_OVER_HTTP_CHARS) {
        await transfer.upload({ path: p }, new TextEncoder().encode(c))
        return true
      }
      return call<boolean>('writeFile', { path: p, content: c }, LONG_CALL_MS)
    },
    createFile: (p) => call<FsEntry>('createFile', { path: p }),
    createDir: (p) => call<FsEntry>('createDir', { path: p }),
    rename: (a, b) => call<boolean>('rename', { from: a, to: b }),
    move: (src, destDir) => call<string>('move', { src, destDir }, LONG_CALL_MS),
    copyPath: (src, destDir) => call<string>('copyPath', { src, destDir }, LONG_CALL_MS),
    duplicate: (src) => call<string>('duplicate', { path: src }, LONG_CALL_MS),
    delete: (p) => call<boolean>('delete', { path: p }, LONG_CALL_MS),
    trash: (p) => call<boolean>('trash', { path: p }, LONG_CALL_MS),
    // Files dragged in from the OS: the shell reads them and uploads them
    // through `/files`. Items that fail are skipped, as before.
    importPaths: async (paths, destDir) => {
      if (!local || !transfer.uploadLocal) return ipc.importPaths(paths, destDir)
      const imported: string[] = []
      for (const src of paths) {
        try {
          const kind = src ? await local.kind(src, true) : null
          if (!kind) continue
          const dest = await call<string>('uniquePath', { dir: destDir, name: baseName(src) })
          await importOne(src, dest, kind)
          imported.push(dest)
        } catch { /* skip what fails (permissions, etc.) */ }
      }
      return imported
    },
    saveTempImage: async (dataUrl) => {
      const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl)
      if (!m) throw new Error('Formato de imagem inválido.')
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1].toLowerCase()
      return transfer.upload({ temp: ext }, fromBase64(m[2]))
    }
  }
}
