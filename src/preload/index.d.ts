import type { PrismApi } from './index'

declare global {
  interface Window {
    prism: PrismApi
  }
}

export {}
