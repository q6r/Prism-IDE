import { ipcMain, shell } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, basename, relative, dirname, sep } from 'path'
import { tmpdir } from 'os'

function uniquePath(dir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = join(dir, name)
  let i = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}${i === 1 ? ' copy' : ` copy ${i}`}${ext}`)
    i++
  }
  return candidate
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-app',
  'out',
  '.next',
  'build',
  '.cache',
  '.turbo',
  'coverage',
  '.svn',
  '.hg',
  '.idea',
  '.gradle',
  'target',
  'vendor',
  '__pycache__'
])

export async function listFiles(root: string, cap = 8000): Promise<{ path: string; rel: string }[]> {
  const result: { path: string; rel: string }[] = []
  async function walk(dir: string): Promise<void> {
    if (result.length >= cap) return
    let items: import('fs').Dirent[]
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      if (result.length >= cap) return
      if (it.isDirectory()) {
        if (IGNORED_DIRS.has(it.name)) continue
        await walk(join(dir, it.name))
      } else if (it.isFile()) {
        const full = join(dir, it.name)
        result.push({ path: full, rel: relative(root, full).replace(/\\/g, '/') })
      }
    }
  }
  await walk(root)
  return result
}

async function readDir(dir: string): Promise<DirEntry[]> {
  const items = await fs.readdir(dir, { withFileTypes: true })
  const entries: DirEntry[] = items.map((i) => ({
    name: i.name,
    path: join(dir, i.name),
    isDir: i.isDirectory()
  }))

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return entries
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:readDir', async (_e, dir: string) => readDir(dir))

  ipcMain.handle('fs:listFiles', async (_e, root: string) => listFiles(root))

  ipcMain.handle('fs:readFile', async (_e, path: string) => {
    try {
      return await fs.readFile(path, 'utf-8')
    } catch (e) {
      // A missing file (e.g. opened from a stale tree entry) shouldn't dump a
      // multi-line async stack to the log — surface a short, clear error the
      // renderer can toast.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Arquivo não encontrado: ${basename(path)}`)
      }
      throw e
    }
  })

  ipcMain.handle('fs:writeFile', async (_e, path: string, content: string) => {
    await fs.writeFile(path, content, 'utf-8')
    return true
  })

  ipcMain.handle('fs:createFile', async (_e, path: string) => {
    await fs.writeFile(path, '', { flag: 'wx' })
    return { name: basename(path), path, isDir: false }
  })

  // Read a file as base64 (for media previews: images, svg, video, audio).
  ipcMain.handle('fs:readFileBytes', async (_e, path: string) => {
    return (await fs.readFile(path)).toString('base64')
  })

  ipcMain.handle('fs:createDir', async (_e, path: string) => {
    await fs.mkdir(path, { recursive: false })
    return { name: basename(path), path, isDir: true }
  })

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
    await fs.rename(oldPath, newPath)
    return true
  })

  ipcMain.handle('fs:move', async (_e, src: string, destDir: string) => {
    if (dirname(src) === destDir) return src // already there
    if (src === destDir || destDir === src + sep || destDir.startsWith(src + sep)) {
      throw new Error('Não é possível mover um item para dentro de si mesmo.')
    }
    const dest = join(destDir, basename(src))
    if (existsSync(dest)) throw new Error('Já existe um item com esse nome no destino.')
    await fs.rename(src, dest)
    return dest
  })

  ipcMain.handle('fs:copyPath', async (_e, src: string, destDir: string) => {
    const dest = uniquePath(destDir, basename(src))
    await fs.cp(src, dest, { recursive: true })
    return dest
  })

  ipcMain.handle('fs:duplicate', async (_e, src: string) => {
    const dest = uniquePath(dirname(src), basename(src))
    await fs.cp(src, dest, { recursive: true })
    return dest
  })

  ipcMain.handle('fs:delete', async (_e, path: string) => {
    await fs.rm(path, { recursive: true, force: true })
    return true
  })

  // Recoverable delete: moves to the OS trash / Recycle Bin.
  ipcMain.handle('fs:trash', async (_e, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('Caminho inválido.')
    await shell.trashItem(path)
    return true
  })

  // Import files/folders dragged in from the OS (Windows Explorer, etc.) by
  // copying each into the target directory (recursively, with unique names).
  ipcMain.handle('fs:importPaths', async (_e, srcPaths: string[], destDir: string) => {
    const imported: string[] = []
    for (const src of srcPaths) {
      if (!src || !existsSync(src)) continue
      try {
        const dest = uniquePath(destDir, basename(src))
        await fs.cp(src, dest, { recursive: true })
        imported.push(dest)
      } catch {
        /* skip files that fail (permissions, etc.) */
      }
    }
    return imported
  })

  // Persist a data-URL image to a temp file so the agent engine (which works
  // with file paths, not inline base64) can read it.
  let tempSeq = 0
  ipcMain.handle('fs:saveTempImage', async (_e, dataUrl: string) => {
    const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl)
    if (!m) throw new Error('Formato de imagem inválido.')
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1].toLowerCase()
    const file = join(tmpdir(), `prism-img-${Date.now()}-${tempSeq++}.${ext}`)
    await fs.writeFile(file, Buffer.from(m[2], 'base64'))
    return file
  })
}
