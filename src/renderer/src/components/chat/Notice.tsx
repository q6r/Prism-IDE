import type { ReactNode } from 'react'
import { cn } from '../ui'

/** Status strip above the transcript (Traycer's banner recipe: tinted border + fill). */
export function Notice({ tone, icon, children, action }: {
  tone: 'info' | 'warning'
  icon: ReactNode
  children: ReactNode
  action?: ReactNode
}) {
  return <div className={cn('ch-notice', tone)} role="status">
    <span className="ch-notice-icon">{icon}</span>
    <span className="ch-notice-text">{children}</span>
    {action ? <span className="ch-notice-action">{action}</span> : null}
  </div>
}
