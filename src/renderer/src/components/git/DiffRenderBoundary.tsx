import { Component, type ReactNode } from 'react'
import { Button } from '../ui'

/** A renderer/chunk failure stays inside the diff tab instead of taking down editing. */
export default class DiffRenderBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { error: string | null }> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : 'Não foi possível carregar o visualizador de diff' }
  }
  componentDidUpdate(previous: { resetKey: unknown }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <div className="pg-error" role="alert"><span>{this.state.error}</span><Button variant="outline" size="xs" onClick={() => this.setState({ error: null })}>Tentar novamente</Button></div>
  }
}
