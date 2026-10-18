import { useStore } from '../store'

/**
 * Filesystem facade that routes to the local fs or the remote SFTP layer
 * depending on whether an SSH connection is active. Components/store call this
 * instead of `window.prism.fs` so the explorer, open/save and quick-open all
 * work transparently on the remote when connected.
 */

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

const rid = (): string | null => useStore.getState().remote?.id ?? null

export const fsApi = {
  isRemote: (): boolean => rid() !== null,

  readDir: (p: string): Promise<DirEntry[]> => {
    const id = rid()
    return id ? window.prism.ssh.fs.readDir(id, p) : window.prism.fs.readDir(p)
  },
  readFile: (p: string): Promise<string> => {
    const id = rid()
    return id ? window.prism.ssh.fs.readFile(id, p) : window.prism.fs.readFile(p)
  },
  readFileBytes: (p: string): Promise<string> => {
    const id = rid()
    return id ? window.prism.ssh.fs.readFileBytes(id, p) : window.prism.fs.readFileBytes(p)
  },
  writeFile: (p: string, c: string): Promise<boolean> => {
    const id = rid()
    return id ? window.prism.ssh.fs.writeFile(id, p, c) : window.prism.fs.writeFile(p, c)
  },
  createFile: (p: string): Promise<DirEntry> => {
    const id = rid()
    return id ? window.prism.ssh.fs.createFile(id, p) : window.prism.fs.createFile(p)
  },
  createDir: (p: string): Promise<DirEntry> => {
    const id = rid()
    return id ? window.prism.ssh.fs.createDir(id, p) : window.prism.fs.createDir(p)
  },
  rename: (a: string, b: string): Promise<boolean> => {
    const id = rid()
    return id ? window.prism.ssh.fs.rename(id, a, b) : window.prism.fs.rename(a, b)
  },
  move: (src: string, destDir: string): Promise<string> => {
    const id = rid()
    return id ? window.prism.ssh.fs.move(id, src, destDir) : window.prism.fs.move(src, destDir)
  },
  copyPath: (src: string, destDir: string): Promise<string> => {
    const id = rid()
    return id ? window.prism.ssh.fs.copyPath(id, src, destDir) : window.prism.fs.copyPath(src, destDir)
  },
  duplicate: (src: string): Promise<string> => {
    const id = rid()
    return id ? window.prism.ssh.fs.duplicate(id, src) : window.prism.fs.duplicate(src)
  },
  delete: (p: string): Promise<boolean> => {
    const id = rid()
    return id ? window.prism.ssh.fs.delete(id, p) : window.prism.fs.delete(p)
  },
  listFiles: (root: string): Promise<{ path: string; rel: string }[]> => {
    const id = rid()
    return id ? window.prism.ssh.fs.listFiles(id, root) : window.prism.fs.listFiles(root)
  },
  // Import OS files/folders into a dir — local copy, or SFTP upload when remote.
  importPaths: (paths: string[], destDir: string): Promise<string[]> => {
    const id = rid()
    return id
      ? window.prism.ssh.fs.upload(id, paths, destDir)
      : window.prism.fs.importPaths(paths, destDir)
  }
}
