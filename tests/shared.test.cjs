'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { endpoint, normalizeDshUrl, linuxDisplayBackend, validateSnapshot, displayState, pickDisplayState, shouldWake, detectLevelUp, randomBetween } = require('../src/shared.cjs')

const snapshot = activity => ({ apiVersion: 1, pet: { level: 1 }, activity })

const base = { now: 1000, connected: true, activity: { name: 'idle' }, transient: null }

test('accepts loopback DSH URLs and rejects remote hosts', () => {
  assert.equal(normalizeDshUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080')
  assert.equal(endpoint('http://localhost:3080', '/whale-girl/state'), 'http://localhost:3080/whale-girl/state')
  assert.throws(() => normalizeDshUrl('https://example.com'), /本机/)
  assert.throws(() => normalizeDshUrl('file:///tmp/dsh'), /HTTP/)
})

test('selects a Linux display backend that preserves desktop movement', () => {
  assert.equal(linuxDisplayBackend({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), 'wayland')
  assert.equal(linuxDisplayBackend({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }), 'wayland')
  assert.equal(linuxDisplayBackend({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), 'x11')
  assert.equal(linuxDisplayBackend({ DSH_DESKTOP_PET_OZONE: 'wayland', DISPLAY: ':0' }), 'wayland')
  assert.equal(linuxDisplayBackend({ DSH_DESKTOP_PET_OZONE: 'x11' }), 'x11')
})

test('validates whale-girl snapshot API version and required surfaces', () => {
  assert.deepEqual(validateSnapshot(snapshot({ name: 'idle' })), snapshot({ name: 'idle' }))
  assert.equal(validateSnapshot({ apiVersion: 2, pet: {}, activity: { name: 'idle' } }), null)
  assert.equal(validateSnapshot({ apiVersion: 1, pet: {}, activity: {} }), null)
})

test('maps aggregate state with attention states taking priority', () => {
  assert.equal(displayState(null, 1000), 'sleep')
  assert.equal(displayState(snapshot({ name: 'idle', sessionThink: true }), 1000), 'think')
  assert.equal(displayState(snapshot({ name: 'idle', sessionThink: true, sessionWait: true }), 1000), 'wait')
  assert.equal(displayState(snapshot({ name: 'idle', turnCompletedUntil: 2000 }), 1000), 'celebrate')
  assert.equal(displayState(snapshot({ name: 'error', until: 2000 }), 1000), 'error')
  assert.equal(displayState(snapshot({ name: 'error', until: 500 }), 1000), 'idle')
})

test('pickDisplayState: disconnected or no activity falls back to sleep', () => {
  assert.equal(pickDisplayState({ ...base, connected: false }), 'sleep')
  assert.equal(pickDisplayState({ ...base, activity: undefined }), 'idle')
})

test('pickDisplayState: drag and drag-release buffer outrank event bursts', () => {
  const burst = { name: 'celebrate', until: 2000 }
  assert.equal(pickDisplayState({ ...base, dragging: true, activity: burst }), 'drag')
  assert.equal(pickDisplayState({ ...base, dragReleaseUntil: 1500, activity: burst }), 'idle')
})

test('pickDisplayState: event bursts outrank eat/play/wake transients', () => {
  const burst = { name: 'celebrate', until: 2000 }
  assert.equal(pickDisplayState({ ...base, transient: 'eat', activity: burst }), 'celebrate')
  assert.equal(pickDisplayState({ ...base, transient: 'play', activity: burst }), 'celebrate')
  assert.equal(pickDisplayState({ ...base, transient: 'wake', activity: burst }), 'celebrate')
})

test('pickDisplayState: transients outrank session signals and round celebration', () => {
  const think = { name: 'idle', sessionThink: true, turnCompletedUntil: 5000 }
  assert.equal(pickDisplayState({ ...base, transient: 'eat', activity: think }), 'eat')
  assert.equal(pickDisplayState({ ...base, transient: 'play', activity: think }), 'play')
  assert.equal(pickDisplayState({ ...base, transient: 'wake', activity: think }), 'wake')
})

test('pickDisplayState: burst outranks round-completion and session signals', () => {
  assert.equal(pickDisplayState({ ...base, activity: { name: 'error', until: 2000 } }), 'error')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'celebrate', until: 2000 }, celebrateUntil: 99999 }), 'celebrate')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'welcome', until: 2000, sessionThink: true } }), 'welcome')
})

test('pickDisplayState: session and celebration priority order', () => {
  assert.equal(pickDisplayState({ ...base, activity: { name: 'idle', sessionWait: true, turnCompletedUntil: 5000 } }), 'wait')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'idle', turnCompletedUntil: 5000 } }), 'celebrate')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'working' }, celebrateUntil: 2000 }), 'celebrate')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'working' } }), 'working')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'idle', sessionThink: true }, celebrateUntil: 2000 }), 'celebrate')
  assert.equal(pickDisplayState({ ...base, activity: { name: 'idle', sessionThink: true } }), 'think')
})

test('pickDisplayState: joy/sleep/walk/idle bottom layers', () => {
  assert.equal(pickDisplayState({ ...base, joyUntil: 1500, activity: { name: 'idle', sessionThink: true } }), 'think')
  assert.equal(pickDisplayState({ ...base, joyUntil: 1500 }), 'joy')
  assert.equal(pickDisplayState({ ...base, sleeping: true, joyUntil: 1500 }), 'joy')
  assert.equal(pickDisplayState({ ...base, sleeping: true }), 'sleep')
  assert.equal(pickDisplayState({ ...base, walking: true, sleeping: true }), 'sleep')
  assert.equal(pickDisplayState({ ...base, walking: true }), 'walk')
  assert.equal(pickDisplayState(base), 'idle')
  assert.equal(pickDisplayState({ ...base, celebrateUntil: 1000 }), 'idle')
})

test('shouldWake triggers on visual sleep leave, not on drag/transient', () => {
  assert.equal(shouldWake('sleep', 'think', {}), true)
  assert.equal(shouldWake('sleep', 'sleep', {}), false)
  assert.equal(shouldWake('think', 'idle', {}), false)
  assert.equal(shouldWake('sleep', 'think', { dragging: true }), false)
  assert.equal(shouldWake('sleep', 'think', { transient: 'eat' }), false)
})

test('detectLevelUp requires numeric level increase from an observed baseline', () => {
  assert.equal(detectLevelUp(1, 2), true)
  assert.equal(detectLevelUp(2, 1), false)
  assert.equal(detectLevelUp(1, 1), false)
  assert.equal(detectLevelUp(null, 2), false)
  assert.equal(detectLevelUp(undefined, 2), false)
  assert.equal(detectLevelUp(1, undefined), false)
})

test('randomBetween stays within bounds and honors injected randomness', () => {
  assert.equal(randomBetween(100, 200, () => 0), 100)
  assert.equal(randomBetween(100, 200, () => 1), 200)
  assert.equal(randomBetween(100, 100, () => 0.5), 100)
})
