import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Short name shown in the fallback, e.g. "o chat", "o terminal". */
  label?: string
}
interface State {
  error: Error | null
}

/** "em" + article contracts in Portuguese: "o navegador" → "no navegador". */
const where = (label?: string): string => {
  if (!label) return 'nesta parte'
  const m = /^(os|as|o|a)\s+(.*)$/i.exec(label)
  return m ? `${{ o: 'no', a: 'na', os: 'nos', as: 'nas' }[m[1].toLowerCase() as 'o']} ${m[2]}` : `em ${label}`
}

/**
 * Isolates a panel: if one subtree throws during render, only that panel shows a
 * recoverable fallback instead of white-screening the whole app.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[prism] panel error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel-error">
          <p>Algo quebrou {where(this.props.label)}.</p>
          <button className="btn-ghost sm" onClick={() => this.setState({ error: null })}>
            <RotateCcw size={13} /> Recarregar
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
