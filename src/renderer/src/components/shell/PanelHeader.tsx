import type { ReactNode } from 'react'
import '../../styles/shell.css'

export default function PanelHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <div className="ps-shell-panel-header"><h2>{title}</h2><div className="ps-shell-panel-actions">{children}</div></div>
}
