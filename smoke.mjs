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
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'] ?? '',
      raw,
    })
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5' }] }))
      return
    }
    if (request.url === '/slow/v1/images/generations' || request.url === '/slow/v1/images/edits') {
      /* An endpoint that takes its time: something for a cancel and a timeout to
         interrupt. The timer hangs off the *response*'s close, not the request's:
         Node fires the request side as soon as the body has been read — which is
         immediately here — so that would drop every answer instead of only the
         ones whose caller walked away. */
      const timer = setTimeout(() => {
        if (response.writableEnded || response.destroyed) return
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          created: 9,
          data: [{ b64_json: PNG, revised_prompt: 'slow', output_format: 'png' }],
          size: '1024x1024',
        }))
      }, 8000)
      response.on('close', () => { clearTimeout(timer) })
      response.on('error', () => { clearTimeout(timer) })
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
      /* This mock plays the gateway this plugin was built against: a JSON body
         is the only one it reads, and it wants the pictures as
         `images[].image_url` data URLs. Anything else is refused the way the
         real one refuses — with a body complaint, which is what makes the
         route's fallback walk the other spellings instead of giving up. Two
         `image` parts are a 400 of their own, so the multipart walk is covered
         too. */
      const text = raw.toString('utf8')
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      if (body !== null) {
        const urls = Array.isArray(body.images) ? body.images : []
        const shaped = urls.length > 0 && urls.every(entry => typeof entry?.image_url === 'string'
          && entry.image_url.startsWith('data:image/'))
        if (!shaped) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'images[].image_url is required' } }))
          return
        }
      } else if ((raw.toString('latin1').match(/name="image"/g) ?? []).length > 1) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'use image[] for several pictures' } }))
        return
      } else if (request.headers['content-type']?.startsWith('multipart/form-data') !== true) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'The request body must be JSON.' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        created: 2,
        data: [{ b64_json: PNG, revised_prompt: 'an edited prompt', output_format: 'png' }],
        size: '512x512',
      }))
      return
    }
    if (request.url === '/legacy/v1/images/edits') {
      /* The other half of the story: a plain OpenAI-compatible endpoint that
         only reads multipart, and says so in a way the route recognises as a
         body complaint. It forces the walk to reach its last spelling. */
      if ((request.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          created: 3,
          data: [{ b64_json: PNG, revised_prompt: 'a legacy edit', output_format: 'png' }],
          size: '512x512',
        }))
        return
      }
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Unsupported content type: send multipart/form-data.' } }))
      return
    }
    if (request.url === '/broken/v1/images/edits') {
      /* A route that refuses every spelling the way the one the user hit did.
         Nothing about it can be fixed by trying harder, so the point here is the
         error: it has to name what was tried, otherwise a stale build and a
         broken endpoint read exactly alike. */
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'The request body must be JSON.' } }))
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

check('seven routes registered', routes.size === 7, [...routes.keys()].join(','))
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

/**
 * Post one multipart body, the way the page does once reference pictures are
 * attached.
 * @param path - route path.
 * @param form - the form to send.
 * @returns the status and the parsed envelope.
 */
const callForm = async (path, form) => {
  const route = routes.get(path.split('?')[0])
  if (route === undefined) throw new Error(`no route ${path}`)
  const response = await route.fetch(new Request(`http://127.0.0.1:63321${path}`, { method: 'POST', body: form }))
  return { status: response.status, payload: await response.json() }
}

/**
 * Build a reference-bearing generate request.
 * @param prompt - the prompt field.
 * @param references - `[bytes, mediaType, name]` triples, in order.
 * @returns the form.
 */
const referenceForm = (prompt, references) => {
  const form = new FormData()
  form.append('prompt', prompt)
  form.append('size', '1:1')
  for (const [bytes, mediaType, name] of references) {
    form.append('reference', new Blob([bytes], { type: mediaType }), name)
  }
  return form
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
const editPayload = JSON.parse(editRequest.raw.toString('utf8'))
check('edit posts JSON', String(editRequest.authorization) === 'Bearer sk-secret-1234'
  && editPayload.prompt === 'make it dusk', JSON.stringify(editPayload).slice(0, 120))
check('edit carries the picture as a data URL',
  editPayload.images?.length === 1 && editPayload.images[0].image_url === `data:image/png;base64,${PNG}`,
  JSON.stringify(editPayload.images).slice(0, 80))
check('edit sends the model', editPayload.model === 'gpt-image-2.5', String(editPayload.model))
check('edit asks for png', editPayload.output_format === 'png', String(editPayload.output_format))
check('edit sends background', editPayload.background === 'auto', String(editPayload.background))

const editListed = await call('/api/image2/history')
check('edit lands in the gallery', editListed.payload.value.items.some(entry => entry.id !== undefined && entry.kind === 'edit'))

const missingSource = await editTool.execute({ image: 'nope.png', prompt: 'x' }, { agent: { id: 'session-1' } })
  .then(() => null, error => error)
check('missing source fails cleanly',
  missingSource !== null && missingSource.code === 'invalid-request' && missingSource.message.includes('nope.png'),
  String(missingSource?.message))

console.log('references: image to image')
const pixel = Buffer.from(PNG, 'base64')
const withReferences = await callForm('/api/image2/generate', referenceForm('combine these two', [
  [pixel, 'image/png', 'one.png'],
  [pixel, 'image/png', 'two.png'],
]))
check('reference generate 200', withReferences.status === 200, JSON.stringify(withReferences.payload).slice(0, 300))
check('reference generate is an edit', withReferences.payload.value?.item?.kind === 'edit', String(withReferences.payload.value?.item?.kind))
check('uploaded edit names no source file', withReferences.payload.value?.item?.sourceFile === undefined)
check('uploaded edit lands in the gallery', withReferences.payload.value?.items?.[0]?.id === withReferences.payload.value?.item?.id)

const editCalls = requests.filter(entry => entry.url === '/v1/images/edits')
const acceptedBody = JSON.parse(editCalls.at(-1).raw.toString('utf8'))
check('references are sent as a JSON body', editCalls.at(-1).contentType.startsWith('application/json'),
  editCalls.at(-1).contentType)
check('references ride as images[].image_url data URLs',
  acceptedBody.images?.length === 2
  && acceptedBody.images.every(entry => entry.image_url.startsWith('data:image/png;base64,')),
  JSON.stringify(acceptedBody.images).slice(0, 120))
check('the JSON body keeps the prompt', acceptedBody.prompt === 'combine these two', String(acceptedBody.prompt))
check('reference prompt never reaches generations',
  requests.filter(entry => entry.url === '/v1/images/generations').every(entry => !entry.raw.toString('utf8').includes('combine these two')))

const callsBeforeOne = requests.filter(entry => entry.url === '/v1/images/edits').length
const oneReference = await callForm('/api/image2/generate', referenceForm('one picture only', [[pixel, 'image/webp', 'only.webp']]))
check('single reference also edits', oneReference.status === 200 && oneReference.payload.value?.item?.kind === 'edit', JSON.stringify(oneReference.payload).slice(0, 200))
check('an accepted body is not re-probed',
  requests.filter(entry => entry.url === '/v1/images/edits').length - callsBeforeOne === 1)

const tooMany = await callForm('/api/image2/generate', referenceForm('too many', [
  [pixel, 'image/png', 'a.png'], [pixel, 'image/png', 'b.png'], [pixel, 'image/png', 'c.png'],
  [pixel, 'image/png', 'd.png'], [pixel, 'image/png', 'e.png'], [pixel, 'image/png', 'f.png'],
]))
check('six references 400', tooMany.status === 400 && tooMany.payload.code === 'too-many-references', JSON.stringify(tooMany.payload))
const notAnImage = await callForm('/api/image2/generate', referenceForm('not a picture', [[Buffer.from('hello'), 'text/plain', 'notes.txt']]))
check('non-image reference 400', notAnImage.status === 400 && notAnImage.payload.code === 'invalid-reference', JSON.stringify(notAnImage.payload))
const emptyReference = await callForm('/api/image2/generate', referenceForm('nothing attached', [[Buffer.alloc(0), 'image/png', 'empty.png']]))
check('empty part falls back to plain generation', emptyReference.status === 200 && emptyReference.payload.value?.item?.kind === 'generate', JSON.stringify(emptyReference.payload).slice(0, 200))
const noPromptForm = await callForm('/api/image2/generate', referenceForm('   ', [[pixel, 'image/png', 'one.png']]))
check('multipart without a prompt 400', noPromptForm.status === 400 && noPromptForm.payload.code === 'empty-prompt', JSON.stringify(noPromptForm.payload))

console.log('references: a multipart-only endpoint')
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/legacy/v1` })
const legacy = await callForm('/api/image2/generate', referenceForm('legacy edit', [[pixel, 'image/png', 'legacy.png']]))
check('a multipart-only endpoint still edits',
  legacy.status === 200 && legacy.payload.value?.item?.kind === 'edit', JSON.stringify(legacy.payload).slice(0, 200))
const legacyCalls = requests.filter(entry => entry.url === '/legacy/v1/images/edits')
check('the walk reaches the multipart spelling',
  legacyCalls.length === 3
  && legacyCalls.slice(0, 2).every(entry => entry.contentType.startsWith('application/json'))
  && legacyCalls[2].contentType.startsWith('multipart/form-data'),
  JSON.stringify(legacyCalls.map(entry => entry.contentType.split(';')[0])))
check('the multipart attempt keeps the prompt',
  legacyCalls[2].raw.toString('latin1').includes('legacy edit'))
const legacyBefore = legacyCalls.length
const legacyAgain = await callForm('/api/image2/generate', referenceForm('legacy again', [[pixel, 'image/png', 'again.png']]))
check('the accepted spelling is tried first next time',
  legacyAgain.status === 200
  && requests.filter(entry => entry.url === '/legacy/v1/images/edits').length - legacyBefore === 1,
  String(requests.filter(entry => entry.url === '/legacy/v1/images/edits').length - legacyBefore))
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/v1` })

console.log('references: an endpoint that refuses every body')
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/broken/v1` })
const broken = await callForm('/api/image2/generate', referenceForm('never accepted', [[pixel, 'image/png', 'x.png']]))
const brokenCalls = requests.filter(entry => entry.url === '/broken/v1/images/edits')
check('every spelling is tried before giving up', brokenCalls.length === 4,
  JSON.stringify(brokenCalls.map(entry => entry.contentType.split(';')[0])))
check('the failure still maps to upstream-error',
  broken.status === 502 && broken.payload.code === 'upstream-error', JSON.stringify(broken.payload).slice(0, 160))
check('the failure names the spellings it tried',
  typeof broken.payload.error === 'string'
  && broken.payload.error.includes('images=500')
  && broken.payload.error.includes('image=500')
  && broken.payload.error.includes('multipart-image=500')
  && broken.payload.error.includes('multipart-image[]=500'),
  String(broken.payload.error).slice(0, 220))
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/v1` })

console.log('timeout setting')
const timeoutDefault = await call('/api/image2/settings')
check('timeout defaults to 180', timeoutDefault.payload.value.timeoutSeconds === '180',
  String(timeoutDefault.payload.value.timeoutSeconds))
const timeoutSaved = await call('/api/image2/settings', 'POST', { timeoutSeconds: 45 })
check('timeout saves', timeoutSaved.payload.value.timeoutSeconds === '45',
  String(timeoutSaved.payload.value.timeoutSeconds))
const timeoutLow = await call('/api/image2/settings', 'POST', { timeoutSeconds: 1 })
check('a tiny timeout clamps up to 5', timeoutLow.payload.value.timeoutSeconds === '5',
  String(timeoutLow.payload.value.timeoutSeconds))
const timeoutHigh = await call('/api/image2/settings', 'POST', { timeoutSeconds: '9999' })
check('a huge timeout clamps down to 900', timeoutHigh.payload.value.timeoutSeconds === '900',
  String(timeoutHigh.payload.value.timeoutSeconds))
const timeoutBad = await call('/api/image2/settings', 'POST', { timeoutSeconds: 'soon' })
check('a non-numeric timeout 400', timeoutBad.status === 400 && timeoutBad.payload.code === 'invalid-timeout',
  JSON.stringify(timeoutBad.payload).slice(0, 140))
const timeoutDisk = JSON.parse(await readFile(join(profile, 'image2', 'settings.json'), 'utf8'))
check('the rejected value never reached disk', timeoutDisk.timeoutSeconds === '900', String(timeoutDisk.timeoutSeconds))

console.log('cancel and timeout on a slow endpoint')
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/slow/v1`, timeoutSeconds: 180 })
const slowForm = (prompt, id) => {
  const form = new FormData()
  form.append('prompt', prompt)
  form.append('requestId', id)
  return form
}
const beforeRuns = (await call('/api/image2/history')).payload.value.items.length
const running = callForm('/api/image2/generate', slowForm('slow one', 'run-test-cancel'))
await new Promise(resolve => setTimeout(resolve, 400))
const cancelUnknown = await call('/api/image2/cancel', 'POST', { requestId: 'run-not-running' })
check('cancelling a run that is not open answers false',
  cancelUnknown.payload.value.cancelled === false, JSON.stringify(cancelUnknown.payload))
const cancelBad = await call('/api/image2/cancel', 'POST', { requestId: 'not an id' })
check('a malformed requestId 400', cancelBad.status === 400 && cancelBad.payload.code === 'invalid-request',
  JSON.stringify(cancelBad.payload).slice(0, 140))
const cancelOk = await call('/api/image2/cancel', 'POST', { requestId: 'run-test-cancel' })
check('cancelling the open run answers true', cancelOk.payload.value.cancelled === true,
  JSON.stringify(cancelOk.payload))
const stopped = await running
check('the cancelled run answers cancelled',
  stopped.status === 499 && stopped.payload.code === 'cancelled', JSON.stringify(stopped.payload).slice(0, 160))
check('a cancelled run saves nothing',
  (await call('/api/image2/history')).payload.value.items.length === beforeRuns)

await call('/api/image2/settings', 'POST', { timeoutSeconds: 5 })
const timeoutStarted = Date.now()
const timedOut = await callForm('/api/image2/generate', slowForm('slow two', 'run-test-timeout'))
const timeoutWaited = Date.now() - timeoutStarted
check('a run past the timeout maps to network-error',
  timedOut.status === 504 && timedOut.payload.code === 'network-error', JSON.stringify(timedOut.payload).slice(0, 160))
check('the timeout error names the limit',
  String(timedOut.payload.error).includes('5 seconds'), String(timedOut.payload.error).slice(0, 140))
check('the run stopped at the timeout, not at the endpoint', timeoutWaited < 6000, `${timeoutWaited}ms`)

const gone = new AbortController()
const detached = routes.get('/api/image2/generate').fetch(new Request(
  'http://127.0.0.1:63321/api/image2/generate',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'slow three' }),
    signal: gone.signal,
  },
)).then(async response => ({ status: response.status, payload: await response.json() }))
await new Promise(resolve => setTimeout(resolve, 400))
const detachedStarted = Date.now()
gone.abort()
const dropped = await detached
check('a page that goes away drops its run',
  dropped.status === 504 && String(dropped.payload.error).includes('abort'),
  JSON.stringify(dropped.payload).slice(0, 160))
check('the run did not wait for the endpoint', Date.now() - detachedStarted < 2000,
  `${Date.now() - detachedStarted}ms`)
await call('/api/image2/settings', 'POST', { baseUrl: `${origin}/v1`, timeoutSeconds: 180 })

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

// Idle keep-alive sockets would otherwise hold `close` open until they time out.
upstream.closeAllConnections()
upstream.close()
await rm(profile, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
