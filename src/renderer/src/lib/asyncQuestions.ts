import type { Question } from '../types'

/** Minimal transcript shape shared by the desktop and phone. */
export interface StructuredQuestionTurn {
  id: string
  role: 'user' | 'assistant'
  segments?: readonly { kind: string; toolId?: string; questions?: unknown }[]
}

export interface StructuredQuestionsSource {
  turnId: string
  itemId: string
  /** Stable and short enough for the host's deterministic queue item id. */
  key: string
  questions: Question[]
}

function sourceKey(turnId: string, itemId: string): string {
  let hash = 0xcbf29ce484222325n
  for (const unit of JSON.stringify([turnId, itemId])) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit.codePointAt(0)!)) * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function normalizeQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !raw.title.trim()) return []
    const labels: string[] = Array.isArray(raw.options)
      ? raw.options.filter((label: unknown): label is string => typeof label === 'string' && !!label.trim()).map((label: string) => label.trim())
      : []
    return [{ question: raw.title.trim(), header: '', multiSelect: false,
      options: [...new Set(labels)].map(label => ({ label, description: '' })) }]
  })
}

/** Native metadata only: prose lists are never treated as unanswered dialogs. */
export function latestStructuredQuestions(turns: readonly StructuredQuestionTurn[]): StructuredQuestionsSource | null {
  const turn = turns.at(-1)
  if (!turn || turn.role !== 'assistant') return null
  const segments = turn.segments || []
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]
    // A follow-up inside this turn answers all earlier asynchronous questions.
    if (segment.kind === 'user') return null
    const questions = normalizeQuestions(segment.questions)
    if (!questions.length) continue
    const itemId = segment.toolId || `segment:${index}`
    return { turnId: turn.id, itemId, key: sourceKey(turn.id, itemId), questions }
  }
  return null
}

/** This visible text is sent as the user's follow-up; no control prompt is added. */
export function buildStructuredQuestionsReply(source: StructuredQuestionsSource, answers: Record<string, string>): string | null {
  const values = source.questions.map(question => typeof answers[question.question] === 'string' ? answers[question.question].trim() : '')
  if (!values.length || values.some(value => !value)) return null
  return source.questions.map((question, index) => `${question.question}\nResposta: ${values[index]}`).join('\n\n')
}
