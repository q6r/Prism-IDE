import { useCallback, useState, type RefObject } from 'react'
import { ChevronDown, Copy, FileJson, FileSpreadsheet, ImageDown, Share } from 'lucide-react'
import { useStore } from '../../store'
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, Spinner, Tooltip } from '../ui'
import type { UsageSaveKind } from '../../../../shared/usage'
import { captureUsageImage, USAGE_EXPORT_REGION_SELECTOR } from './exportImage'

export type UsageExportAction = 'copy' | 'png' | 'csv' | 'json'

let logo: Promise<string | null> | null = null
const prismLogo = (): Promise<string | null> => (logo ||= window.prism.app.logo().catch(() => null))
let font: Promise<string> | null = null
const figtreeCss = (): Promise<string> => (font ||= window.prism.usage.fontCss().catch(() => ''))

/**
 * Every export of the page (Traycer's use-usage-image-export): copy or save
 * the summary as a PNG, or save the filtered turns as CSV or JSON. One export
 * runs at a time; the clipboard and the save dialog live in the main process.
 */
export function useUsageExport({ rootRef, title, subtitle, imageName, dataName, csv, json }: {
  rootRef: RefObject<HTMLElement | null>
  title: string
  subtitle: string
  imageName: string
  dataName: (extension: 'csv' | 'json') => string
  csv: () => string
  json: () => string
}) {
  const [pending, setPending] = useState<UsageExportAction | null>(null)
  const addToast = useStore((s) => s.addToast)

  const capture = useCallback(async (): Promise<Uint8Array> => {
    const region = rootRef.current?.querySelector<HTMLElement>(USAGE_EXPORT_REGION_SELECTOR)
    if (!region) throw new Error('O resumo ainda não está pronto.')
    const footer = `Gerado em ${new Date().toLocaleString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    const [mark, fontCss] = await Promise.all([prismLogo(), figtreeCss()])
    const blob = await captureUsageImage({ region, title, subtitle, footer, logo: mark, fontCss })
    return new Uint8Array(await blob.arrayBuffer())
  }, [rootRef, title, subtitle])

  const run = useCallback((action: UsageExportAction, failure: string, task: () => Promise<void>) => {
    if (pending) return
    setPending(action)
    task().catch((err) => addToast('error', `${failure}: ${err instanceof Error ? err.message : String(err)}`)).finally(() => setPending(null))
  }, [pending, addToast])

  const save = useCallback(async (kind: UsageSaveKind, fileName: string, data: Uint8Array | string, what: string) => {
    const path = await window.prism.usage.saveFile({ kind, fileName, data })
    if (path) addToast('success', `${what} salvo em ${path}`)
  }, [addToast])

  return {
    pending,
    copyImage: () => run('copy', 'Não foi possível copiar a imagem de uso', async () => {
      await window.prism.usage.copyImage(await capture())
      addToast('success', 'Imagem de uso copiada')
    }),
    saveImage: () => run('png', 'Não foi possível salvar a imagem de uso', async () => save('png', imageName, await capture(), 'Imagem')),
    saveCsv: () => run('csv', 'Não foi possível exportar o CSV', async () => save('csv', dataName('csv'), csv(), 'CSV')),
    saveJson: () => run('json', 'Não foi possível exportar o JSON', async () => save('json', dataName('json'), json(), 'JSON'))
  }
}

/** The export controls: two icon buttons for the image, one menu for the data. */
export function UsageExportActions({ ready, hasData, exporter }: { ready: boolean; hasData: boolean; exporter: ReturnType<typeof useUsageExport> }) {
  const busy = exporter.pending !== null
  const glyph = (action: UsageExportAction, Icon: typeof Copy) => exporter.pending === action ? <Spinner className="usg-btn-spinner" /> : <Icon />
  return <>
    <Tooltip label="Copiar imagem">
      <Button variant="outline" size="icon-sm" aria-label="Copiar imagem do uso" disabled={!ready || busy} onClick={exporter.copyImage}>{glyph('copy', Copy)}</Button>
    </Tooltip>
    <Tooltip label="Salvar imagem (PNG)">
      <Button variant="outline" size="icon-sm" aria-label="Salvar imagem do uso" disabled={!ready || busy} onClick={exporter.saveImage}>{glyph('png', ImageDown)}</Button>
    </Tooltip>
    <DropdownMenu label="Exportar dados" align="end" trigger={
      <Button variant="outline" size="sm" disabled={!hasData || busy}>
        {exporter.pending === 'csv' || exporter.pending === 'json' ? <Spinner className="usg-btn-spinner" /> : <Share />}Exportar<ChevronDown className="usg-btn-chevron" />
      </Button>}>
      <DropdownMenuLabel>Exportar turnos filtrados</DropdownMenuLabel>
      <DropdownMenuItem onSelect={exporter.saveCsv}><FileSpreadsheet />Planilha (CSV)</DropdownMenuItem>
      <DropdownMenuItem onSelect={exporter.saveJson}><FileJson />Dados (JSON)</DropdownMenuItem>
    </DropdownMenu>
  </>
}
