// Pure AskUserQuestion draft logic (Traycer's interview-draft / use-interview-card
// rules, adapted to Prism's answers shape). No runtime imports: tests load it
// directly with node --test.
import type { Question } from '../../types'

/** An option index, or `'other'` for the free-text answer. Kept in pick order. */
export type Pick = number | 'other'
export interface Draft { picks: Pick[]; otherText: string }

export function emptyDraft(): Draft {
  return { picks: [], otherText: '' }
}

/** Multi-select toggles; single-select replaces the choice (Traycer `toggleOption`). */
export function toggleOption(draft: Draft, index: number, multi: boolean): Draft {
  if (!multi) return { ...draft, picks: [index] }
  return { ...draft, picks: draft.picks.includes(index) ? draft.picks.filter((p) => p !== index) : [...draft.picks, index] }
}

/** Selecting "Other" toggles it; on a single-select question it replaces the choice. */
export function toggleOther(draft: Draft, multi: boolean): Draft {
  const on = draft.picks.includes('other')
  if (multi) return { ...draft, picks: on ? draft.picks.filter((p) => p !== 'other') : [...draft.picks, 'other'] }
  return { ...draft, picks: on ? [] : ['other'] }
}

export function setOtherText(draft: Draft, text: string): Draft {
  return { ...draft, otherText: text }
}

/** The answer string sent for one question: picked labels in pick order, joined by `, `. */
export function answerFor(question: Question, draft: Draft | undefined): string {
  if (!draft) return ''
  if (!question.options.length) return draft.otherText.trim()
  return draft.picks
    .map((p) => p === 'other' ? draft.otherText.trim() : question.options[p]?.label ?? '')
    .filter(Boolean)
    .join(', ')
}

export function isAnswered(question: Question, draft: Draft | undefined): boolean {
  return answerFor(question, draft) !== ''
}

export function answeredCount(questions: readonly Question[], drafts: readonly (Draft | undefined)[]): number {
  return questions.filter((q, i) => isAnswered(q, drafts[i])).length
}

/** `answers` keyed by question text plus the free-text replies joined by newlines. */
export function buildSubmission(questions: readonly Question[], drafts: readonly (Draft | undefined)[]): { answers: Record<string, string>; response?: string } {
  const answers: Record<string, string> = {}
  const others: string[] = []
  questions.forEach((q, i) => {
    answers[q.question] = answerFor(q, drafts[i])
    const d = drafts[i]
    if (d && (!q.options.length || d.picks.includes('other')) && d.otherText.trim()) others.push(d.otherText.trim())
  })
  return { answers, response: others.join('\n') || undefined }
}

/** Mode line under a question with options (Traycer `interviewChoiceModeHint`). */
export function modeHint(multi: boolean, isLast: boolean): string {
  if (multi) return isLast ? 'Escolha quantas quiser e envie' : 'Escolha quantas quiser e avance'
  return isLast ? 'Escolha uma para enviar' : 'Escolha uma para continuar'
}

/** Digit shortcut target: 1..n picks an option, n+1 the "Other" row. */
export function digitTarget(key: string, optionCount: number): Pick | null {
  if (!/^[1-9]$/.test(key)) return null
  const digit = Number(key)
  if (digit <= optionCount) return digit - 1
  if (digit === optionCount + 1) return 'other'
  return null
}
