import { useEffect, useState } from 'react'

/** A coarse ticking clock for relative labels ("há 3 min", "Renova em 2h"). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
