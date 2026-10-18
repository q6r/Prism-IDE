import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react'
import {
  X,
  Sparkles,
  FolderOpen,
  Command,
  ChevronRight,
  Copy,
  XCircle,
  Clock,
  Layers,
  Minus,
  Plus,
  Maximize2,
  Code2,
  Server,
  FileDiff
} from 'lucide-react'
import { useStore } from '../store'
import { defineprismTheme, monacoThemeFor } from '../lib/monaco-setup'
import { setEditor, gotoPosition } from '../lib/editorRef'
import { registerCodeNav } from '../lib/codeNav'
import { FileTypeIcon } from '../lib/fileIcon'
import { basename } from '../lib/lang'
import { Tab } from '../types'
import GitDiffView from './git/GitDiffView'

const clampZoom = (v: number): number => Math.max(0.05, Math.min(16, v))

// How long after the last keystroke auto-save writes the file.
const AUTOSAVE_DELAY = 600

// Preview/player for media files (image, svg, video, audio). Images support
// zoom: toolbar buttons, Ctrl/⌘ + scroll, and a "fit" reset.
function MediaView({ tab }: { tab: Tab }) {
  const openFileAsText = useStore((s) => s.openFileAsText)
  const isSvg = tab.name.toLowerCase().endsWith('.svg')
  const isImage = tab.mediaKind === 'image'
  const [zoom, setZoom] = useState(1)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const fitTo = (w: number, h: number): void => {
    const el = stageRef.current
    if (!el || !w || !h) return
    const z = Math.min((el.clientWidth - 40) / w, (el.clientHeight - 40) / h, 1)
    setZoom(z > 0 ? z : 1)
  }
  const fit = (): void => {
    if (nat) fitTo(nat.w, nat.h)
  }
  const onWheel = (e: ReactWheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.12 : 0.89)))
    }
  }

  return (
    <div className="media-view">
      {(isImage || isSvg) && (
        <div className="media-bar">
          <div className="zoom-ctrls">
            <button title="Diminuir" onClick={() => setZoom((z) => clampZoom(z * 0.8))}>
              <Minus size={13} />
            </button>
            <button className="zoom-pct" title="100%" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button title="Aumentar" onClick={() => setZoom((z) => clampZoom(z * 1.25))}>
              <Plus size={13} />
            </button>
            <button title="Ajustar à tela" onClick={fit}>
              <Maximize2 size={13} />
            </button>
          </div>
          {isSvg && (
            <button className="media-code-btn" onClick={() => openFileAsText(tab.path)}>
              <Code2 size={12} /> Ver código
            </button>
          )}
        </div>
      )}
      <div className={'media-stage' + (isImage ? ' zoomable' : '')} ref={stageRef} onWheel={onWheel}>
        {isImage && (
          <img
            className="media-img"
            src={tab.mediaUrl}
            alt={tab.name}
            draggable={false}
            style={nat ? { width: nat.w * zoom, height: nat.h * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined}
            onLoad={(e) => {
              const im = e.currentTarget
              setNat({ w: im.naturalWidth, h: im.naturalHeight })
              fitTo(im.naturalWidth, im.naturalHeight)
            }}
          />
        )}
        {tab.mediaKind === 'video' && (
          <video className="media-vid" src={tab.mediaUrl} controls autoPlay={false} />
        )}
        {tab.mediaKind === 'audio' && (
          <div className="media-audio">
            <FileTypeIcon name={tab.name} size={44} />
            <span className="media-audio-name">{tab.name}</span>
            <audio src={tab.mediaUrl} controls />
          </div>
        )}
      </div>
    </div>
  )
}

// Persist a tab to disk only if it's a real, unsaved text file — never a media
// (content '') or diff tab, so auto-save can't blank out a file.
function saveIfDirtyFile(path: string | null | undefined): void {
  if (!path) return
  const tab = useStore.getState().tabs.find((t) => t.path === path)
  if (tab && (!tab.kind || tab.kind === 'file') && tab.content !== tab.savedContent) {
    useStore.getState().saveTab(path)
  }
}

export default function EditorArea() {
  const tabs = useStore((s) => s.tabs)
  const activePath = useStore((s) => s.activePath)
  const folderPath = useStore((s) => s.folderPath)
  const folderName = useStore((s) => s.folderName)
  const settings = useStore((s) => s.settings)
  const setActive = useStore((s) => s.setActive)
  const requestCloseTab = useStore((s) => s.requestCloseTab)
  const updateContent = useStore((s) => s.updateContent)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  const active = tabs.find((t) => t.path === activePath)

  useEffect(() => {
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // ---- Auto-save ----
  // When on, write the active file shortly after you stop typing.
  const activeContent = active?.content
  const activeSaved = active?.savedContent
  const activeKind = active?.kind
  useEffect(() => {
    if (!settings.autoSave || !activePath) return
    if (activeKind && activeKind !== 'file') return
    if (activeContent === activeSaved) return
    const id = setTimeout(() => saveIfDirtyFile(activePath), AUTOSAVE_DELAY)
    return () => clearTimeout(id)
  }, [activePath, activeContent, activeSaved, activeKind, settings.autoSave])

  // Also flush the file you're leaving when switching tabs…
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveRef.current
    if (prev && prev !== activePath && useStore.getState().settings.autoSave) {
      saveIfDirtyFile(prev)
    }
    prevActiveRef.current = activePath
  }, [activePath])

  // …and when the whole window loses focus (alt-tab, click outside the app).
  useEffect(() => {
    const onBlur = (): void => {
      if (useStore.getState().settings.autoSave) saveIfDirtyFile(useStore.getState().activePath)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  const beforeMount: BeforeMount = (monaco) => {
    defineprismTheme(monaco)
    // Document symbols for every language → Go to Symbol (Ctrl+Shift+O),
    // outline, breadcrumbs and sticky scroll.
    registerCodeNav(monaco)
    // We're a lightweight editor, not a full project type-checker — silence the
    // sea of "errors" Monaco's TS worker reports on a file opened in isolation.
    const ts = monaco.languages.typescript
    const compiler = {
      jsx: ts.JsxEmit.React,
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs
    }
    const diagnostics = {
      noSemanticValidation: true,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true
    }
    ts.typescriptDefaults.setCompilerOptions(compiler)
    ts.typescriptDefaults.setDiagnosticsOptions(diagnostics)
    ts.javascriptDefaults.setCompilerOptions(compiler)
    ts.javascriptDefaults.setDiagnosticsOptions(diagnostics)
  }

  const onMount: OnMount = (editor, monaco) => {
    setEditor(editor)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      useStore.getState().saveActive()
    })

    // Cross-file Go to Definition (F12 / Ctrl+Click): resolve the word under the
    // cursor against the workspace and jump — opening the target file if needed.
    const goToDef = async (): Promise<void> => {
      const pos = editor.getPosition()
      const model = editor.getModel()
      if (!pos || !model) return
      const w = model.getWordAtPosition(pos)
      if (!w) return
      const st = useStore.getState()
      const root = st.folderPath
      if (!root) return
      let matches: { path: string; line: number; col: number }[] = []
      try {
        const res = await window.prism.nav.findDef({
          root,
          word: w.word,
          remoteId: st.remote?.id,
          fromPath: st.activePath ?? undefined
        })
        matches = res.matches
      } catch {
        return
      }
      if (!matches.length) {
        st.addToast('info', `Nenhuma definição encontrada para "${w.word}"`)
        return
      }
      const cur = st.activePath
      // Avoid landing on the very line the cursor is already on.
      const best =
        matches.find((m) => !(m.path === cur && m.line === pos.lineNumber)) || matches[0]
      if (best.path === cur) {
        gotoPosition(best.line, best.col)
      } else {
        await st.openFile(best.path)
        setTimeout(() => gotoPosition(best.line, best.col), 90)
      }
    }
    editor.addAction({
      id: 'prism.goToDefinition',
      label: 'Ir para a Definição',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.1,
      run: () => {
        void goToDef()
      }
    })
    editor.onMouseDown((e) => {
      if (
        (e.event.ctrlKey || e.event.metaKey) &&
        e.target.position &&
        e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT
      ) {
        editor.setPosition(e.target.position)
        void goToDef()
      }
    })
    editor.onDidChangeCursorPosition((e) => {
      useStore.getState().setCursor(e.position.lineNumber, e.position.column)
    })
    // Auto-save: also flush when the editor loses focus.
    editor.onDidBlurEditorWidget(() => {
      if (useStore.getState().settings.autoSave) saveIfDirtyFile(useStore.getState().activePath)
    })
  }

  const crumbs = (): string[] => {
    if (!active) return []
    if (folderPath && active.path.startsWith(folderPath)) {
      const rel = active.path.slice(folderPath.length).replace(/^[\\/]/, '')
      return [folderName, ...rel.split(/[\\/]/)]
    }
    return [active.name]
  }

  return (
    <div className="editor-area">
      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map((t) => {
            const dirty = t.content !== t.savedContent
            return (
              <div
                key={t.path}
                className={'tab' + (t.path === activePath ? ' active' : '')}
                onClick={() => setActive(t.path)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    requestCloseTab(t.path)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, path: t.path })
                }}
                title={t.path}
              >
                {t.kind === 'diff' ? <FileDiff size={14} /> : <FileTypeIcon name={t.name} size={14} />}
                <span className="tab-name">{t.name}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    requestCloseTab(t.path)
                  }}
                >
                  {dirty ? <span className="tab-dirty" /> : <X size={13} />}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {active && active.kind !== 'diff' && (
        <div className="breadcrumbs">
          {crumbs().map((c, i, arr) => (
            <span key={i} className="crumb">
              {i === arr.length - 1 && <FileTypeIcon name={active.name} size={13} />}
              <span className={i === arr.length - 1 ? 'crumb-file' : ''}>{c}</span>
              {i < arr.length - 1 && <ChevronRight size={12} className="crumb-sep" />}
            </span>
          ))}
        </div>
      )}

      <div className="editor-host">
        {active && active.kind === 'diff' ? (
          <GitDiffView key={active.path} tab={active} />
        ) : active && active.kind === 'media' ? (
          <MediaView tab={active} />
        ) : active ? (
          <Editor
            theme={monacoThemeFor(settings.theme)}
            path={active.path}
            language={active.language}
            value={active.content}
            beforeMount={beforeMount}
            onMount={onMount}
            onChange={(value) => updateContent(active.path, value ?? '')}
            options={{
              fontSize: settings.fontSize,
              fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
              fontLigatures: true,
              tabSize: settings.tabSize,
              wordWrap: settings.wordWrap ? 'on' : 'off',
              minimap: { enabled: true, scale: 1, renderCharacters: false },
              smoothScrolling: true,
              cursorBlinking: 'phase',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'all',
              roundedSelection: true,
              automaticLayout: true,
              fontWeight: '450',
              bracketPairColorization: { enabled: true },
              stickyScroll: { enabled: true },
              guides: { bracketPairs: 'active', indentation: true },
              scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11 }
            }}
          />
        ) : (
          <Welcome />
        )}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { requestCloseTab(menu.path); setMenu(null) }}>
            <X size={14} /> Fechar
          </button>
          <button onClick={() => { useStore.getState().closeOthers(menu.path); setMenu(null) }}>
            <XCircle size={14} /> Fechar outras
          </button>
          <button onClick={() => { useStore.getState().closeSaved(); setMenu(null) }}>
            <XCircle size={14} /> Fechar salvas
          </button>
          <button onClick={() => { useStore.getState().closeAll(); setMenu(null) }}>
            <XCircle size={14} /> Fechar todas
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(menu.path)
              useStore.getState().addToast('success', 'Caminho copiado')
              setMenu(null)
            }}
          >
            <Copy size={14} /> Copiar caminho
          </button>
        </div>
      )}
    </div>
  )
}

function Welcome() {
  const [logo, setLogo] = useState('')
  const recents = useStore((s) => s.settings.recentFolders)
  const recentWorkspaces = useStore((s) => s.settings.recentWorkspaces)
  const recentRemotes = useStore((s) => s.settings.recentRemotes)
  const openFolder = useStore((s) => s.openFolder)
  const openFolderDialog = useStore((s) => s.openFolderDialog)
  const openWorkspaceFile = useStore((s) => s.openWorkspaceFile)
  const requestReconnect = useStore((s) => s.requestReconnect)
  const toggleChat = useStore((s) => s.toggleChat)
  const wsName = (f: string): string => basename(f).replace(/\.prism-workspace$/, '')

  useEffect(() => {
    window.prism.app.logo().then(setLogo)
  }, [])

  return (
    <div className="welcome">
      {logo && <img className="welcome-logo" src={logo} alt="Prism" />}
      <h1 className="welcome-title">
        Prism <span>IDE</span>
      </h1>
      <p className="welcome-sub">Leve, bonita e com o Claude integrado.</p>

      <div className="welcome-actions">
        <button className="btn-primary" onClick={openFolderDialog}>
          <FolderOpen size={16} /> Abrir pasta
        </button>
        <button className="btn-ghost" onClick={toggleChat}>
          <Sparkles size={16} /> Conversar com o Claude
        </button>
      </div>

      {(recents.length > 0 || recentWorkspaces.length > 0 || recentRemotes.length > 0) && (
        <div className="welcome-recents">
          <div className="recents-title">
            <Clock size={12} /> Recentes
          </div>
          {recentRemotes.slice(0, 4).map((r) => (
            <button
              key={`${r.host}:${r.port}:${r.username}`}
              className="recent-item"
              onClick={() => requestReconnect(r)}
              title={`${r.username}@${r.host}:${r.port}`}
            >
              <Server size={13} />
              <span className="recent-name">{r.name}</span>
              <span className="recent-path">
                SSH · {r.username}@{r.host}
              </span>
            </button>
          ))}
          {recentWorkspaces.slice(0, 4).map((w) => (
            <button
              key={w}
              className="recent-item"
              onClick={() => openWorkspaceFile(w)}
              title={w}
            >
              <Layers size={13} />
              <span className="recent-name">{wsName(w)}</span>
              <span className="recent-path">workspace</span>
            </button>
          ))}
          {recents.slice(0, 5).map((r) => (
            <button key={r} className="recent-item" onClick={() => openFolder(r)} title={r}>
              <FolderOpen size={13} />
              <span className="recent-name">{basename(r)}</span>
              <span className="recent-path">{r}</span>
            </button>
          ))}
        </div>
      )}

      <div className="welcome-keys">
        <Key combo="Ctrl + P" label="Buscar arquivo" />
        <Key combo="Ctrl + L" label="Chat do Claude" />
        <Key combo="Ctrl + `" label="Terminal" />
        <Key combo="Ctrl + Shift + P" label="Paleta de comandos" icon />
      </div>
    </div>
  )
}

function Key({ combo, label, icon }: { combo: string; label: string; icon?: boolean }) {
  return (
    <div className="welcome-key">
      <kbd>{combo}</kbd>
      <span>
        {icon && <Command size={12} />} {label}
      </span>
    </div>
  )
}
