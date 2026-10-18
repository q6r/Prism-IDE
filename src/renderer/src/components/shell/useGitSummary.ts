import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { watchBranch } from './branchWatcher'

export default function useGitSummary() {
  const root = useStore((s) => s.folderPath)
  const remoteId = useStore((s) => s.remote?.id)
  const key = JSON.stringify([root, remoteId])
  const [summary, setSummary] = useState({ key, branch: '' })
  useEffect(() => {
    if (!root) return
    return watchBranch({
      read: async () => (await window.prism.git.branches(root, remoteId)).current,
      update: (branch) => setSummary((previous) => previous.key === key && previous.branch === branch ? previous : { key, branch }),
      isVisible: () => document.visibilityState !== 'hidden',
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      }
    })
  }, [root, remoteId])
  return summary.key === key ? summary.branch : ''
}
