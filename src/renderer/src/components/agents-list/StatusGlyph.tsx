import { createLucideIcon, MessageSquare, MessageSquareCheck, MessageSquareLock, MessageSquareWarning, MessageSquareX } from 'lucide-react'
import { Spinner, cn } from '../ui'
import { STATUS_TITLES, type ChatStatusKind } from './model'

/** Lucide's message-square-question-mark, assembled locally like Traycer does. */
export const MessageSquareQuestionMark = createLucideIcon('message-square-question-mark', [
  ['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z', key: '18887p' }],
  ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', key: '1u773s' }],
  ['path', { d: 'M12 17h.01', key: 'p32p05' }]
])

/**
 * The one status glyph every agent-status surface draws (StatusGlyph): the
 * braille spinner for a running turn, the notification tone icons otherwise.
 * Each state is a distinct shape, never colour alone. `label` null hides it
 * from assistive tech where the surrounding element already says the state.
 */
export function StatusGlyph({ kind, label, className }: { kind: ChatStatusKind; label?: string | null; className?: string }) {
  const name = label === undefined ? STATUS_TITLES[kind] : label
  const a11y = name === null ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name }
  if (kind === 'running') return <span {...a11y} data-status-glyph="running" className={cn('al-glyph', className)}><Spinner /></span>
  const Icon = kind === 'failure' ? MessageSquareX : kind === 'interview' ? MessageSquareQuestionMark : kind === 'approval' ? MessageSquareWarning
    : kind === 'done' ? MessageSquareCheck : kind === 'read-only' ? MessageSquareLock : MessageSquare
  return <Icon {...a11y} data-status-glyph={kind} className={cn('al-glyph-icon', `al-tone-${kind}`, className)} />
}
