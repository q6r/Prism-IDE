const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { before, test } = require('node:test')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('esbuild')

let MarkdownContent
before(async () => {
  const filename = path.resolve(__dirname, '../src/renderer/src/components/chat/MarkdownContent.tsx')
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    sourcefile: filename, loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'es2022'
  })
  const dependencies = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-markdown': { __esModule: true, ...await import('react-markdown') },
    'remark-gfm': { __esModule: true, ...await import('remark-gfm') }
  }
  const module = { exports: {} }
  vm.runInThisContext(`(function(require, module, exports) {\n${code}\n})`, { filename })((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  MarkdownContent = module.exports.MarkdownContent
})

function render(text, Image) {
  return renderToStaticMarkup(React.createElement(MarkdownContent, {
    text, Image, openLink() {},
    CodeBlock: ({ code }) => React.createElement('pre', null, code)
  }))
}

test('desktop Markdown images render without a custom Image component', () => {
  const html = render('![Prévia da interface](https://example.invalid/preview.png)')
  assert.match(html, /<img[^>]+src="https:\/\/example\.invalid\/preview\.png"/)
  assert.match(html, /alt="Prévia da interface"/)
})

test('desktop Markdown keeps links, code, and text around the image', () => {
  const html = render('Antes.\n\n![Prévia](https://example.invalid/preview.png)\n\n[Arquivo](https://example.invalid/source)\n\n```ts\nconst ready = true\n```')
  assert.match(html, /Antes\./)
  assert.match(html, /<img /)
  assert.match(html, /href="https:\/\/example\.invalid\/source"/)
  assert.match(html, /<pre>const ready = true/)
})

test('mobile Markdown delegates images and local image links to its Image component', () => {
  const seen = []
  const Image = (props) => {
    seen.push(props)
    return React.createElement('img', { ...props, 'data-mobile-image': true })
  }
  render('![Prévia](sandbox:/mnt/data/preview.png)\n\n[Outra imagem](sandbox:/mnt/data/other.webp)', Image)
  assert.deepEqual(seen, [
    { src: 'sandbox:/mnt/data/preview.png', alt: 'Prévia' },
    { src: 'sandbox:/mnt/data/other.webp', alt: 'Outra imagem' }
  ])
})

test('mobile Markdown still permits supported inline image data', () => {
  const source = 'data:image/png;base64,iVBORw0KGgo='
  let seen
  render(`![Prévia](${source})`, (props) => {
    seen = props
    return React.createElement('span', null, props.alt)
  })
  assert.deepEqual(seen, { src: source, alt: 'Prévia' })
})

test('desktop and mobile Markdown retain unsafe URL filtering', () => {
  assert.doesNotMatch(render('[Link](javascript:evil.png)'), /href="javascript:/)
  const seen = []
  render('![Imagem](javascript:evil.png)', (props) => {
    seen.push(props.src)
    return React.createElement('span', null, props.alt)
  })
  assert.deepEqual(seen, [''])
})
