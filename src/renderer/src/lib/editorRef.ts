import type * as monaco from 'monaco-editor'

let current: monaco.editor.IStandaloneCodeEditor | null = null

export function setEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  current = editor
}

export function getEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return current
}

export function gotoPosition(line: number, col: number): void {
  const ed = current
  if (!ed) return
  try {
    ed.revealLineInCenter(line)
    ed.setPosition({ lineNumber: line, column: col })
    ed.focus()
  } catch {
    /* editor disposed */
  }
}

export function runEditorAction(actionId: string): void {
  const ed = current
  if (!ed) return
  try {
    ed.focus()
    ed.getAction(actionId)?.run()
  } catch {
    /* editor disposed */
  }
}
