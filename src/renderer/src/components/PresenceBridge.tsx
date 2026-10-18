import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { useStore } from '../store'
import { onMonacoReady } from '../lib/monacoReady'

/** Pushes the current editor state to the main process so extensions
 * (e.g. Discord Rich Presence) can react to it. Renders nothing. */
export default function PresenceBridge() {
  // Problem counts need Monaco, but only once the editor has loaded it.
  const [monaco, setMonaco] = useState<typeof Monaco | null>(null)
  useEffect(() => onMonacoReady(setMonaco), [])
  const folderName = useStore((s) => s.folderName)
  const folderPath = useStore((s) => s.folderPath)
  const active = useStore((s) => s.tabs.find((t) => t.path === s.activePath))
  const openPaths = useStore((s) => JSON.stringify(s.tabs.filter((t) => !t.kind || t.kind === 'file').map((t) => t.path)))
  const name = active?.name ?? null
  const path = active?.path ?? null
  const content = active?.content
  const language = active?.language ?? null
  const dirty = active ? active.content !== active.savedContent : false
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [problems, setProblems] = useState(0)
  const previous = useRef({ path, content })

  useEffect(() => {
    const edited = previous.current.path === path && previous.current.content !== content
    previous.current = { path, content }
    if (!edited || (active?.kind && active.kind !== 'file')) {
      setEditingPath(null)
      return
    }
    setEditingPath(path)
    // Saving (including auto-save) doesn't end Working while still typing.
    const timeout = setTimeout(() => setEditingPath(null), 10000)
    return () => clearTimeout(timeout)
  }, [path, content, active?.kind])

  useEffect(() => {
    if (!monaco) return
    const uris = new Set((JSON.parse(openPaths) as string[]).map((p) => monaco.Uri.parse(p).toString()))
    const update = (): void => {
      setProblems(monaco.editor.getModelMarkers({}).filter((marker) =>
        uris.has(marker.resource.toString()) &&
        (marker.severity === monaco.MarkerSeverity.Error || marker.severity === monaco.MarkerSeverity.Warning)
      ).length)
    }
    update()
    const subscription = monaco.editor.onDidChangeMarkers(update)
    return () => subscription.dispose()
  }, [monaco, openPaths])

  useEffect(() => {
    const normalizedPath = path?.replace(/\\/g, '/') ?? ''
    const root = folderPath?.replace(/\\/g, '/').replace(/\/$/, '')
    const folder = normalizedPath.split('/').slice(0, -1).pop() || null
    const relativePath = root && normalizedPath.startsWith(root + '/')
      ? normalizedPath.slice(root.length + 1)
      : name
    window.prism.ext.updateEditorState({
      file: name,
      language,
      workspace: folderName || null,
      dirty,
      folder,
      relativePath,
      working: !!path && editingPath === path,
      problems
    })
  }, [name, path, language, dirty, folderName, folderPath, editingPath, problems])

  return null
}
