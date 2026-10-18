import { WorkerPoolManager } from '@pierre/diffs/worker'
import PierreDiffWorker from '@pierre/diffs/worker/worker.js?worker'

export function createDiffWorkerPool(): WorkerPoolManager {
  return new WorkerPoolManager({
    workerFactory: () => new PierreDiffWorker({ name: 'prism-diff-highlighter' }),
    poolSize: 2,
    totalASTLRUCacheSize: 30
  }, {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    preferredHighlighter: 'shiki-js',
    useTokenTransformer: true,
    lineDiffType: 'none'
  })
}
