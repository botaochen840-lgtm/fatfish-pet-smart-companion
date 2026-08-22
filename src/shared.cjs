'use strict'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function linuxDisplayBackend(env = process.env) {
  if (env.DSH_DESKTOP_PET_OZONE === 'x11' || env.DSH_DESKTOP_PET_OZONE === 'wayland') {
    return env.DSH_DESKTOP_PET_OZONE
  }
  // Prefer the session's native backend. Wayland can delegate interactive
  // movement to its compositor; forcing XWayland makes transparent windows
  // invisible on some KDE/KWin configurations.
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) {
    return 'wayland'
  }
  return 'x11'
}

function normalizeDshUrl(value = 'http://127.0.0.1:3080') {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DSH 地址必须使用 HTTP 或 HTTPS')
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error('DSH 地址必须指向本机')
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function endpoint(base, path) {
  return `${normalizeDshUrl(base)}${path}`
}

function validateSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.apiVersion !== 1) return null
  const activity = value.activity
  const pet = value.pet
  if (activity === null || typeof activity !== 'object') return null
  if (pet === null || typeof pet !== 'object') return null
  if (typeof activity.name !== 'string') return null
  return value
}

/** 事件 burst 状态名（Node half 窗口级联输出；welcome/celebrate/error/disappointed）。 */
const BURST_NAMES = ['welcome', 'celebrate', 'error', 'disappointed']

/** 快照→展示状态的映射（burst/回合完成/会话/工作/兜底）。断线或空快照→sleep。 */
function displayState(snapshot, now = Date.now()) {
  if (snapshot === null) return 'sleep'
  const activity = snapshot.activity ?? {}
  if (BURST_NAMES.includes(activity.name) && activity.until > now) return activity.name
  if (activity.turnCompletedUntil > now) return 'celebrate'
  if (activity.sessionWait === true) return 'wait'
  if (activity.sessionThink === true) return 'think'
  if (activity.name === 'working') return 'working'
  return 'idle'
}

// 行为优先级表（与 whale-girl client 的 STATE_TABLE 语义对齐，桌面伴侣口味）：
// 行序即优先级：drag > 放下缓冲 idle > 事件 burst > eat/play/wake > wait
// > 回合/升级 celebrate > working > think > joy > sleep > walk > idle。
// 与 renderer/renderer.js 的 pickState 镜像（renderer 无法 import CommonJS，保持
// 同一张表两份，shared 版由 tests 守护，改动须同步两边）。
/**
 * 完整行为状态选择。
 * @param {object} ctx
 * @param {number} [ctx.now] 当前时刻（测试注入）
 * @param {boolean} [ctx.connected] 是否连接 DSH（非 true→sleep）
 * @param {object} [ctx.activity] snapshot.activity
 * @param {boolean} [ctx.dragging] 拖拽中
 * @param {number} [ctx.dragReleaseUntil] 拖拽放下缓冲截止（此前短暂回 idle）
 * @param {string|null} [ctx.transient] 瞬发态：'eat' | 'play' | 'wake' | null
 * @param {number} [ctx.joyUntil] 互动后喜悦窗口截止
 * @param {number} [ctx.celebrateUntil] 回合完成/升级的本地庆祝窗口截止
 * @param {boolean} [ctx.sleeping] 睡眠中
 * @param {boolean} [ctx.walking] 游走中
 * @returns {string} 展示状态名
 */
function pickDisplayState(ctx) {
  const now = ctx.now ?? Date.now()
  if (ctx.connected !== true) return 'sleep'
  const activity = ctx.activity ?? {}
  if (ctx.dragging === true) return 'drag'
  if ((ctx.dragReleaseUntil ?? 0) > now) return 'idle'
  if (BURST_NAMES.includes(activity.name) && activity.until > now) return activity.name
  if (ctx.transient === 'eat') return 'eat'
  if (ctx.transient === 'play') return 'play'
  if (ctx.transient === 'wake') return 'wake'
  if (activity.sessionWait === true) return 'wait'
  // 回合完成（快照绝对截止时间）与本地升级窗口（ctx.celebrateUntil）取更晚者。
  const celebrateUntil = Math.max(ctx.celebrateUntil ?? 0, activity.turnCompletedUntil ?? 0)
  if (celebrateUntil > now) return 'celebrate'
  if (activity.name === 'working') return 'working'
  if (activity.sessionThink === true) return 'think'
  if ((ctx.joyUntil ?? 0) > now) return 'joy'
  if (ctx.sleeping === true) return 'sleep'
  if (ctx.walking === true) return 'walk'
  return 'idle'
}

/** 睡醒视觉边沿：上一帧 sleep、本帧离开 sleep（非拖拽打断、无瞬发占用）→ 播 wake。 */
function shouldWake(prevState, nextState, ctx = {}) {
  return prevState === 'sleep' && nextState !== 'sleep' && ctx.dragging !== true && (ctx.transient ?? null) === null
}

/** 升级检测：上一观测等级非空且本次更高（levelUp 账本信号的快照等效）。 */
function detectLevelUp(prevLevel, nextLevel) {
  return Number.isFinite(prevLevel) && Number.isFinite(nextLevel) && nextLevel > prevLevel
}

/** 闭区间随机毫秒（随机源可注入，测试确定性）。 */
function randomBetween(min, max, random = Math.random) {
  return min + random() * Math.max(0, max - min)
}

module.exports = { endpoint, normalizeDshUrl, linuxDisplayBackend, validateSnapshot, displayState, pickDisplayState, shouldWake, detectLevelUp, randomBetween }
