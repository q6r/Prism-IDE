import { Code2, MessageSquare, Globe } from 'lucide-react'
import { useStore } from '../../store'
import { LineTabs } from '../ui'
import '../../styles/shell.css'

export default function WorkspaceTabs() {
  const value = useStore((s) => s.workspaceView)
  return <LineTabs className="ps-shell-workspace-tabs" value={value} onChange={(next) => useStore.getState().setWorkspaceView(next)} ariaLabel="Área de trabalho" tabs={[
    { value: 'agents', label: <><MessageSquare size={14} />Conversas</> },
    { value: 'editor', label: <><Code2 size={14} />Editor</> },
    { value: 'browser', label: <><Globe size={14} />Navegador</> }
  ]} />
}
