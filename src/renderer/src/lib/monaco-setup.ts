import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@monaco-editor/react'
import { notifyMonacoReady } from './monacoReady'

// Bundle Monaco locally (offline) instead of loading from a CDN.
;(self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

loader.config({ monaco })
notifyMonacoReady(monaco)

export const PRISM_THEME = 'prism-dark'
export const PRISM_LIGHT_THEME = 'prism-light-pink'

/** App themes whose editor uses a light base (drives [data-appearance]). */
export { LIGHT_THEMES, isLightTheme } from './appearance'

/** Map an app theme id (settings.theme) to the matching Monaco theme name. */
export function monacoThemeFor(theme: string): string {
  return theme in THEMES ? theme : PRISM_THEME
}

/** Compact palette → full Monaco theme. Token colors are bare hex; UI colors include '#'. */
interface Pal {
  base: 'vs' | 'vs-dark'
  fg: string
  bg: string
  comment: string
  keyword: string
  string: string
  number: string
  type: string
  func: string
  delimiter: string
  ln: string
  lnActive: string
  sel: string
  lineHl: string
  cursor: string
  indent: string
  indentActive: string
  widgetBg: string
  widgetBorder: string
  selHl: string
  bracketBg: string
  bracketBorder: string
  scroll: string
  scrollHover: string
}

function buildTheme(p: Pal): monaco.editor.IStandaloneThemeData {
  return {
    base: p.base,
    inherit: true,
    rules: [
      { token: '', foreground: p.fg, background: p.bg },
      { token: 'comment', foreground: p.comment, fontStyle: 'italic' },
      { token: 'keyword', foreground: p.keyword },
      { token: 'string', foreground: p.string },
      { token: 'number', foreground: p.number },
      { token: 'type', foreground: p.type },
      { token: 'function', foreground: p.func },
      { token: 'variable', foreground: p.fg },
      { token: 'delimiter', foreground: p.delimiter }
    ],
    colors: {
      'editor.background': '#' + p.bg,
      'editor.foreground': '#' + p.fg,
      'editorLineNumber.foreground': p.ln,
      'editorLineNumber.activeForeground': p.lnActive,
      'editor.selectionBackground': p.sel,
      'editor.lineHighlightBackground': p.lineHl,
      'editorCursor.foreground': p.cursor,
      'editorIndentGuide.background1': p.indent,
      'editorIndentGuide.activeBackground1': p.indentActive,
      'editorWidget.background': p.widgetBg,
      'editorWidget.border': p.widgetBorder,
      'editor.selectionHighlightBackground': p.selHl,
      'editorBracketMatch.background': p.bracketBg,
      'editorBracketMatch.border': p.bracketBorder,
      'scrollbarSlider.background': p.scroll,
      'scrollbarSlider.hoverBackground': p.scrollHover
    }
  }
}

const THEMES: Record<string, Pal> = {
  'prism-dark': {
    base: 'vs-dark', fg: 'd8dade', bg: '0c0c10',
    comment: '60636e', keyword: '9ea3e6', string: 'a3b59f', number: 'cb9a6f',
    type: '8fb0bc', func: 'b6bae8', delimiter: '878a93',
    ln: '#3a3a42', lnActive: '#8a8d96', sel: '#2a2c44', lineHl: '#14141a55', cursor: '#6f76e6',
    indent: '#1a1a20', indentActive: '#2c2c36', widgetBg: '#17171d', widgetBorder: '#232329',
    selHl: '#23253a55', bracketBg: '#6f76e625', bracketBorder: '#6f76e660',
    scroll: '#2a2a3180', scrollHover: '#34343daa'
  },
  'prism-light-pink': {
    base: 'vs', fg: '2c2530', bg: 'ffffff',
    comment: 'a094a0', keyword: 'c0467e', string: '4f8a5c', number: 'b06a3a',
    type: '3f7a92', func: 'a3477f', delimiter: '7a6f7c',
    ln: '#d6c2cd', lnActive: '#a0788c', sel: '#fad4e5', lineHl: '#fbf3f7', cursor: '#d65a8e',
    indent: '#f0e6ec', indentActive: '#e2cdd8', widgetBg: '#ffffff', widgetBorder: '#ecdde5',
    selHl: '#fbe2ee99', bracketBg: '#d65a8e25', bracketBorder: '#d65a8e60',
    scroll: '#e6cdd980', scrollHover: '#d9b6c8aa'
  },
  'prism-ocean': {
    base: 'vs-dark', fg: 'cdd9e0', bg: '0b1117',
    comment: '4f6470', keyword: '6fb7d6', string: '84b89c', number: 'd0a878',
    type: '6fc0c0', func: '8fc4d6', delimiter: '7e93a0',
    ln: '#2a3c48', lnActive: '#7a96a4', sel: '#1c3a47', lineHl: '#10202955', cursor: '#4db6c4',
    indent: '#142029', indentActive: '#22343f', widgetBg: '#121b24', widgetBorder: '#1b2a36',
    selHl: '#1c3a4799', bracketBg: '#4db6c425', bracketBorder: '#4db6c460',
    scroll: '#1c2c3880', scrollHover: '#294150aa'
  },
  'prism-nord': {
    base: 'vs-dark', fg: 'd8dee9', bg: '2a2f3a',
    comment: '616e88', keyword: '81a1c1', string: 'a3be8c', number: 'b48ead',
    type: '8fbcbb', func: '88c0d0', delimiter: '9aa4b6',
    ln: '#4c566a', lnActive: '#a9b3c6', sel: '#434c5e', lineHl: '#3b425255', cursor: '#88c0d0',
    indent: '#3b4252', indentActive: '#4c566a', widgetBg: '#353b48', widgetBorder: '#3b4252',
    selHl: '#434c5e99', bracketBg: '#88c0d025', bracketBorder: '#88c0d060',
    scroll: '#434c5e80', scrollHover: '#4c566aaa'
  },
  'prism-forest': {
    base: 'vs-dark', fg: 'cdd8d2', bg: '0d1413',
    comment: '50645c', keyword: '7fb59a', string: 'a3b58f', number: 'cba978',
    type: '6fbcae', func: '9cc4b0', delimiter: '7e938a',
    ln: '#2a3c37', lnActive: '#7a948b', sel: '#1d3a33', lineHl: '#14201d55', cursor: '#7cb89a',
    indent: '#16201e', indentActive: '#243733', widgetBg: '#16201e', widgetBorder: '#1e2c29',
    selHl: '#1d3a3399', bracketBg: '#7cb89a25', bracketBorder: '#7cb89a60',
    scroll: '#1f2e2a80', scrollHover: '#293934aa'
  },
  'prism-amethyst': {
    base: 'vs-dark', fg: 'd6d2de', bg: '0e0c13',
    comment: '5f5870', keyword: 'b18cda', string: '9db89f', number: 'cb9a6f',
    type: '8fa8d6', func: 'bba0e0', delimiter: '8a8398',
    ln: '#3a3348', lnActive: '#8d85a0', sel: '#2e2844', lineHl: '#16121d55', cursor: '#a982d6',
    indent: '#1a1626', indentActive: '#2c2640', widgetBg: '#1a1622', widgetBorder: '#26202f',
    selHl: '#2e284499', bracketBg: '#a982d625', bracketBorder: '#a982d660',
    scroll: '#2a243680', scrollHover: '#342c44aa'
  },
  'prism-sepia': {
    base: 'vs', fg: '463a2c', bg: 'faf4e8',
    comment: '9c8b6f', keyword: 'a35a2e', string: '6a7d3f', number: '99632e',
    type: '4f6a52', func: '8a5a2c', delimiter: '7a6a52',
    ln: '#c9b793', lnActive: '#8a755a', sel: '#e6d8bd', lineHl: '#efe6d3', cursor: '#b07a3c',
    indent: '#e8ddc8', indentActive: '#d8c9ad', widgetBg: '#fbf6ec', widgetBorder: '#ddd0b8',
    selHl: '#e6d8bd99', bracketBg: '#b07a3c25', bracketBorder: '#b07a3c60',
    scroll: '#d8c9ad80', scrollHover: '#c9b793aa'
  },
  'prism-daylight': {
    base: 'vs', fg: '2b2e36', bg: 'ffffff',
    comment: '969aa6', keyword: '4f57c4', string: '4f8a5c', number: 'b06a3a',
    type: '3f7a92', func: '4a55b8', delimiter: '5f6470',
    ln: '#c2c8d2', lnActive: '#6f7480', sel: '#dfe2f5', lineHl: '#f3f4f7', cursor: '#5b62d6',
    indent: '#e9ebef', indentActive: '#d6dae1', widgetBg: '#ffffff', widgetBorder: '#e0e3e8',
    selHl: '#dfe2f599', bracketBg: '#5b62d625', bracketBorder: '#5b62d660',
    scroll: '#d6dae180', scrollHover: '#c2c8d2aa'
  }
}

THEMES['prism-neutral'] = { ...THEMES['prism-dark'], fg: 'ededed', bg: '1b1b1b',
  ln: '#666666', lnActive: '#b5b5b5', sel: '#3b3450', lineHl: '#222222', cursor: '#b7a4ef',
  indent: '#2b2b2b', indentActive: '#444444', widgetBg: '#282828', widgetBorder: '#373737' }

export function defineprismTheme(m: typeof monaco): void {
  for (const [id, pal] of Object.entries(THEMES)) {
    m.editor.defineTheme(id, buildTheme(pal))
  }
}
