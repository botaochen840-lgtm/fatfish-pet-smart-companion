'use strict'

const pet = document.querySelector('#pet')
const stage = document.querySelector('#stage')
const sprite = document.querySelector('#sprite')
const status = document.querySelector('#status')
const detail = document.querySelector('#detail')
const note = document.querySelector('#note')
const bubble = document.querySelector('#bubble')
const actions = document.querySelector('#actions')

const STATE_LABELS = {
  idle: '空闲', working: '正在使用工具', celebrate: '任务完成', error: '请求失败',
  disappointed: '休息一下', think: '正在深入思考', wait: '等待你的批准',
  welcome: '新会话', sleep: '等待 DSH', eat: '进食中', play: '玩耍中',
  joy: '开心', drag: '拖动中', wake: '刚睡醒', walk: '散步中',
}

const BURST_NAMES = ['welcome', 'celebrate', 'error', 'disappointed']

// 工作汇报气泡文案（状态进入边沿触发一次；仅工作相关，无闲聊）。
const REPORT_LABELS = {
  working: '报告！正在使用工具干活中',
  think: '报告！正在深入思考',
  wait: '报告！等你批准',
  celebrate: '报告！任务完成',
  error: '报告！请求失败，正在重试',
  disappointed: '让我缓一缓',
}
const TICK_MS = 50
const TRANSIENT_MS = 1500 // eat/play 瞬发时长（与 whale-girl client 一致）
const WAKE_MS = 3000      // wake 过渡时长
const JOY_MS = 1600       // 互动后喜悦时长
const DRAG_RELEASE_MS = 1500 // 拖拽放下缓冲

// 体验层默认值（与 whale-girl /whale-girl/config 的 DEFAULTS 数值一致；size 用
// manifest meta.stageSize 兜底，null 表示未配置）。消费 /config 后整体替换。
const CFG_DEFAULTS = {
  enabled: true, size: null, opacity: 1, bubbleMs: 2500, sleepAfterMs: 60000,
  walk: { enabled: true, minWaitMs: 18000, maxWaitMs: 40000, minMs: 3000, maxMs: 6000, speedPxPerSec: 45 },
}

let manifest = null
let character = null
let assetsUrl = ''
let snapshot = null
let connected = false
let simulated = false // 内置模拟模式（连不上 DSH 时的离线兜底）
let currentState = 'sleep'
let frame = 0
let frameTimer = null
let bubbleTimer = null
let dragging = false
let dragMoved = false
let pointerOrigin = null
let cfg = { ...CFG_DEFAULTS, walk: { ...CFG_DEFAULTS.walk } }
let lastConfigRevision = 0
let stageSize = 128
// 行为运行时（与 shared.cjs 的纯决策 + whale-girl client 语义对齐）
let sleeping = false
let idleSince = 0
let transient = null // 'eat' | 'play' | 'wake' | null
let transientUntil = 0
let joyUntil = 0
let dragReleaseUntil = 0
let userScale = 1 // 用户滚轮缩放（主进程持久化）
let walking = false
let walkDir = 1
let walkAt = 0
let walkUntil = 0 // performance.now() 时钟（rAF 帧时刻）
let walkRaf = null
let lastWalkFrame = 0
let tickTimer = null
let blinkAt = 0 // 常态帧 0 静止，随机间隔眨眼（对齐网页端 nextBlinkAt 节奏）
let blinkActive = false
let flip = 1 // 素材朝左基准：1=朝左，-1=镜像朝右（对齐网页端 flip；动作间保持连续）
let facingAt = 0 // 静态陪伴态（idle/think/wait）下次随机转身时刻（对齐网页端 nextFacingAt）
let lastPointerX = 0 // 拖拽方向朝向（对比上一指针位置）

function randomBetween(min, max) {
  return min + Math.random() * Math.max(0, max - min)
}

// 桌面端展示尺寸：素材帧 256px 取整数倍缩放（128=2x 最清晰，非整数倍发虚）；
// 夹取 128–160——config.size 默认 110 是给网页端小尺寸的，桌面窗口里太小像贴纸。
function desktopStage(size) {
  return Math.min(160, Math.max(128, size))
}

// 行为优先级表：与 shared.cjs pickDisplayState 镜像（renderer 无法 import CommonJS，
// 同一张表两份，shared 版由 tests 守护——改动须同步两边）。
// 行序即优先级：drag > 放下缓冲 idle > 事件 burst > eat/play/wake > wait
// > 回合/升级 celebrate > working > think > joy > sleep > walk > idle。
function pickState(now = Date.now()) {
  if (!connected) return 'sleep'
  const activity = snapshot?.activity ?? {}
  if (dragging) return 'drag'
  if (dragReleaseUntil > now) return 'idle'
  if (BURST_NAMES.includes(activity.name) && activity.until > now) return activity.name
  if (transient === 'eat') return 'eat'
  if (transient === 'play') return 'play'
  if (transient === 'wake') return 'wake'
  if (activity.sessionWait === true) return 'wait'
  const celebrateUntil = activity.turnCompletedUntil ?? 0
  if (celebrateUntil > now) return 'celebrate'
  if (activity.name === 'working') return 'working'
  if (activity.sessionThink === true) return 'think'
  if (joyUntil > now) return 'joy'
  if (sleeping) return 'sleep'
  if (walking) return 'walk'
  return 'idle'
}

function renderFrame(stateConfig) {
  const frames = Math.max(1, stateConfig.frames ?? 1)
  // stage 与 sprite 同步尺寸（stage 承载位移动画，sprite 承载帧图与翻转）
  stage.style.width = `${stageSize}px`
  stage.style.height = `${stageSize}px`
  sprite.style.width = `${stageSize}px`
  sprite.style.height = `${stageSize}px`
  sprite.style.backgroundSize = `${stageSize * frames}px ${stageSize}px`
  sprite.style.backgroundPosition = `${-frame * stageSize}px 0`
}

function animate(stateConfig) {
  clearInterval(frameTimer)
  frame = 0
  renderFrame(stateConfig)
  const frames = Math.max(1, stateConfig.frames ?? 1)
  if (frames === 1) return
  let direction = 1
  blinkAt = 0
  blinkActive = false
  frameTimer = setInterval(() => {
    if (stateConfig.playback === 'pingpong') {
      frame += direction
      if (frame >= frames - 1 || frame <= 0) direction *= -1
    } else if (stateConfig.playback === 'once') {
      frame = Math.min(frames - 1, frame + 1)
    } else if (stateConfig.playback === 'blink') {
      // 常态帧 0 静止，随机间隔（3-9s）眨一次眼（0→1→…→N-1→0）——对齐网页端，
      // 不再每个 tick 随机跳帧（旧版每 500ms 乱跳像抽搐）。
      if (blinkActive) {
        frame += 1
        if (frame >= frames) {
          frame = 0
          blinkActive = false
          blinkAt = Date.now() + 3000 + Math.random() * 6000
        }
      } else {
        if (frame !== 0) frame = 0
        if (blinkAt === 0) blinkAt = Date.now() + 3000 + Math.random() * 6000
        if (Date.now() >= blinkAt) blinkActive = true
      }
    } else {
      frame = (frame + 1) % frames
    }
    renderFrame(stateConfig)
  }, Math.max(80, 1000 / Math.max(1, stateConfig.fps ?? 2)))
}

// 状态卡：余额上一行显示实时任务数（大白饭梗），下一行显示准确余额。
// 有任务在跑 → 「正在吃 N 碗大白饭」；没有 → 「已吃完 N 碗」（累计完成数）。
function renderStatus() {
  if (!connected || snapshot === null) {
    detail.textContent = ''
    note.textContent = ''
    note.hidden = true
    return
  }
  const activity = snapshot?.activity ?? {}
  const running = typeof activity.runningCount === 'number' ? activity.runningCount : 0
  // 正在干活的会话数（服务端 sessionThinkCount）；旧服务端无此字段时退回布尔判断（≥1）。
  const thinkingSessions = typeof activity.sessionThinkCount === 'number'
    ? activity.sessionThinkCount
    : (activity.sessionThink === true ? 1 : 0)
  const done = typeof snapshot?.pet?.stats?.tasksDone === 'number' ? snapshot.pet.stats.tasksDone : 0
  // 「正在吃」= 有后台任务在跑，或会话正在干活（思考/等批准/使用工具）。
  // 碗数 = 后台任务数与干活会话数取大：几个会话同时干活就吃几碗。
  const workingNow = activity.name === 'working' || activity.sessionThink === true || activity.sessionWait === true
  const eating = running > 0 || workingNow
  status.textContent = eating ? `正在吃 ${Math.max(running, thinkingSessions, 1)} 碗大白饭` : `已吃完 ${done} 碗`
  const bal = snapshot?.balance
  // 模拟模式（未连 DSH）：保持与真实空闲一致的观感，不显示余额、不打「演示模式」字样。
  detail.textContent = simulated || (bal === null || typeof bal !== 'object' || bal.isAvailable !== true || typeof bal.total !== 'string')
    ? ''
    : `余额 ¥${bal.total}`
  note.textContent = ''
  note.hidden = true
}

function applyState(next) {
  const prev = currentState
  if (character !== null && (next !== currentState || sprite.style.backgroundImage === '')) {
    const config = character.states[next] ?? character.states.idle
    currentState = next
    pet.dataset.state = next
    pet.dataset.motion = config.motion ?? ''
    sprite.style.backgroundImage = `url("${assetsUrl}/${config.sheet}")`
    animate(config)
  }
  // 状态边沿汇报：进入工作/思考/等待/庆祝/错误/失落时气泡汇报一次。
  if (next !== prev && Object.prototype.hasOwnProperty.call(REPORT_LABELS, next)) showBubble(REPORT_LABELS[next])
  status.textContent = STATE_LABELS[next] ?? next
  renderStatus()
  pet.dataset.attention = String(['wait', 'error'].includes(next))
}

function render() { applyState(pickState()) }

function showBubble(text) {
  bubble.textContent = text
  bubble.hidden = false
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => { bubble.hidden = true }, cfg.bubbleMs ?? 2500)
}

// ---- 行为运行时 ----

function resetTransient(now) {
  const wasFun = transient === 'eat' || transient === 'play'
  transient = null
  transientUntil = 0
  if (wasFun) joyUntil = now + JOY_MS
}

// 用户在场信号（拖拽放下/喂食/玩耍）：重置空闲计时，正睡着则播 wake 醒觉过渡
// （eat/play 瞬发会覆盖 wake——与 whale-girl client 一致）。
function releaseInteraction() {
  const wasSleeping = sleeping
  sleeping = false
  idleSince = 0
  if (wasSleeping) {
    transient = 'wake'
    transientUntil = Date.now() + WAKE_MS
  }
}

// 睡眠计时（与 whale-girl client 一致）：从「进入 idle 的时刻」起算持续空闲，
// 事件活动（burst/工作）重置；think/wait 是会话陪伴（优先级盖过 sleep，睡眠标志保留）。
function updateIdle(now) {
  const activity = snapshot?.activity ?? {}
  const isActive = activity.name !== 'idle' || (activity.until ?? 0) > now
  if (isActive) idleSince = 0
  else if (idleSince === 0) idleSince = now
  sleeping = connected && activity.name === 'idle' && idleSince !== 0 && now - idleSince > (cfg.sleepAfterMs ?? 60000)
}

// 朝向刷新：flip 是共享朝向（1=朝左 / -1=朝右），walk/drag/静态转身都写它，
// 动作间保持连续（对齐网页端 flip 语义）。
function applyFacing() {
  sprite.style.transform = `scaleX(${flip})`
}

// 静态陪伴态（idle/think/wait）偶尔随机转身（10–25s，对齐网页端 nextFacingAt）；
// 离开静态态时清排程，下次重进重新随机——不转身的态不误触发旧时刻。
function updateFacing(now) {
  if (currentState === 'idle' || currentState === 'think' || currentState === 'wait') {
    if (facingAt === 0) facingAt = now + 10000 + Math.random() * 15000
    if (now >= facingAt) {
      flip = -flip
      applyFacing()
      facingAt = now + 10000 + Math.random() * 15000
    }
  } else if (facingAt !== 0) {
    facingAt = 0
  }
}

function stopWalk() {
  walking = false
  walkAt = 0
  // 不重置 flip：朝向连续（walk 停止后保持最后朝向，静态态随机转身再改写）
  if (walkRaf !== null) { cancelAnimationFrame(walkRaf); walkRaf = null }
}

function startWalk() {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  walking = true
  walkDir = Math.random() < 0.5 ? 1 : -1
  // 素材统一朝左基准：向右走（walkDir=1）→ 镜像朝右（flip=-1）
  flip = -walkDir
  walkUntil = performance.now() + randomBetween(w.minMs, w.maxMs)
  applyFacing()
  lastWalkFrame = performance.now()
  walkRaf = requestAnimationFrame(walkStep)
}

// 游走：沿屏幕底部水平移动窗口（宠物随窗口走）；顶到工作区边缘由主进程返回
// moved:false，翻转方向。
function walkStep(t) {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  const activity = snapshot?.activity ?? {}
  // 会话活跃（think/wait 陪伴）或睡着/交互/瞬发 → 停走（与网页端一致：
  // 否则窗口在动、动画却停在 think/wait——走路动画不触发）
  if (!walking || sleeping || dragging || transient !== null
    || activity.sessionThink === true || activity.sessionWait === true || t >= walkUntil) {
    stopWalk()
    return
  }
  const dt = Math.min(0.1, Math.max(0, (t - lastWalkFrame) / 1000))
  lastWalkFrame = t
  const dx = walkDir * (w.speedPxPerSec ?? 45) * dt
  window.desktopPet.walkMove(dx).then(result => {
    if (!walking) return
    if (result?.unavailable === true) {
      stopWalk()
      return
    }
    if (result !== null && typeof result === 'object' && result.moved === false) {
      walkDir = -walkDir
      flip = -flip
      applyFacing()
    }
    walkRaf = requestAnimationFrame(walkStep)
  }).catch(() => stopWalk())
}

// 只在纯 idle 时排程游走（think/wait 是会话陪伴态，网页端同样不游走；
// 游走开始后 pickState 的 walk 行才能命中——否则窗口在动却显示陪伴动画）。
function scheduleWalk(now) {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  if (!w.enabled || !connected) return
  if (currentState !== 'idle') return
  if (sleeping || dragging || transient !== null || walking) return
  if (walkAt === 0) walkAt = now + randomBetween(w.minWaitMs, w.maxWaitMs)
  if (now >= walkAt) startWalk()
}

function tick() {
  const now = Date.now()
  if (transient !== null && now >= transientUntil) resetTransient(now)
  updateIdle(now)
  // 自动散步已停用（固定位置，不自行移动——避免用户误解"活动范围在变小"）
  let next = pickState(now)
  // 睡醒视觉边沿：上一帧 sleep、本帧离开 sleep（非拖拽、无瞬发占用）→ 播 wake。
  if (currentState === 'sleep' && next !== 'sleep' && !dragging && transient === null) {
    transient = 'wake'
    transientUntil = now + WAKE_MS
    next = pickState(now)
  }
  applyState(next)
  updateFacing(now)
}

// ---- 配置（/whale-girl/config + configRevision 门控）----

async function fetchConfig() {
  try {
    const body = await window.desktopPet.config()
    return (body !== null && typeof body === 'object') ? body.config : null
  } catch {
    return null
  }
}

function applyConfig(config) {
  if (config === null || typeof config !== 'object') return
  cfg = {
    ...CFG_DEFAULTS,
    ...config,
    walk: { ...CFG_DEFAULTS.walk, ...(config.walk !== null && typeof config.walk === 'object' ? config.walk : {}) },
  }
  if (typeof config.size === 'number') stageSize = desktopStage(config.size)
  else if (character !== null) stageSize = desktopStage(character.meta?.stageSize ?? 128)
  if (typeof config.opacity === 'number') pet.style.opacity = String(config.opacity)
  // 尺寸变化 → 以新尺寸重排当前帧（不动动画状态）。
  if (character !== null && sprite.style.backgroundImage !== '') {
    renderFrame(character.states[currentState] ?? character.states.idle)
  }
}

function applyConfigIfRevisionChanged() {
  const rev = snapshot?.configRevision
  if (typeof rev === 'number' && rev !== lastConfigRevision) {
    lastConfigRevision = rev
    fetchConfig().then(config => { if (config !== null) applyConfig(config) })
  }
}

// ---- 互动 ----

async function interact(action) {
  stopWalk()
  releaseInteraction()
  transient = action === 'feed' ? 'eat' : 'play'
  transientUntil = Date.now() + TRANSIENT_MS
  render()
  // 离线（内置模拟模式）本地反馈，不依赖 whale-girl 的 reply。
  if (!connected) {
    showBubble(action === 'feed' ? '啊呜——好好吃！' : '嘿嘿，玩得好开心～')
    return
  }
  try {
    const result = await window.desktopPet.interact(action)
    if (typeof result.reply === 'string') showBubble(result.reply)
  } catch (error) {
    showBubble(error.message)
  }
}

actions.addEventListener('click', event => {
  if (event.target.closest('button')?.dataset.action === 'quit') window.desktopPet.quit()
})

sprite.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  stopWalk()
  dragging = true
  dragMoved = false
  pointerOrigin = { x: event.screenX, y: event.screenY }
  lastPointerX = event.screenX
  pet.dataset.dragging = 'true'
  sprite.setPointerCapture(event.pointerId)
  window.desktopPet.dragStart({ x: event.screenX, y: event.screenY })
  event.preventDefault()
  render()
})

sprite.addEventListener('pointermove', event => {
  if (!dragging) return
  if (!dragMoved && Math.hypot(event.screenX - pointerOrigin.x, event.screenY - pointerOrigin.y) < 5) return
  dragMoved = true
  // 拖拽方向 → 朝向（对齐网页端：向左拖朝左 flip=1，向右拖朝右 flip=-1）
  const nextFlip = event.screenX < lastPointerX ? 1 : -1
  if (nextFlip !== flip) {
    flip = nextFlip
    applyFacing()
  }
  lastPointerX = event.screenX
  window.desktopPet.dragMove({ x: event.screenX, y: event.screenY })
})

const finishDrag = event => {
  if (!dragging) return
  const wasMoved = dragMoved
  dragging = false
  pet.dataset.dragging = 'false'
  pointerOrigin = null
  if (sprite.hasPointerCapture(event.pointerId)) sprite.releasePointerCapture(event.pointerId)
  window.desktopPet.dragEnd()
  // 拖拽结束：光标已出窗口 → 恢复穿透；仍在窗口内 → 保持可交互，等自然 mouseout。
  if (event.type === 'pointerup'
    && (event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight)) {
    updateClickThrough(true)
  }
  if (wasMoved) {
    dragReleaseUntil = Date.now() + DRAG_RELEASE_MS // 放下缓冲：短暂回 idle 再进底层状态
    releaseInteraction()
    render()
    return
  }
  if (event.type !== 'pointerup') { render(); return }
  // 单击喂食（双击调起网页端已移除）。
  interact('feed')
  render()
}
sprite.addEventListener('pointerup', finishDrag)
sprite.addEventListener('pointercancel', finishDrag)
sprite.addEventListener('contextmenu', event => {
  event.preventDefault()
  interact('play')
})

// 滚轮调整大小（0.6x–2x，步进 0.1）：主进程同步窗口尺寸并记忆。
// 拖动中忽略滚轮——否则拖动时滚轮微动会让宠物越拖越大、活动范围越来越小。
sprite.addEventListener('wheel', event => {
  event.preventDefault()
  if (dragging) return
  const next = Math.min(2, Math.max(0.6, Math.round((userScale + (event.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10))
  if (next === userScale) return
  userScale = next
  window.desktopPet.resize(userScale).then(() => {
    document.body.style.zoom = String(userScale)
  }).catch(() => {})
}, { passive: false })

// ---- 透明点击穿透（经典方案）----
// 窗口透明但比宠物大：光标不在宠物窗口上时，点击穿透到桌面（不挡鼠标）；
// 光标进入窗口 → 恢复可交互（可拖拽/喂食/双击/退出）。
let clickThrough = true
function updateClickThrough(next) {
  if (next === clickThrough) return
  clickThrough = next
  window.desktopPet.setClickThrough(next)
}
window.addEventListener('mouseover', () => updateClickThrough(false))
window.addEventListener('mouseout', () => {
  if (dragging) return // 拖拽中不穿透：光标略快于窗口会触发 mouseout，穿透会中断拖拽
  updateClickThrough(true)
})
updateClickThrough(true) // 初始即穿透：宠物不挡任何鼠标

window.desktopPet.onSnapshot(value => {
  snapshot = value
  applyConfigIfRevisionChanged()
  render()
})
window.desktopPet.onConnection(value => {
  connected = value.connected === true
  simulated = value.simulated === true
  if (connected && character === null) loadCharacter().catch(showAssetError)
  render()
})

async function loadCharacter() {
  manifest = await window.desktopPet.manifest()
  if (manifest === null) throw new Error('DSH 尚未启动')
  character = manifest.characters?.[manifest.default]
  if (!character?.states) throw new Error('鲸鱼娘资源清单无效')
  if (typeof cfg.size !== 'number') stageSize = desktopStage(character.meta?.stageSize ?? 128)
  render()
}

function showAssetError(error) {
  status.textContent = '鲸鱼娘暂时不可用'
  detail.textContent = error.message
  note.textContent = ''
  note.hidden = true
  pet.dataset.attention = 'true'
}

async function start() {
  const bootstrap = await window.desktopPet.bootstrap()
  assetsUrl = bootstrap.assetsUrl
  if (typeof bootstrap.scale === 'number') {
    userScale = Math.min(2, Math.max(0.6, bootstrap.scale))
    document.body.style.zoom = String(userScale)
  }
  try {
    const body = await window.desktopPet.config()
    if (body !== null && typeof body === 'object' && body.config) applyConfig(body.config)
  } catch {}
  try { await loadCharacter() } catch {}
  try { snapshot = await window.desktopPet.refresh() } catch {}
  tickTimer = setInterval(tick, TICK_MS)
  render()
}

start().catch(showAssetError)
