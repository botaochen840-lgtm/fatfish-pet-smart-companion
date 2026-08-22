'use strict'

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron')
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { endpoint, normalizeDshUrl, linuxDisplayBackend, validateSnapshot } = require('./shared.cjs')

const WINDOW_WIDTH = 210
const WINDOW_HEIGHT = 225
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15000
// 桌面伴侣在场心跳（与 whale-girl src/presence.mjs 的 TTL/间隔契约一致）：
// 在线期间 whale-girl 隐藏网页端宠物（避免双大肥鱼），退出/崩溃后心跳过期自动恢复。
const PRESENCE_TTL_MS = 45000
const PRESENCE_INTERVAL_MS = 15000

const displayBackend = process.platform === 'linux' ? linuxDisplayBackend() : null

if (displayBackend !== null) {
  app.commandLine.appendSwitch('ozone-platform', displayBackend)
  // Transparent, always-on-top Electron windows hit unstable GPU paths on
  // several Mesa/NVIDIA + compositor combinations. This UI is a small sprite
  // surface, so software compositing is both sufficient and more portable.
  app.disableHardwareAcceleration()
}

// Windows: 透明窗口在 GPU 路径下会渲染成实色底（宠物身后出现矩形色块），
// 必须软件合成才真正透明。窗口很小（~280px），软件合成开销可忽略。
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
}

// 单实例锁：双开时第二个实例直接退出并把已有窗口带到前台
// （防止双大肥鱼叠加——两份透明窗 + 双轮询会明显拖慢系统）。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.showInactive()
    }
  })
}

function cliValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

let dshUrl
try {
  dshUrl = normalizeDshUrl(cliValue('--dsh-url') ?? process.env.DSH_URL)
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

let mainWindow = null
let tray = null
let stopped = false
let retryMs = RETRY_MIN_MS
let streamAbort = null
let dragOrigin = null
let stateSaveTimer = null
let presenceTimer = null
let refreshTimer = null
// 用户缩放（0.6x–2x，滚轮/托盘调整）：窗口尺寸 = WINDOW_WIDTH×userScale
let userScale = 1

function expectedSize() {
  return { w: Math.round(WINDOW_WIDTH * userScale), h: Math.round(WINDOW_HEIGHT * userScale) }
}

function stateFile() {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState() {
  try {
    const value = JSON.parse(readFileSync(stateFile(), 'utf8'))
    const scale = Number.isFinite(value.scale) ? Math.min(2, Math.max(0.6, value.scale)) : 1
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: value.x, y: value.y, scale }
    return { scale }
  } catch {}
  return { scale: 1 }
}

function saveWindowState() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const [x, y] = mainWindow.getPosition()
  try { writeFileSync(stateFile(), JSON.stringify({ x, y, scale: userScale })) } catch {}
}

function createWindow() {
  const capturePath = cliValue('--capture')
  const savedPosition = loadWindowState()
  // 缩放钳制 0.6–2（旧版本曾把超大 scale 写进状态导致窗口巨大——加载时钳制一劳永逸）
  userScale = Math.min(2, Math.max(0.6, savedPosition.scale ?? 1))
  const { w: winW, h: winH } = expectedSize()
  const workArea = screen.getPrimaryDisplay().workArea
  // 位置校验：保存的坐标必须落在任一已连接显示器的边界内（允许窗口部分越界），
  // 否则回退默认右下角——多显示器变更后旧坐标会变负值，宠物会开在屏幕外看不见。
  const onScreen = Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)
    && screen.getAllDisplays().some(display => {
      const b = display.bounds
      return savedPosition.x >= b.x - WINDOW_WIDTH && savedPosition.x <= b.x + b.width
        && savedPosition.y >= b.y - WINDOW_HEIGHT && savedPosition.y <= b.y + b.height
    })
  const position = onScreen
    ? { x: savedPosition.x, y: savedPosition.y }
    : {
        x: workArea.x + workArea.width - winW - 24,
        y: workArea.y + workArea.height - winH - 24,
      }
  // 透明窗口：桌面上只显示宠物本体 + 状态信息卡，没有大卡片背景。
  mainWindow = new BrowserWindow({
    ...position,
    width: winW,
    height: winH,
    transparent: true,
    frame: false,
    type: process.platform === 'linux' ? 'toolbar' : undefined,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (process.platform === 'darwin') mainWindow.setAlwaysOnTop(true, 'floating')
  else mainWindow.setAlwaysOnTop(true)
  mainWindow.setVisibleOnAllWorkspaces(true)
  mainWindow.on('show', () => mainWindow?.setAlwaysOnTop(true))
  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'))
  if (capturePath !== undefined) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage()
        writeFileSync(capturePath, image.toPNG())
        app.quit()
      }, 2000)
    })
    return
  }
  // --drag-test：自检模式——模拟真实鼠标拖拽（精灵区按下→分步移动→松开），
  // 覆盖屏幕四角+中央，每步记录窗口位置与尺寸：验证可拖满全屏、拖后不变大。
  if (process.argv.includes('--drag-test')) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // 日志写到 userData（asar 内只读，不能写 E:\dsh-desktop-pet 的相对路径）
        const logFile = join(app.getPath('userData'), 'drag-test.log')
        const log = (...a) => appendFileSync(logFile, a.join(' ') + '\n')
        writeFileSync(logFile, 'drag-test start ' + new Date().toISOString() + '\n')
        // 看门狗：60s 未完成则记录并退出（防止沙箱内异常挂起）
        const watchdog = setTimeout(() => { appendFileSync(logFile, 'WATCHDOG fired\n'); app.exit(0) }, 60000)
        const wc = mainWindow.webContents
        const [ww, wh] = mainWindow.getSize()
        const sx = Math.round(ww - 95) // 精灵中心（窗口右下）
        const sy = Math.round(wh - 78)
        const b = screen.getPrimaryDisplay().bounds
        const targets = [
          [b.x + 60, b.y + 60],
          [b.x + b.width - ww - 60, b.y + b.height - wh - 60],
          [b.x + Math.round((b.width - ww) / 2), b.y + Math.round((b.height - wh) / 2)],
          [b.x + 60, b.y + b.height - wh - 60],
          [b.x + b.width - ww - 60, b.y + 60],
        ]
        for (let i = 0; i < targets.length; i++) {
          const [tx, ty] = targets[i]
          let [wx, wy] = mainWindow.getPosition()
          log('T' + i, 'START pos', wx, wy, 'size', ...mainWindow.getSize())
          wc.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 })
          await new Promise(r => setTimeout(r, 80))
          const steps = 10
          for (let s = 1; s <= steps; s++) {
            const vx = Math.round(sx + ((tx - wx) * s) / steps)
            const vy = Math.round(sy + ((ty - wy) * s) / steps)
            wc.sendInputEvent({ type: 'mouseMove', x: vx, y: vy })
            await new Promise(r => setTimeout(r, 60))
            ;[wx, wy] = mainWindow.getPosition()
            if (s === steps) log('T' + i, 'mid', 'pos', wx, wy, 'size', ...mainWindow.getSize())
          }
          wc.sendInputEvent({ type: 'mouseUp', x: 0, y: 0, button: 'left', clickCount: 1 })
          await new Promise(r => setTimeout(r, 250))
          const [ax, ay] = mainWindow.getPosition()
          log('T' + i, 'END pos', ax, ay, 'size', ...mainWindow.getSize(), 'target', tx, ty)
        }
        log('drag-test done')
        clearTimeout(watchdog)
        app.quit()
      }, 6000)
    })
  }
  // 尺寸守卫：以「用户当前缩放对应的尺寸」为基线，仅在实际尺寸偏离（>3px）时
  // 强制拉回——既防系统悄悄放大/漂移，又不干扰用户主动的滚轮缩放。
  const sizeGuard = setInterval(() => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    const [w, h] = mainWindow.getSize()
    const { w: ew, h: eh } = expectedSize()
    if (Math.abs(w - ew) > 3 || Math.abs(h - eh) > 3) {
      mainWindow.setSize(ew, eh)
      if (process.argv.includes('--watch-size')) {
        appendFileSync(join(app.getPath('userData'), 'watch-size.log'), `GUARD restored size from ${w}x${h} to ${ew}x${eh}\n`)
      }
    }
  }, 1000)
  app.on('before-quit', () => clearInterval(sizeGuard))
  // --watch-size：自检用——每 500ms 记录窗口自身报告的位置与尺寸到 userData。
  if (process.argv.includes('--watch-size')) {
    const wsLog = join(app.getPath('userData'), 'watch-size.log')
    const watch = () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        const p = mainWindow.getPosition()
        const s = mainWindow.getSize()
        const b = mainWindow.getBounds()
        appendFileSync(wsLog, `t=${Date.now()} pos=${p[0]},${p[1]} size=${s[0]}x${s[1]} bounds=${b.x},${b.y},${b.width}x${b.height} max=${mainWindow.isMaximized()}\n`)
      }
    }
    appendFileSync(wsLog, 'watch-size start\n')
    watch()
    setInterval(watch, 500)
    // 记录任何尺寸变化事件（定位放大来源）
    mainWindow.on('resize', () => {
      const p = mainWindow.getPosition()
      const s = mainWindow.getSize()
      appendFileSync(wsLog, `RESIZE-EVENT pos=${p[0]},${p[1]} size=${s[0]}x${s[1]} max=${mainWindow.isMaximized()}\n`)
    })
  }
  mainWindow.on('moved', () => {
    // 防抖：游走/拖拽会高频触发 moved，同步落盘太频繁（游走时 ~20 次/秒）。
    clearTimeout(stateSaveTimer)
    stateSaveTimer = setTimeout(saveWindowState, 500)
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function send(channel, payload) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

async function readJson(path) {
  const response = await fetch(endpoint(dshUrl, path), { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function refresh() {
  const snapshot = validateSnapshot(await readJson('/whale-girl/state'))
  if (snapshot === null) throw new Error('鲸鱼娘状态数据版本不受支持')
  send('pet:snapshot', snapshot)
  send('pet:connection', { connected: true, dshUrl })
  return snapshot
}

async function followEvents() {
  streamAbort?.abort()
  streamAbort = new AbortController()
  const response = await fetch(endpoint(dshUrl, '/whale-girl/events'), { signal: streamAbort.signal })
  if (!response.ok || response.body === null) throw new Error(`SSE HTTP ${response.status}`)
  retryMs = RETRY_MIN_MS
  await refresh()
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = buffered.indexOf('\n\n')) !== -1) {
      const event = buffered.slice(0, boundary)
      buffered = buffered.slice(boundary + 2)
      if (event.split('\n').some(line => line.startsWith('data:'))) await refresh()
    }
  }
  throw new Error('SSE connection closed')
}

async function connectionLoop() {
  while (!stopped) {
    try {
      await followEvents()
      stopSimulation()
    } catch (error) {
      if (stopped) return
      // 离线模拟模式：仍置 connected=true（renderer 才会加载内置素材、显示模拟状态），
      // 用 simulated 标记区分「真实 DSH」与「内置模拟」，供 UI/日志参考。
      send('pet:connection', { connected: true, dshUrl, simulated: true, message: error.message })
      startSimulation()
      await new Promise(resolve => setTimeout(resolve, retryMs))
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2)
    }
  }
}

// ---- 内置模拟数据层（离线兜底）----
// 连不上 whale-girl（DSH 未装/未启动）时，exe 给 renderer 喂一个稳定的 idle 快照，
// 让宠物像平时空闲时一样自然进入「睡觉等待」——而不是假装干活循环。体验与真实一致。
// 一旦真连接恢复（followEvents 成功），stopSimulation 立即停掉模拟。
let simulationTimer = null

function stopSimulation() {
  if (simulationTimer !== null) {
    clearInterval(simulationTimer)
    simulationTimer = null
  }
}

function idleSnapshot(now = Date.now()) {
  return {
    apiVersion: 1,
    activity: {
      name: 'idle',
      until: 0,
      sessionThink: false,
      sessionWait: false,
      turnCompletedUntil: 0,
      runningCount: 0,
      sessionThinkCount: 0,
    },
    pet: { stats: { tasksDone: 0 } },
    balance: { isAvailable: false },
  }
}

function startSimulation() {
  if (simulationTimer !== null) return
  // 一次性喂入 idle：renderer 会像平时一样经历 idle →（空闲超时）→ 睡觉等待。
  send('pet:snapshot', idleSnapshot())
  simulationTimer = setInterval(() => {
    if (stopped) return
    // 仅确保 snapshot 持续存在；renderer 自行管理 idle→sleep 睡眠节奏。
    send('pet:snapshot', idleSnapshot())
  }, 10000)
}

// 托盘：仅显示/隐藏/退出（不再有缩放——窗口固定尺寸）。
// 图标用内置 idle.png（离线也有托盘小鱼图标），不依赖 whale-girl 素材端点。
async function createTray() {
  const iconPath = join(__dirname, 'renderer', 'assets', 'characters', 'whale-girl', 'idle.png')
  let icon = null
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) {
      icon = icon.crop({ x: 0, y: 0, width: 256, height: 256 }).resize({ width: 16, height: 16 })
    }
  } catch {}
  tray = new Tray(icon && !icon.isEmpty() ? icon : nativeImage.createEmpty())
  tray.setToolTip('大肥鱼.exe')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow?.showInactive() },
    { label: '隐藏', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
}

ipcMain.handle('pet:get-bootstrap', async () => ({
  dshUrl,
  // 素材内置打包：renderer 从相对路径加载内置表情（file:// 页面同目录 assets/），
  // 不依赖 whale-girl 的 HTTP 素材端点——离线也有完整 15 种表情。
  assetsUrl: './assets/characters/whale-girl',
  canProgrammaticallyMove: displayBackend !== 'wayland',
  scale: userScale,
}))
// manifest 内置：从打包进 asar 的 assets/manifest.json 读取，离线可用。
ipcMain.handle('pet:get-manifest', async () => {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'renderer', 'assets', 'manifest.json'), 'utf8'))
  } catch { return null }
})
ipcMain.handle('pet:get-config', async () => {
  try { return await readJson('/whale-girl/config') } catch { return null }
})
ipcMain.handle('pet:refresh', async () => {
  try { return await refresh() } catch { return null }
})
ipcMain.handle('pet:interact', async (_event, action) => {
  if (!['feed', 'play'].includes(action)) throw new Error('不支持的互动方式')
  const response = await fetch(endpoint(dshUrl, '/whale-girl/interact'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
})
ipcMain.on('pet:set-click-through', (_event, ignored) => {
  mainWindow?.setIgnoreMouseEvents(Boolean(ignored), { forward: true })
})

// 全屏可动范围：display.bounds（含任务栏的整块屏幕）而非 workArea，
// 桌面宠物可满屏游走；拖拽/游走统一走此钳制，不会越界卡边。
function clampToDisplay(targetX, targetY) {
  const display = screen.getDisplayNearestPoint({ x: targetX, y: targetY })
  const b = display.bounds
  const [windowW, windowH] = mainWindow.getSize()
  return {
    x: Math.min(b.x + b.width - windowW, Math.max(b.x, targetX)),
    y: Math.min(b.y + b.height - windowH, Math.max(b.y, targetY)),
  }
}

// 强制摆放：位置 + 当前缩放尺寸一起设置（setBounds）。系统任何试图放大/漂移窗口
// 的操作，都会在下次移动时被覆盖——窗口尺寸与可动范围因此恒定不变。
function placeWindow(x, y) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const { w, h } = expectedSize()
  mainWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
  })
}

ipcMain.on('pet:drag-start', (_event, point) => {
  if (mainWindow === null || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  if (displayBackend === 'wayland') return
  const [windowX, windowY] = mainWindow.getPosition()
  dragOrigin = { pointerX: point.x, pointerY: point.y, windowX, windowY }
})
ipcMain.on('pet:drag-move', (_event, point) => {
  if (displayBackend === 'wayland') return
  if (mainWindow === null || dragOrigin === null || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const targetX = Math.round(dragOrigin.windowX + point.x - dragOrigin.pointerX)
  const targetY = Math.round(dragOrigin.windowY + point.y - dragOrigin.pointerY)
  const { x, y } = clampToDisplay(targetX, targetY)
  placeWindow(x, y)
})
ipcMain.on('pet:drag-end', () => {
  dragOrigin = null
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    const [x, y] = mainWindow.getPosition()
    placeWindow(x, y) // 松手时再强制一次（校正任何中途被改动的尺寸）
  }
  saveWindowState()
})
// 游走：沿屏幕水平移动窗口（宠物在窗口内视觉随窗口移动）。dx 为本次位移（px）；
// 返回 { moved: false } 表示已顶到屏幕边缘（渲染端据此翻转方向）。
ipcMain.handle('pet:walk-move', (_event, dx) => {
  if (displayBackend === 'wayland') return { moved: false, unavailable: true }
  if (mainWindow === null || !Number.isFinite(dx) || dx === 0) return { moved: false }
  const [x, y] = mainWindow.getPosition()
  const targetX = Math.round(x + dx)
  const clamped = clampToDisplay(targetX, y).x
  placeWindow(clamped, y)
  return { moved: clamped !== x }
})
// 滚轮/托盘缩放：0.6x–2x；窗口尺寸同步缩放并记忆（渲染端同时应用 body zoom）。
// 拖动中滚轮被渲染端忽略（防误触变大）；守卫跟随缩放后的基线。
ipcMain.handle('pet:resize', (_event, scale) => {
  if (!Number.isFinite(scale)) return
  userScale = Math.min(2, Math.max(0.6, scale))
  const { w, h } = expectedSize()
  mainWindow?.setSize(w, h)
  saveWindowState()
})
ipcMain.on('pet:quit', () => app.quit())

// 在场心跳：在线期间 whale-girl 隐藏网页端宠物；退出/崩溃后 TTL 过期自动恢复。
// DSH 未启动/断线时静默失败，下一轮重试（不阻塞主流程）。
function pokePresence(online) {
  fetch(endpoint(dshUrl, '/whale-girl/presence'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ online }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

app.whenReady().then(() => {
  if (!gotTheLock) return
  createWindow()
  createTray().catch(() => {})
  connectionLoop()
  pokePresence(true)
  presenceTimer = setInterval(() => pokePresence(true), PRESENCE_INTERVAL_MS)
  // 轮询兜底：whale-girl 的 SSE 只在任务终态/回合边沿广播，任务「开始」不广播；
  // 每 3s 主动拉一次 /state，保证「正在吃 N 碗」实时跟随任务数（与网页端 pollMs 一致）。
  // 节能：窗口隐藏（托盘收起）时暂停轮询，显示时才恢复。
  refreshTimer = setInterval(() => {
    if (stopped) return
    if (mainWindow === null || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    refresh().catch(() => {})
  }, 3000)
})

app.on('before-quit', () => {
  stopped = true
  streamAbort?.abort()
  clearInterval(presenceTimer)
  clearInterval(refreshTimer)
  stopSimulation()
  // 干净退出即时恢复网页端宠物（best-effort；进程被杀时由 TTL 兜底恢复）。
  pokePresence(false)
  saveWindowState()
})
app.on('window-all-closed', event => event.preventDefault())
