'use strict'

const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const root = join(__dirname, '..')

test('declares an installable DSH bundle shim', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: 'dsh-desktop-pet\/dsh-plugin'/)

  const plugin = await import(pathToFileURL(join(root, 'dsh-plugin.mjs')))
  assert.equal(plugin.name, 'desktop-pet-companion')
  assert.equal(typeof plugin.apply, 'function')
})
