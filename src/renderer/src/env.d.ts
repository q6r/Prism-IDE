/// <reference types="vite/client" />
import type { PrismApi } from '../../preload/index'

declare global {
  interface Window {
    prism: PrismApi
  }
}

export {}
