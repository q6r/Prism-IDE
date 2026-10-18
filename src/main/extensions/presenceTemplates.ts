import type { EditorState } from './types'

export const PRESENCE_DEFAULTS = {
  showFileName: true,
  showWorkspace: true,
  showElapsed: true,
  detailsTemplate: 'in {workspace} - {problems} {problemWord} found',
  stateTemplate: '{action} {file}',
  idleTemplate: 'Idle',
  largeImageTemplate: 'Prism IDE',
  viewingText: 'Viewing',
  workingText: 'Working'
}

// Replace known variables once. Braces in file names are plain text, and
// unknown variables remain visible so a typo can be corrected in Settings.
export function presenceText(
  key: keyof typeof PRESENCE_DEFAULTS,
  config: Record<string, unknown>,
  state: EditorState
): string | undefined {
  const showFile = config.showFileName !== false
  const showWorkspace = config.showWorkspace !== false
  const problems = Math.max(0, Math.floor(state.problems ?? 0))
  const text = (name: keyof typeof PRESENCE_DEFAULTS): string =>
    typeof config[name] === 'string' ? config[name] as string : String(PRESENCE_DEFAULTS[name])
  const values: Record<string, string> = {
    workspace: showWorkspace ? state.workspace || 'No workspace' : '',
    file: showFile ? state.file || '' : 'a file',
    folder: showFile && showWorkspace ? state.folder || '' : '',
    relativePath: showFile && showWorkspace ? state.relativePath || '' : '',
    language: state.language || '',
    action: !state.file ? 'Idle' : text(state.working ? 'workingText' : 'viewingText'),
    problems: String(problems),
    problemWord: problems === 1 ? 'problem' : 'problems',
    dirty: state.dirty ? 'Unsaved' : 'Saved'
  }
  let template = text(key)
  if (key === 'detailsTemplate' && !showWorkspace && template === PRESENCE_DEFAULTS.detailsTemplate) {
    template = '{problems} {problemWord} found'
  }
  const result = template.replace(/\{\s*(\w+)\s*\}/g, (match, name: string) => values[name] ?? match).trim()
  // Discord text fields accept 2–128 characters; blank fields are omitted.
  return result ? Array.from(result.padEnd(2)).slice(0, 128).join('') : undefined
}
