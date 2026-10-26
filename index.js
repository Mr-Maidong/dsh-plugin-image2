/**
 * Host half of the Image studio bundle.
 *
 * Owns two durable facts — this profile's image-API settings and the gallery of
 * pictures generated so far — and the routes on Connection's authenticated
 * `/api` channel that read them:
 *
 * - `GET|POST /api/image2/settings` reads or updates the endpoint, model, and
 *   output directory, and stores the API key without ever echoing it back.
 * - `POST /api/image2/test` asks the configured endpoint for its model list, so
 *   a user can tell a bad key from a bad URL before spending a generation.
 * - `POST /api/image2/generate` posts one prompt to `/images/generations`, saves
 *   the returned image under the output directory, and answers with the new
 *   history entry plus the whole list.
 * - `GET /api/image2/history` lists the saved pictures, newest first.
 * - `POST /api/image2/history/delete` forgets the entries it is given; the
 *   files on disk stay where the user put them.
 * - `GET /api/image2/asset?id=` streams one saved picture, so the page never
 *   carries megabytes of base64 through a JSON envelope.
 *
 * Two agent tools ride the same core: `image2_generate` and `image2_edit`. A
 * tool call made inside a workspace writes to `<workspace>/imgout` unless the
 * call names a directory, so an agent's pictures land beside its work instead of
 * in the user's picture library.
 *
 * The browser never receives the key. Settings live in the profile directory as
 * `image2/settings.json` with owner-only permissions where the filesystem honors
 * them; nothing here writes a secret into a Session event, a log, or a response.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Diagnostics label for this plugin. */
export const name = 'image2-studio'

/** Connection supplies the authenticated shared `/api` channel these routes ride on. */
export const inject = ['connection']

const SETTINGS_ROUTE = '/api/image2/settings'
const TEST_ROUTE = '/api/image2/test'
const GENERATE_ROUTE = '/api/image2/generate'
const HISTORY_ROUTE = '/api/image2/history'
const HISTORY_DELETE_ROUTE = '/api/image2/history/delete'
const ASSET_ROUTE = '/api/image2/asset'

/** How many pictures the gallery remembers; older entries drop out of the list. */
const HISTORY_LIMIT = 200

/** The directory an agent's pictures land in when it generates inside a workspace. */
const WORKSPACE_OUTPUT_DIR = 'imgout'

/** Aspect ratios the generation endpoint accepts as `size`, matching the gpt-image2 skill. */
const SIZES = ['1:1', '5:4', '4:3', '3:2', '16:9', '21:9', '4:5', '3:4', '2:3', '9:16']

/** Render qualities the endpoint accepts as `quality`. */
const QUALITIES = ['low', 'medium', 'high', 'auto']

/** Image generation is slow; abort rather than leave a turn hanging forever. */
const GENERATE_TIMEOUT_MS = 180_000

/** A reachability probe should fail fast. */
const PROBE_TIMEOUT_MS = 20_000

/** Default endpoint from the gpt-image2 skill's own default base URL. */
const DEFAULT_BASE_URL = 'https://image.codesonline.dev/v1'

/** Default model from the gpt-image2 skill. */
const DEFAULT_MODEL = 'gpt-image-2.5'

/** Shape a fresh profile starts with; the page shows this until settings say otherwise. */
const DEFAULT_SIZE = '16:9'

/** Quality a fresh profile starts with. */
const DEFAULT_QUALITY = 'auto'

/** Background a fresh profile starts with; `auto` lets the endpoint decide. */
const DEFAULT_BACKGROUND = 'auto'

/** Backgrounds the endpoint accepts: `transparent` for cut-out art, `opaque` to flatten it. */
const BACKGROUNDS = ['auto', 'transparent', 'opaque']

/** One rejected request: `code` is the stable token the page localizes. */
class RequestError extends Error {
  /**
   * @param code - stable reason token understood by the Client dictionaries.
   * @param message - technical detail safe to show beside the localized text.
   * @param status - HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * The directory holding this profile's own state.
 * @returns the configured profile directory, or the default one when unset.
 */
function profileDirectory() {
  const configured = process.env.DSH_PROFILE_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** @returns the absolute settings file path for the active profile. */
function settingsFile() {
  return join(profileDirectory(), 'image2', 'settings.json')
}

/** @returns the settings a fresh profile starts from. */
function defaults() {
  return {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    model: DEFAULT_MODEL,
    outputDir: join(homedir(), 'Pictures', 'image2'),
    quality: DEFAULT_QUALITY,
    size: DEFAULT_SIZE,
    background: DEFAULT_BACKGROUND,
  }
}

/**
 * Read the stored settings, falling back to defaults for anything absent.
 * A missing or corrupt file is a fresh profile, never an error.
 * @returns the effective settings.
 */
async function readSettings() {
  const fallback = defaults()
  let text
  try {
    text = await readFile(settingsFile(), 'utf8')
  } catch {
    return fallback
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
  const settings = { ...fallback }
  for (const key of Object.keys(settings)) {
    if (typeof parsed[key] === 'string') settings[key] = parsed[key]
  }
  return settings
}

/**
 * Replace the stored settings.
 * @param settings - the complete settings object to persist.
 */
async function writeSettings(settings) {
  const file = settingsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** @returns the absolute history file path for the active profile. */
function historyFile() {
  return join(profileDirectory(), 'image2', 'history.json')
}

/**
 * Whether one parsed record is a history entry worth keeping.
 * @param value - a candidate read back from disk.
 * @returns true for a record the gallery can render.
 */
function isHistoryItem(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.id === 'string' && value.id !== ''
    && typeof value.file === 'string' && value.file !== ''
    && typeof value.mediaType === 'string' && value.mediaType !== ''
    && Number.isFinite(value.bytes)
}

/**
 * Read the gallery, newest first. A missing or corrupt file is an empty gallery.
 * @returns the history object.
 */
async function readHistory() {
  let text
  try {
    text = await readFile(historyFile(), 'utf8')
  } catch {
    return { items: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { items: [] }
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  return { items: items.filter(isHistoryItem) }
}

/**
 * Replace the stored gallery.
 * @param history - the complete history object to persist.
 */
async function writeHistory(history) {
  const file = historyFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(history, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Put one entry at the front of the gallery, dropping the oldest past the limit.
 * @param entry - the finished entry.
 * @returns the gallery after the insert.
 */
async function addHistoryEntry(entry) {
  const history = await readHistory()
  const next = { items: [entry, ...history.items].slice(0, HISTORY_LIMIT) }
  await writeHistory(next)
  return next
}

/**
 * Forget the given entries. The image files stay on disk, because the gallery is
 * a list of pictures this page made, not the only way to reach those files.
 * @param ids - history ids to remove.
 * @returns the gallery after the removal.
 */
async function deleteHistoryEntries(ids) {
  const wanted = new Set(ids)
  const history = await readHistory()
  const next = { items: history.items.filter(item => !wanted.has(item.id)) }
  await writeHistory(next)
  return next
}

/**
 * Show a stored key's shape without revealing it: the last four characters are
 * enough to tell which key is saved, and useless to anyone else.
 * @param key - the stored key.
 * @returns a masked hint, or an empty string when no key is stored.
 */
function maskKey(key) {
  if (key === '') return ''
  if (key.length <= 8) return '••••'
  return `••••${key.slice(-4)}`
}

/**
 * The settings as the browser may see them: never the key itself.
 * @param settings - the effective settings.
 * @returns the redacted view plus the defaults the form hints at.
 */
function publicSettings(settings) {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    outputDir: settings.outputDir,
    quality: settings.quality,
    size: settings.size,
    background: settings.background,
    hasApiKey: settings.apiKey !== '',
    apiKeyHint: maskKey(settings.apiKey),
    defaults: defaults(),
  }
}

/**
 * Normalize a user-typed endpoint into the base URL the API paths hang off.
 * Accepts a pasted `/images/generations` or `/images/edits` route, a trailing
 * slash, and a `Bearer ` prefix pasted along with the key.
 * @param value - the raw text field.
 * @returns the normalized base URL, or an empty string when the field is blank.
 * @throws {RequestError} when the value is not an absolute http(s) URL.
 */
function normalizeBaseUrl(value) {
  const trimmed = String(value).trim().replace(/\/+$/u, '')
  if (trimmed === '') return ''
  if (!/^https?:\/\//iu.test(trimmed)) {
    throw new RequestError('invalid-endpoint', 'The endpoint must start with http:// or https://.')
  }
  try {
    new URL(trimmed)
  } catch {
    throw new RequestError('invalid-endpoint', `Not a valid URL: ${trimmed}`)
  }
  return trimmed.replace(/\/images\/(?:generations|edits)$/u, '')
}

/**
 * Strip an accidentally pasted authorization scheme from a key.
 * @param value - the raw key field.
 * @returns the bare key.
 */
function apiKeyValue(value) {
  return String(value).trim().replace(/^Bearer\s+/iu, '')
}

/**
 * Expand a leading `~` so the output directory reads like a shell path.
 * @param value - the configured directory.
 * @returns an absolute path.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Map an endpoint-declared output format to a media type.
 * @param value - `output_format`, a content type, or undefined.
 * @returns the media type, or undefined when the value is not recognized.
 */
function mediaTypeOf(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'png' || normalized === 'image/png') return 'image/png'
  if (normalized === 'jpeg' || normalized === 'jpg' || normalized === 'image/jpeg') return 'image/jpeg'
  if (normalized === 'webp' || normalized === 'image/webp') return 'image/webp'
  return undefined
}

/**
 * Recover the media type from the leading bytes of a base64 payload, for
 * endpoints that omit `output_format`.
 * @param base64 - the encoded image.
 * @returns the detected media type, defaulting to PNG.
 */
function mediaTypeFromBase64(base64) {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

/**
 * Build a collision-free file name for one generated image.
 * @param mediaType - the image's media type, which selects the extension.
 * @returns a file name such as `image2-20260101-120000-a1b2c3.png`.
 */
function filenameFor(mediaType) {
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `image2-${stamp}-${randomBytes(3).toString('hex')}.${extension}`
}

/** @param error - any thrown value. @returns a printable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Describe a transport failure in words a user can act on.
 * @param error - the thrown fetch error.
 * @returns the detail line.
 */
function networkDetail(error) {
  const message = messageOf(error)
  if (/abort|timeout/iu.test(message)) return `The request timed out or was aborted: ${message}`
  return message
}

/**
 * Truncate an upstream body so one HTML error page cannot flood the response.
 * @param text - the raw body.
 * @param limit - maximum characters to keep.
 * @returns the trimmed text.
 */
function truncate(text, limit) {
  const compact = text.replace(/\s+/gu, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`
}

/** @param value - a candidate. @returns the value when it is one of `allowed`. */
function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
}

/**
 * Wrap a handler's result in the page's JSON envelope.
 * @param value - the success payload.
 * @returns the response.
 */
function reply(value) {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * Build the failure envelope the page localizes by `code`.
 * @param code - stable reason token.
 * @param error - technical detail.
 * @param status - HTTP status.
 * @returns the response.
 */
function fault(code, error, status) {
  return Response.json({ ok: false, code, error }, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Read a JSON object body, tolerating an empty one.
 * @param request - the incoming request.
 * @returns the parsed object, or an empty object.
 * @throws {RequestError} when the body is not a JSON object.
 */
async function readJson(request) {
  const text = await request.text()
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RequestError('invalid-request', 'The request body must be JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RequestError('invalid-request', 'The request body must be a JSON object.')
  }
  return parsed
}

/**
 * Generate one image, save it, and describe it for both callers.
 * @param input.prompt - the prompt to send.
 * @param input.size - an optional aspect ratio overriding the saved preference.
 * @param input.quality - an optional quality overriding the saved preference.
 * @param input.background - an optional background overriding the saved preference.
 * @param input.outputDir - an optional directory overriding the saved preference.
 * @returns the new gallery entry and the gallery after the insert.
 * @throws {RequestError} for every refusal or upstream failure.
 */
async function generateImage(input) {
  const settings = await readSettings()
  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  if (baseUrl === '') throw new RequestError('missing-endpoint', 'No image API endpoint is configured.')
  if (settings.apiKey === '') throw new RequestError('missing-key', 'No image API key is saved for this profile.')

  const payload = {
    model: settings.model === '' ? DEFAULT_MODEL : settings.model,
    prompt: input.prompt,
    n: 1,
    quality: input.quality ?? (oneOf(settings.quality, QUALITIES) ?? DEFAULT_QUALITY),
    background: input.background ?? (oneOf(settings.background, BACKGROUNDS) ?? DEFAULT_BACKGROUND),
    response_format: 'b64_json',
  }
  const size = input.size ?? (oneOf(settings.size, SIZES) ?? DEFAULT_SIZE)
  if (size !== '') payload.size = size

  let response
  try {
    response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new RequestError('network-error', networkDetail(error), 504)
  }

  return persistImage({
    ...await readImagePayload(response),
    prompt: input.prompt,
    kind: 'generate',
    outputDirectory: input.outputDir ?? (settings.outputDir === '' ? defaults().outputDir : settings.outputDir),
  })
}

/**
 * Turn one images response into the bytes and metadata both operations save.
 * @param response - the endpoint's answer to `/images/generations` or `/images/edits`.
 * @returns the base64 payload and the endpoint's own metadata.
 * @throws {RequestError} when the endpoint refused or answered without an image.
 */
async function readImagePayload(response) {
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new RequestError('upstream-error', `API ${response.status}: ${truncate(detail, 500)}`, 502)
  }

  let body
  try {
    body = await response.json()
  } catch {
    throw new RequestError('upstream-error', 'The endpoint answered with a body that is not JSON.', 502)
  }

  const first = Array.isArray(body?.data) ? body.data[0] : undefined
  if (typeof first !== 'object' || first === null) {
    throw new RequestError('upstream-error', 'The endpoint returned no image in `data`.', 502)
  }

  let base64 = typeof first.b64_json === 'string' ? first.b64_json : ''
  let mediaType = mediaTypeOf(first.output_format)
  if (base64 === '') {
    if (typeof first.url !== 'string' || first.url === '') {
      throw new RequestError('upstream-error', 'The endpoint returned neither image bytes nor a download URL.', 502)
    }
    let download
    try {
      download = await fetch(first.url, { signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS) })
    } catch (error) {
      throw new RequestError('network-error', networkDetail(error), 504)
    }
    if (!download.ok) {
      throw new RequestError('upstream-error', `Downloading the generated image failed with status ${download.status}.`, 502)
    }
    base64 = Buffer.from(await download.arrayBuffer()).toString('base64')
    mediaType = mediaTypeOf(download.headers.get('content-type')) ?? mediaType
  }
  mediaType = mediaType ?? mediaTypeFromBase64(base64)

  return {
    base64,
    mediaType,
    revisedPrompt: typeof first.revised_prompt === 'string' ? first.revised_prompt : '',
    size: typeof body.size === 'string' ? body.size : (typeof first.size === 'string' ? first.size : ''),
  }
}

/**
 * Save one finished picture and put it at the front of the gallery.
 * @param input.base64 - the image bytes, base64 encoded.
 * @param input.mediaType - the media type those bytes carry.
 * @param input.prompt - the prompt the picture answers.
 * @param input.revisedPrompt - the endpoint's rewrite of that prompt, when it sent one.
 * @param input.size - the pixel size the endpoint reported.
 * @param input.kind - how the picture was made.
 * @param input.sourceFile - the picture an edit started from, when there was one.
 * @param input.outputDirectory - where to write the file.
 * @returns the new entry and the gallery after the insert.
 * @throws {RequestError} when the bytes are empty or the file cannot be written.
 */
async function persistImage(input) {
  const imageBytes = Buffer.from(input.base64, 'base64')
  if (imageBytes.length === 0) {
    throw new RequestError('upstream-error', 'The endpoint returned an empty image.', 502)
  }
  const outputDir = expandHome(input.outputDirectory)
  await mkdir(outputDir, { recursive: true })
  const file = join(outputDir, filenameFor(input.mediaType))
  try {
    await writeFile(file, imageBytes)
  } catch (error) {
    throw new RequestError('write-error', `Could not write ${file}: ${messageOf(error)}`, 500)
  }
  const item = {
    id: randomBytes(8).toString('hex'),
    file,
    mediaType: input.mediaType,
    bytes: imageBytes.length,
    size: input.size,
    prompt: input.prompt,
    revisedPrompt: input.revisedPrompt,
    kind: input.kind,
    createdAt: new Date().toISOString(),
  }
  if (typeof input.sourceFile === 'string' && input.sourceFile !== '') item.sourceFile = input.sourceFile
  const history = await addHistoryEntry(item)
  return { item, items: history.items }
}

/**
 * Edit one picture: post it with a prompt to `/images/edits` and save the answer.
 * @param input.imagePath - the picture to edit, absolute or relative to the call site.
 * @param input.baseDir - the directory a relative image path is read from.
 * @param input.prompt - the instruction describing the change.
 * @param input.maskPath - an optional mask marking the editable region.
 * @param input.size - an optional aspect ratio for the result.
 * @param input.quality - an optional quality for the result.
 * @param input.background - an optional background for the result.
 * @param input.outputDir - an optional directory for the result.
 * @returns the new gallery entry and the gallery after the insert.
 * @throws {RequestError} for every refusal or upstream failure.
 */
async function editImage(input) {
  const settings = await readSettings()
  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  if (baseUrl === '') throw new RequestError('missing-endpoint', 'No image API endpoint is configured.')
  if (settings.apiKey === '') throw new RequestError('missing-key', 'No image API key is saved for this profile.')

  const imagePath = localPath(input.imagePath, input.baseDir)
  const imageBytes = await readLocalImage(imagePath, 'image')

  const form = new FormData()
  form.append('model', settings.model === '' ? DEFAULT_MODEL : settings.model)
  form.append('prompt', input.prompt)
  form.append('n', '1')
  form.append('quality', input.quality ?? (oneOf(settings.quality, QUALITIES) ?? DEFAULT_QUALITY))
  form.append('background', input.background ?? (oneOf(settings.background, BACKGROUNDS) ?? DEFAULT_BACKGROUND))
  form.append('output_format', 'png')
  if (typeof input.size === 'string' && input.size !== '') form.append('size', input.size)
  form.append('image', new Blob([imageBytes], { type: mediaTypeOf(imagePath) }), basename(imagePath))

  if (typeof input.maskPath === 'string' && input.maskPath.trim() !== '') {
    const maskPath = localPath(input.maskPath, input.baseDir)
    const maskBytes = await readLocalImage(maskPath, 'mask')
    form.append('mask', new Blob([maskBytes], { type: mediaTypeOf(maskPath) }), basename(maskPath))
  }

  let response
  try {
    response = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new RequestError('network-error', networkDetail(error), 504)
  }

  return persistImage({
    ...await readImagePayload(response),
    prompt: input.prompt,
    kind: 'edit',
    sourceFile: imagePath,
    outputDirectory: input.outputDir ?? (settings.outputDir === '' ? defaults().outputDir : settings.outputDir),
  })
}

/**
 * Resolve a path the caller named, treating relative paths as relative to it.
 * @param path - the path from the request or the tool call.
 * @param baseDir - the directory relative paths start from.
 * @returns an absolute path.
 */
function localPath(path, baseDir) {
  if (isAbsolute(path)) return path
  const base = typeof baseDir === 'string' && baseDir !== '' ? baseDir : process.cwd()
  return resolve(base, path)
}

/**
 * Read a local picture the caller named, naming the argument in any failure.
 * @param path - absolute path to read.
 * @param role - the argument name, so the message says which one was wrong.
 * @returns the file bytes.
 * @throws {RequestError} when the file cannot be read.
 */
async function readLocalImage(path, role) {
  try {
    return await readFile(path)
  } catch (error) {
    throw new RequestError('invalid-request', `Could not read the ${role} at ${path}: ${messageOf(error)}`)
  }
}

/**
 * `GET|POST /api/image2/settings`.
 * A POST stores only the fields it was given, so the page can save the endpoint
 * without resending a key it never received.
 * @param request - the incoming request.
 * @returns the redacted settings.
 */
async function handleSettings(request) {
  if (request.method === 'GET') return reply(publicSettings(await readSettings()))

  const body = await readJson(request)
  const next = { ...await readSettings() }
  if (body.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(body.baseUrl)
  if (body.model !== undefined) next.model = String(body.model).trim() === '' ? DEFAULT_MODEL : String(body.model).trim()
  if (body.outputDir !== undefined) next.outputDir = String(body.outputDir).trim() || defaults().outputDir
  if (body.quality !== undefined) next.quality = oneOf(body.quality, QUALITIES) ?? next.quality
  if (body.size !== undefined) next.size = oneOf(body.size, SIZES) ?? next.size
  if (body.background !== undefined) next.background = oneOf(body.background, BACKGROUNDS) ?? next.background
  if (body.clearApiKey === true) next.apiKey = ''
  if (body.apiKey !== undefined) {
    const apiKey = apiKeyValue(body.apiKey)
    if (apiKey !== '') next.apiKey = apiKey
  }
  if (next.baseUrl === '') {
    throw new RequestError('missing-endpoint', 'The endpoint cannot be empty.')
  }
  try {
    await writeSettings(next)
  } catch (error) {
    throw new RequestError('write-error', `Could not save the settings file: ${messageOf(error)}`, 500)
  }
  return reply(publicSettings(next))
}

/**
 * `POST /api/image2/test`: probe the endpoint's model list.
 * The form's unsaved values win, so a user can test before committing a key.
 * @param request - the incoming request.
 * @returns the answering status.
 */
async function handleTest(request) {
  const body = await readJson(request)
  const settings = await readSettings()
  const baseUrl = body.baseUrl === undefined ? normalizeBaseUrl(settings.baseUrl) : normalizeBaseUrl(body.baseUrl)
  const apiKey = body.apiKey === undefined ? settings.apiKey : (apiKeyValue(body.apiKey) || settings.apiKey)
  if (baseUrl === '') throw new RequestError('missing-endpoint', 'No image API endpoint is configured.')
  if (apiKey === '') throw new RequestError('missing-key', 'No image API key is saved for this profile.')

  let response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new RequestError('network-error', networkDetail(error), 504)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new RequestError('upstream-error', `API ${response.status}: ${truncate(detail, 400)}`, 502)
  }
  return reply({ status: response.status })
}

/**
 * `POST /api/image2/generate`.
 * @param request - the incoming request.
 * @returns the new entry and the gallery after the insert.
 */
async function handleGenerate(request) {
  const body = await readJson(request)
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') throw new RequestError('empty-prompt', 'A prompt is required.')
  const result = await generateImage({
    prompt,
    size: oneOf(body.size, SIZES),
    quality: oneOf(body.quality, QUALITIES),
    background: oneOf(body.background, BACKGROUNDS),
  })
  return reply(result)
}

/**
 * `GET /api/image2/history`: the saved pictures, newest first.
 * @returns the gallery.
 */
async function handleHistory() {
  return reply(await readHistory())
}

/**
 * `POST /api/image2/history/delete`: forget the entries the page selected.
 * @param request - the incoming request.
 * @returns the gallery after the removal.
 */
async function handleHistoryDelete(request) {
  const body = await readJson(request)
  const ids = Array.isArray(body.ids)
    ? body.ids.filter(id => typeof id === 'string' && id !== '')
    : []
  if (ids.length === 0) {
    throw new RequestError('invalid-request', '`ids` must be a non-empty array of history ids.')
  }
  return reply(await deleteHistoryEntries(ids))
}

/**
 * `GET /api/image2/asset?id=`: stream one saved picture to the page.
 * @param request - the incoming request.
 * @returns the image bytes, or a 404 envelope when the entry or its file is gone.
 */
async function handleAsset(request) {
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (id === '') throw new RequestError('invalid-request', '`id` is required.')
  const history = await readHistory()
  const item = history.items.find(entry => entry.id === id)
  if (item === undefined) throw new RequestError('not-found', 'That picture is no longer in the gallery.', 404)

  let bytes
  try {
    bytes = await readFile(item.file)
  } catch (error) {
    throw new RequestError('not-found', `The file is gone from disk: ${messageOf(error)}`, 404)
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': item.mediaType,
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=300',
    },
  })
}

/**
 * Turn a handler's throw into the envelope the page understands.
 * @param handler - the route handler.
 * @param request - the incoming request.
 * @returns the handler's response, or a failure envelope.
 */
async function guarded(handler, request) {
  try {
    return await handler(request)
  } catch (error) {
    if (error instanceof RequestError) return fault(error.code, error.message, error.status)
    return fault('internal-error', messageOf(error), 500)
  }
}

/**
 * Register one exact Fetch route on Connection's authenticated channel.
 * @param ctx - the plugin context.
 * @param path - absolute path below `/api`.
 * @param methods - the methods this route owns.
 * @param handler - the implementation, wrapped by {@link guarded}.
 */
function route(ctx, path, methods, handler) {
  ctx.effect(() => ctx.connection.fetch.register({
    path,
    methods,
    requestBody: 'buffered',
    fetch: request => guarded(handler, request),
  }), `image2: ${path}`)
}

/** The shape both image tools answer with: one saved file and what it is. */
const IMAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'mediaType', 'bytes'],
  properties: {
    file: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    revisedPrompt: { type: 'string' },
    size: { type: 'string' },
  },
}

/**
 * Where a tool call's file should land.
 *
 * A call that names a directory gets exactly that; otherwise a call made from a
 * workspace writes to `<workspace>/imgout`, so an agent's pictures sit beside the
 * work they belong to; anything else falls back to the saved preference (signalled
 * by returning undefined).
 * @param ctx - the plugin context, for the working-directory service.
 * @param agent - the calling agent, when the runtime supplies one.
 * @param explicit - the call's own `outputDir`, when it named one.
 * @returns the directory to write into, or undefined for the saved preference.
 */
async function toolOutputDirectory(ctx, agent, explicit) {
  const named = typeof explicit === 'string' ? explicit.trim() : ''
  if (named !== '') return expandHome(named)
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined || agent === undefined) return undefined
  try {
    const workspace = await workingDirectory.ensure(agent)
    if (typeof workspace === 'string' && workspace !== '') return join(workspace, WORKSPACE_OUTPUT_DIR)
  } catch {
    // No workspace is reachable from this call; the saved directory is the fallback.
  }
  return undefined
}

/**
 * The agent-facing caller of the same operation the page uses.
 * @param ctx - the plugin context, so a workspace call can find its own directory.
 * @returns a registry-ready tool definition.
 */
function generateTool(ctx) {
  return {
    name: 'image2_generate',
    description: 'Generate one image from a text prompt with the image API configured on the Image studio page '
      + '(endpoint, model, and API key). The picture is saved as a file and its absolute path is returned; '
      + 'this tool never sets or changes credentials. Empty prompt or missing settings fail instead of '
      + 'guessing a replacement.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'What to draw: subject, style, lighting, composition. Non-empty.',
        },
        size: {
          type: 'string',
          enum: [...SIZES],
          description: 'Aspect ratio such as "16:9" or "1:1"; omit to use the saved preference.',
        },
        quality: {
          type: 'string',
          enum: [...QUALITIES],
          description: 'Render quality; omit to use the saved preference.',
        },
        background: {
          type: 'string',
          enum: [...BACKGROUNDS],
          description: 'Background treatment: "transparent" for cut-out art, "opaque" to flatten it, '
            + '"auto" (the default) to let the endpoint decide.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory for the new file; omit to write beside the working directory in imgout.',
        },
      },
    },
    output: {
      schema: IMAGE_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Image saved to ${value.file} (${value.mediaType}, ${value.bytes} bytes).`,
      }],
    },
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('image2_generate: `prompt` must be a non-empty string')
      const outputDir = await toolOutputDirectory(ctx, exec?.agent, args.outputDir)
      const { item } = await generateImage({
        prompt,
        size: oneOf(args.size, SIZES),
        quality: oneOf(args.quality, QUALITIES),
        background: oneOf(args.background, BACKGROUNDS),
        outputDir,
      })
      return {
        file: item.file,
        mediaType: item.mediaType,
        bytes: item.bytes,
        revisedPrompt: item.revisedPrompt,
        size: item.size,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Generate image', kind: 'other', rawInput: args.prompt }),
  }
}

/**
 * The agent-facing picture editor: the same save path, one different endpoint.
 * @param ctx - the plugin context, so a workspace call can find its own directory.
 * @returns a registry-ready tool definition.
 */
function editTool(ctx) {
  return {
    name: 'image2_edit',
    description: 'Edit one existing picture with a text instruction, using the image API configured on the '
      + 'Image studio page. `image` is a path to a local picture (absolute, or relative to the working '
      + 'directory). The answer is written as a NEW file beside the source and the source is left untouched; '
      + 'the new absolute path is returned. An optional `mask` picture marks the region to change. This tool '
      + 'never sets or changes credentials.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'prompt'],
      properties: {
        image: {
          type: 'string',
          description: 'Path to the picture to edit: absolute, or relative to the working directory.',
        },
        prompt: {
          type: 'string',
          description: 'The change to make. Non-empty.',
        },
        mask: {
          type: 'string',
          description: 'Optional path to a mask image whose transparent area is the region to change.',
        },
        size: {
          type: 'string',
          enum: [...SIZES],
          description: 'Aspect ratio of the result; omit to let the endpoint keep the source shape.',
        },
        quality: {
          type: 'string',
          enum: [...QUALITIES],
          description: 'Render quality; omit to use the saved preference.',
        },
        background: {
          type: 'string',
          enum: [...BACKGROUNDS],
          description: 'Background treatment of the result: "transparent" for cut-out art, "opaque" to '
            + 'flatten it, "auto" (the default) to let the endpoint decide.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory for the new file; omit to write beside the working directory in imgout.',
        },
      },
    },
    output: {
      schema: IMAGE_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Edited image saved to ${value.file} (${value.mediaType}, ${value.bytes} bytes).`,
      }],
    },
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      const image = typeof args?.image === 'string' ? args.image.trim() : ''
      if (prompt === '') throw new Error('image2_edit: `prompt` must be a non-empty string')
      if (image === '') throw new Error('image2_edit: `image` must be a non-empty path')
      const baseDir = exec?.agent === undefined
        ? undefined
        : await ctx.get('workingDirectory')?.ensure(exec.agent).catch(() => undefined)
      const outputDir = await toolOutputDirectory(ctx, exec?.agent, args.outputDir)
      const { item } = await editImage({
        imagePath: image,
        baseDir,
        prompt,
        maskPath: typeof args.mask === 'string' ? args.mask : undefined,
        size: oneOf(args.size, SIZES),
        quality: oneOf(args.quality, QUALITIES),
        background: oneOf(args.background, BACKGROUNDS),
        outputDir,
      })
      return {
        file: item.file,
        mediaType: item.mediaType,
        bytes: item.bytes,
        revisedPrompt: item.revisedPrompt,
        size: item.size,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Edit image', kind: 'other', rawInput: args.prompt }),
  }
}

/**
 * Register the settings, probe, gallery, and generation routes, plus both agent
 * tools when a Tool registry is mounted.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  route(ctx, SETTINGS_ROUTE, ['GET', 'POST'], handleSettings)
  route(ctx, TEST_ROUTE, ['POST'], handleTest)
  route(ctx, GENERATE_ROUTE, ['POST'], handleGenerate)
  route(ctx, HISTORY_ROUTE, ['GET'], handleHistory)
  route(ctx, HISTORY_DELETE_ROUTE, ['POST'], handleHistoryDelete)
  route(ctx, ASSET_ROUTE, ['GET'], handleAsset)

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() => tools.register(generateTool(ctx)), 'image2: image2_generate tool')
    ctx.effect(() => tools.register(editTool(ctx)), 'image2: image2_edit tool')
  }
}
