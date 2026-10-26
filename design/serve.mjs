/**
 * Throwaway preview server: static files for `design/`, plus the one route the
 * browser requests outside `fetch` — the asset endpoint the gallery's <img> tags
 * point at. Run with: node design/serve.mjs [port]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = Number(process.argv[2] ?? 39177)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** Stand-in pictures for the six stubbed history entries. */
const ASSETS = {
  p1: 'design/comp.png',
  p2: 'design/shots/result-dark.png',
  p3: 'design/shots/empty-light.png',
  p4: 'design/shots/empty-dark.png',
  p5: 'design/fox.webp',
  p6: 'design/comp.png',
}

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  try {
    const file = url.pathname === '/api/image2/asset'
      ? ASSETS[url.searchParams.get('id')] ?? 'design/comp.png'
      : normalize(join(ROOT, decodeURIComponent(url.pathname)))
    if (url.pathname !== '/api/image2/asset' && !file.startsWith(ROOT)) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('outside the workspace')
      return
    }
    const bytes = await readFile(file)
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(bytes)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`preview server on http://127.0.0.1:${PORT}/design/preview.html`)
})
