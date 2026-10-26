/**
 * Throwaway smoke test: drives the Host half against a local mock image API.
 * Run with: node smoke.mjs
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
}

const requests = []
const upstream = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => { chunks.push(chunk) })
  request.on('end', () => {
    const raw = Buffer.concat(chunks)
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, raw })
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5' }] }))
      return
    }
    if (request.url === '/v1/images/generations') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: PNG, revised_prompt: 'a rewritten prompt', output_format: 'png' }],
        size: '1024x1024',
        usage: { total_tokens: 10 },
      }))
      return
    }
    if (request.url === '/v1/images/edits') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        created: 2,
        data: [{ b64_json: PNG, revised_prompt: 'an edited prompt', output_format: 'png' }],
        size: '512x512',
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('no such route')
  })
})
await new Promise(resolve => { upstream.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${upstream.address().port}`

const profile = await mkdtemp(join(tmpdir(), 'image2-smoke-'))
const outputDir = join(profile, 'out')
const workspace = join(profile, 'ws')
await mkdir(workspace, { recursive: true })
process.env.DSH_PROFILE_DIR = profile

const { apply, inject, name } = await import('./index.js')
console.log(`plugin: name=${name} inject=${inject.join(',')}`)

const routes = new Map()
const tools = []
const ctx = {
  effect: fn => fn(),
  get: key => {
    if (key === 'tools') return { register: definition => { tools.push(definition); return () => {} } }
    if (key === 'workingDirectory') return { ensure: async () => workspace }
    return undefined
  },
  connection: {
    fetch: {
      register: route => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  },
}
apply(ctx)

check('six routes registered', routes.size === 6, [...routes.keys()].join(','))
check('two tools registered', tools.length === 2, tools.map(tool => tool.name).join(','))
check('generate tool present', tools.some(tool => tool.name === 'image2_generate'))
check('edit tool present', tools.some(tool => tool.name === 'image2_edit'))

const call = async (path, method = 'GET', body) => {
  const route = routes.get(path.split('?')[0])
  if (route === undefined) throw new Error(`no route ${path}`)
  const request = new Request(`http://127.0.0.1:63321${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const response = await route.fetch(request)
  return { status: response.status, payload: await response.json() }
}

const callBinary = async (path) => {
  const route = routes.get(path.split('?')[0])
  if (route === undefined) throw new Error(`no route ${path}`)
  const response = await route.fetch(new Request(`http://127.0.0.1:63321${path}`))
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, type: response.headers.get('content-type'), bytes }
}

console.log('settings')
const defaults = await call('/api/image2/settings')
check('GET defaults 200', defaults.status === 200)
check('default base url', defaults.payload.value.baseUrl === 'https://image.codesonline.dev/v1', JSON.stringify(defaults.payload.value.baseUrl))
check('default model', defaults.payload.value.model === 'gpt-image-2.5')
check('default size', defaults.payload.value.size === '16:9', String(defaults.payload.value.size))
check('default quality', defaults.payload.value.quality === 'auto', String(defaults.payload.value.quality))
check('default background', defaults.payload.value.background === 'auto', String(defaults.payload.value.background))
check('no key yet', defaults.payload.value.hasApiKey === false)
check('no apiKey field leaks', !('apiKey' in defaults.payload.value))

const saved = await call('/api/image2/settings', 'POST', {
  baseUrl: `${origin}/v1/images/generations/`,
  apiKey: 'Bearer sk-secret-1234',
  outputDir,
})
check('POST settings 200', saved.status === 200, JSON.stringify(saved.payload))
check('pasted route normalized away', saved.payload.value.baseUrl === `${origin}/v1`, saved.payload.value.baseUrl)
check('key reported present', saved.payload.value.hasApiKey === true)
check('key masked', saved.payload.value.apiKeyHint === '••••1234', saved.payload.value.apiKeyHint)
check('key never echoed', JSON.stringify(saved.payload).includes('sk-secret') === false)

const stored = JSON.parse(await readFile(join(profile, 'image2', 'settings.json'), 'utf8'))
check('key stored on disk', stored.apiKey === 'sk-secret-1234', stored.apiKey)

console.log('test route')
const probed = await call('/api/image2/test', 'POST', {})
check('probe 200', probed.status === 200, JSON.stringify(probed.payload))
check('probe used bearer auth', requests.some(r => r.url === '/v1/models' && r.authorization === 'Bearer sk-secret-1234'))

console.log('generate route')
const generated = await call('/api/image2/generate', 'POST', { prompt: 'a red fox', size: '16:9', quality: 'high' })
check('generate 200', generated.status === 200, JSON.stringify(generated.payload).slice(0, 300))
const item = generated.payload.value?.item ?? {}
check('no data url in envelope', JSON.stringify(generated.payload).length < 2000, String(JSON.stringify(generated.payload).length))
check('saved file exists', typeof item.file === 'string' && (await stat(item.file)).size > 0)
check('file path inside output dir', String(item.file).startsWith(outputDir))
check('file is a real png', String(item.file).endsWith('.png'))
check('media type', item.mediaType === 'image/png')
check('byte count', typeof item.bytes === 'number' && item.bytes > 0, String(item.bytes))
check('revised prompt', item.revisedPrompt === 'a rewritten prompt')
check('size reported', item.size === '1024x1024', String(item.size))
check('entry has an id', typeof item.id === 'string' && item.id.length === 16, String(item.id))
check('entry keeps the prompt', item.prompt === 'a red fox')
check('entry is a generation', item.kind === 'generate', String(item.kind))
check('envelope carries the gallery', Array.isArray(generated.payload.value?.items) && generated.payload.value.items[0]?.id === item.id)

const upstreamBody = JSON.parse(requests.filter(r => r.url === '/v1/images/generations').at(-1).raw.toString('utf8'))
check('model sent', upstreamBody?.model === 'gpt-image-2.5', JSON.stringify(upstreamBody))
check('prompt sent', upstreamBody?.prompt === 'a red fox')
check('size sent', upstreamBody?.size === '16:9')
check('quality override sent', upstreamBody?.quality === 'high')
check('b64 requested', upstreamBody?.response_format === 'b64_json')
check('n=1', upstreamBody?.n === 1)
check('background defaults to auto', upstreamBody?.background === 'auto', String(upstreamBody?.background))

console.log('gallery')
const listed = await call('/api/image2/history')
check('history 200', listed.status === 200)
check('history has one entry', listed.payload.value.items.length === 1)
check('history entry matches', listed.payload.value.items[0].id === item.id)

const asset = await callBinary(`/api/image2/asset?id=${item.id}`)
check('asset 200', asset.status === 200, String(asset.status))
check('asset is a png', asset.type === 'image/png', String(asset.type))
check('asset streams the bytes', asset.bytes.equals(Buffer.from(PNG, 'base64')))

const missingAsset = await call('/api/image2/asset?id=0123456789abcdef')
check('unknown asset 404', missingAsset.status === 404 && missingAsset.payload.code === 'not-found', JSON.stringify(missingAsset.payload))

const second = await call('/api/image2/generate', 'POST', { prompt: 'a blue whale' })
check('second generate 200', second.status === 200)
check('gallery is newest first',
  second.payload.value?.items?.length === 2 && second.payload.value.items[0].id === second.payload.value.item.id)

const deleted = await call('/api/image2/history/delete', 'POST', { ids: [second.payload.value.item.id] })
check('delete 200', deleted.status === 200, JSON.stringify(deleted.payload).slice(0, 200))
check('deleted entry is gone', deleted.payload.value.items.length === 1 && deleted.payload.value.items[0].id === item.id)
check('deleted file stays on disk', (await stat(item.file)).size > 0)
const afterDelete = await call(`/api/image2/asset?id=${second.payload.value.item.id}`)
check('deleted asset 404', afterDelete.status === 404)
const emptyDelete = await call('/api/image2/history/delete', 'POST', { ids: [] })
check('empty id list 400', emptyDelete.status === 400 && emptyDelete.payload.code === 'invalid-request')

console.log('background parameter')
const transparent = await call('/api/image2/generate', 'POST', { prompt: 'a cut-out sticker', background: 'transparent' })
check('background transparent accepted', transparent.status === 200, JSON.stringify(transparent.payload).slice(0, 200))
const transparentBody = JSON.parse(requests.filter(r => r.url === '/v1/images/generations').at(-1).raw.toString('utf8'))
check('background transparent sent', transparentBody?.background === 'transparent', String(transparentBody?.background))
const nonsense = await call('/api/image2/generate', 'POST', { prompt: 'a plain picture', background: 'plaid' })
const nonsenseBody = JSON.parse(requests.filter(r => r.url === '/v1/images/generations').at(-1).raw.toString('utf8'))
check('unknown background falls back to auto', nonsense.status === 200 && nonsenseBody?.background === 'auto', String(nonsenseBody?.background))

console.log('tool: generate')
const generateTool = tools.find(tool => tool.name === 'image2_generate')
const toolResult = await generateTool.execute({ prompt: 'a blue whale', size: '1:1' }, { agent: { id: 'session-1' } })
check('tool returns path', typeof toolResult.file === 'string' && (await stat(toolResult.file)).size > 0, JSON.stringify(toolResult))
check('workspace call writes to imgout', toolResult.file.startsWith(join(workspace, 'imgout')), toolResult.file)
const blocks = generateTool.output.render({ prompt: 'x' }, toolResult)
check('tool renders text block', blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.includes(toolResult.file))
const named = await generateTool.execute({ prompt: 'a named place', outputDir: join(profile, 'elsewhere') })
check('explicit outputDir wins', named.file.startsWith(join(profile, 'elsewhere')), named.file)

console.log('tool: edit')
const source = join(workspace, 'src.png')
await writeFile(source, Buffer.from(PNG, 'base64'))
const editTool = tools.find(tool => tool.name === 'image2_edit')
const edited = await editTool.execute({ image: 'src.png', prompt: 'make it dusk' }, { agent: { id: 'session-1' } })
check('edit returns a new file', edited.file !== source && (await stat(edited.file)).size > 0, JSON.stringify(edited))
check('edit writes beside the workspace', edited.file.startsWith(join(workspace, 'imgout')), edited.file)
check('edit leaves the source alone', (await stat(source)).size > 0)

const editRequest = requests.filter(r => r.url === '/v1/images/edits').at(-1)
const editBody = editRequest.raw.toString('latin1')
check('edit posts multipart', String(editRequest.authorization) === 'Bearer sk-secret-1234')
check('edit sends the prompt', editBody.includes('make it dusk'))
check('edit sends the image part', editBody.includes('name="image"') && editBody.includes('filename="src.png"'))
check('edit sends the model', editBody.includes('gpt-image-2.5'))
check('edit asks for png', editBody.includes('name="output_format"') && editBody.includes('png'))
check('edit sends background', editBody.includes('name="background"') && editBody.includes('auto'))

const editListed = await call('/api/image2/history')
check('edit lands in the gallery', editListed.payload.value.items.some(entry => entry.id !== undefined && entry.kind === 'edit'))

const missingSource = await editTool.execute({ image: 'nope.png', prompt: 'x' }, { agent: { id: 'session-1' } })
  .then(() => null, error => error)
check('missing source fails cleanly',
  missingSource !== null && missingSource.code === 'invalid-request' && missingSource.message.includes('nope.png'),
  String(missingSource?.message))

console.log('error paths')
const noPrompt = await call('/api/image2/generate', 'POST', { prompt: '   ' })
check('empty prompt 400', noPrompt.status === 400 && noPrompt.payload.code === 'empty-prompt', JSON.stringify(noPrompt.payload))
const badUrl = await call('/api/image2/settings', 'POST', { baseUrl: 'not-a-url' })
check('bad url 400', badUrl.status === 400 && badUrl.payload.code === 'invalid-endpoint', JSON.stringify(badUrl.payload))
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/nope` })
const upstreamFailure = await call('/api/image2/generate', 'POST', { prompt: 'x' })
check('404 upstream maps to 502 upstream-error',
  upstreamFailure.status === 502 && upstreamFailure.payload.code === 'upstream-error'
  && typeof upstreamFailure.payload.error === 'string' && upstreamFailure.payload.error.includes('404'),
  JSON.stringify(upstreamFailure.payload).slice(0, 200))
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/v1` })

const unreachable = await call('/api/image2/settings', 'POST', { baseUrl: 'http://127.0.0.1:1/v1' })
check('unreachable endpoint saved', unreachable.status === 200)
const networkFailure = await call('/api/image2/generate', 'POST', { prompt: 'x' })
check('unreachable maps to network-error', networkFailure.payload.code === 'network-error', JSON.stringify(networkFailure.payload).slice(0, 200))
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/v1` })

const cleared = await call('/api/image2/settings', 'POST', { clearApiKey: true })
check('clear key', cleared.payload.value.hasApiKey === false)
const noKey = await call('/api/image2/generate', 'POST', { prompt: 'x' })
check('missing key 400', noKey.status === 400 && noKey.payload.code === 'missing-key', JSON.stringify(noKey.payload))
const clearedFile = JSON.parse(await readFile(join(profile, 'image2', 'settings.json'), 'utf8'))
check('cleared key on disk', clearedFile.apiKey === '')

upstream.close()
await rm(profile, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
