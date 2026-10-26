/**
 * Refresh the illustration inlined into `client.js`.
 *
 * The empty state cannot fetch its art: the panel has no route of its own and a
 * data URL keeps the page to a single request. This script rewrites the
 * `ART_EMPTY` constant from `design/empty-dataurl.txt`, so a new drawing only
 * needs a fresh `empty-dataurl.txt` and one run:
 *
 *     node design/inline-art.mjs
 *
 * `empty-dataurl.txt` is the 400px-wide WebP built from `empty.webp`; see the
 * README for how that copy is produced.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const CLIENT = 'client.js'
const ART = 'design/empty-dataurl.txt'
const /** Matches the placeholder and any already-inlined data URL. */
  PATTERN = /const ART_EMPTY = ['"]__EMPTY_DATA_URL__['"]|const ART_EMPTY = "data:[^"]*"/

const url = readFileSync(ART, 'utf8').trim()
if (!url.startsWith('data:image/')) throw new Error(`${ART} does not hold a data URL`)

const source = readFileSync(CLIENT, 'utf8')
if (!PATTERN.test(source)) throw new Error(`${CLIENT} has no ART_EMPTY constant to replace`)

const next = source.replace(PATTERN, () => `const ART_EMPTY = ${JSON.stringify(url)}`)
writeFileSync(CLIENT, next)
console.log(`inlined ${url.length} characters of art into ${CLIENT}`)
