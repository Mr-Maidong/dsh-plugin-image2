/**
 * Throwaway check: loads the client bundle's factory with stub modules and
 * verifies that both dictionaries carry the same keys and that every key the
 * code asks for exists. Run with: node design/check-client.mjs
 */
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let bundle = null
const windowStub = { __ModuleLoader__: { load: definition => { bundle = definition } } }

const React = {
  createElement: () => null,
  useEffect: () => {},
  useState: () => [],
  useRef: () => ({ current: null }),
}

const requireStub = name => {
  if (name === 'react') return React
  if (name === 'react-dom') return { createPortal: node => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button: () => null }
  throw new Error(`unexpected require('${name}')`)
}

const run = new Function('window', source)
run(windowStub)
if (bundle === null) throw new Error('the bundle never called window.__ModuleLoader__.load')
if (bundle.id !== '@local/dsh-plugin-image2') throw new Error(`unexpected bundle id ${bundle.id}`)

const dictionaries = {}
const registered = {}
const ctx = {
  effect: fn => fn(),
  locale: {
    register: (namespace, value) => { dictionaries[namespace] = value },
    bind: namespace => {
      registered.namespace = namespace
      return key => key
    },
  },
  slots: {
    inject: (name, work) => { registered[name] = true; if (typeof work === 'function') work() },
    register: (definition, component) => ({ definition, component }),
  },
}

const exports = bundle.factory(requireStub)
exports.apply(ctx)

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
}

const ns = registered.namespace
check('locale namespace', ns === 'image2.studio', String(ns))
check('main slot registered', registered.main === true)
check('sidebar slot registered', registered['sidebar.panellist'] === true)
check('inject list', JSON.stringify(exports.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(exports.inject))

const { en, zh } = dictionaries[ns] ?? {}
check('english dictionary registered', en !== undefined)
check('chinese dictionary registered', zh !== undefined)

const enKeys = Object.keys(en ?? {})
const zhKeys = Object.keys(zh ?? {})
const missingZh = enKeys.filter(key => !zhKeys.includes(key))
const missingEn = zhKeys.filter(key => !enKeys.includes(key))
check('key parity', missingZh.length === 0 && missingEn.length === 0,
  `only en: ${missingZh.join(',')} | only zh: ${missingEn.join(',')}`)
check('no duplicate-free surprises', new Set(enKeys).size === enKeys.length && new Set(zhKeys).size === zhKeys.length)
check('every english value is non-empty', enKeys.every(key => typeof en[key] === 'string' && en[key].trim() !== ''))
check('every chinese value is non-empty', zhKeys.every(key => typeof zh[key] === 'string' && zh[key].trim() !== ''))

const asked = new Set([...source.matchAll(/t\('([A-Za-z]+)'\)/g)].map(match => match[1]))
const qualityKeys = ['qualityLow', 'qualityMedium', 'qualityHigh', 'qualityAuto']
const errorKeys = [...source.matchAll(/'([a-z-]+)': '(error[A-Za-z]+)'/g)].map(match => match[2])
for (const key of [...qualityKeys, ...errorKeys]) asked.add(key)

const unknown = [...asked].filter(key => !enKeys.includes(key))
check(`every requested key exists (${asked.size} found)`, unknown.length === 0, unknown.join(','))

/**
 * A key is in use when it appears more than twice: once per dictionary and at
 * least once where the code asks for it. Counting literal occurrences also
 * covers keys reached indirectly, such as notice codes and the edit kind.
 * @param key - the dictionary key.
 * @returns how many quoted occurrences the source holds.
 */
const occurrences = key => source.split(`'${key}'`).length - 1
const unused = enKeys.filter(key => occurrences(key) < 3)
check('no unused keys', unused.length === 0, unused.join(','))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
