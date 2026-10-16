/**
 * G7 · 真启动冒烟
 *
 * 关键取舍：本脚本不自己建窗口，而是 require 生产入口 out/main/index.js，
 * 让它按 src/main/index.ts 的窗口配置、preload 路径、IPC 注册与导航守卫起窗。
 * 上一版自建窗口，结果 app:meta 报 No handler registered ——那验的是脚手架，不是产品。
 *
 * 断言五组互相独立的事：
 *   1 生产入口建出了窗口，且加载的是构建产物（file:// 下的 out/renderer/index.html）
 *   2 内容尺寸 = 设计基准 1440x900（useContentSize 让这条在各平台可比）
 *   3 画面真的画出来了：按 BGRA 统计非白像素 ≥1%——空白截图也算「窗口起来了」，那是假绿
 *   4 preload + IPC 端到端：状态栏文本由主进程应答渲染出来（在 sandbox: true 下）
 *   5 结构与交互：阶段轨道 7 节、工作台 6 标签、发送按钮按事实禁用、点色块真的换掉 --accent
 *
 * 仍未覆盖：需要 LLM 与 runtime 的行为（M2 起）；沙箱之外的 CSP 违规场景。
 * 退出码：0 全部通过 / 1 任一断言失败 / 2 环境错误（没有构建产物或窗口没起来）
 */
const { app, BrowserWindow } = require('electron')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const OUT_DIR = process.env.SMOKE_OUT || 'screenshots'
const MIN_INK_RATIO = 0.01
const EXPECT_VERSION = require('../package.json').version
const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-dev-shm-usage')
app.disableHardwareAcceleration()

function envFail(msg) {
  console.error(`FAIL 环境错误: ${msg}`)
  app.exit(2)
}

async function firstWindow(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) return w
    await sleep(100)
  }
  throw new Error(`生产入口 ${ms}ms 内没有建出窗口`)
}

async function waitLoaded(win, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const url = win.webContents.getURL()
    if (url && !url.startsWith('about:')) return url
    await sleep(100)
  }
  throw new Error(`${ms}ms 内页面没有加载完成`)
}

async function main() {
  const distMain = join(__dirname, '..', 'out', 'main', 'index.js')
  if (!existsSync(distMain)) envFail('没有 out/main/index.js，先跑 npm run build')

  // 直接加载生产入口：窗口配置、preload 路径、ipcMain.handle、导航守卫都走它那一份
  require(distMain)

  const win = await firstWindow(20000)
  const url = await waitLoaded(win, 20000)
  record(
    'G7-1 加载的是构建产物',
    url.startsWith('file://') && url.replace(/\\/g, '/').endsWith('/out/renderer/index.html'),
    `实得 ${url}`
  )

  await sleep(500)

  const [w, h] = win.getContentSize()
  record('G7-1 内容尺寸 = 1440x900', w === 1440 && h === 900, `实得 ${w}x${h}`)
  record('G7-1 窗口标题', win.getTitle() === 'mathmodel-studio', `实得「${win.getTitle()}」`)

  const img = await win.webContents.capturePage()
  const { width: iw, height: ih } = img.getSize()
  const bmp = img.toBitmap() // BGRA
  let ink = 0
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    if (bmp[i + 2] < 250 || bmp[i + 1] < 250 || bmp[i] < 250) ink++
  }
  const totalPx = Math.floor(bmp.length / 4)
  const ratio = totalPx > 0 ? ink / totalPx : 0
  record('G7-2 截图面非空', iw > 0 && ih > 0 && bmp.length >= iw * ih * 4, `捕获 ${iw}x${ih}，位图 ${bmp.length} B`)
  record('G7-2 画面非空白', ratio >= MIN_INK_RATIO, `非白像素 ${ink} / ${totalPx} = ${(ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`)

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const pngBuf = img.toPNG()
  const pngPath = join(OUT_DIR, 'window-smoke.png')
  writeFileSync(pngPath, pngBuf)
  console.log(`截图: ${pngPath} (${(pngBuf.length / 1024).toFixed(1)} KB)`)

  const dom = await win.webContents.executeJavaScript(`({
    statusbar: document.querySelector('.statusbar')?.textContent ?? '',
    phases: document.querySelectorAll('.phase').length,
    tabs: document.querySelectorAll('.tab').length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    sendDisabled: document.querySelector('.pill--send')?.disabled ?? null,
    bg: getComputedStyle(document.body).backgroundColor
  })`)
  record(
    'G7-3 IPC 端到端（状态栏含主进程版本号）',
    String(dom.statusbar).includes(`v${EXPECT_VERSION}`),
    `期望含 v${EXPECT_VERSION} / 状态栏: ${JSON.stringify(String(dom.statusbar).trim().slice(0, 64))}`
  )
  record('G7-4 阶段轨道 7 节', dom.phases === 7, `实得 ${dom.phases}`)
  record('G7-4 工作台 6 个标签', dom.tabs === 6, `实得 ${dom.tabs}`)
  record('G7-4 输入区按事实禁用', dom.sendDisabled === true, `发送按钮 disabled=${dom.sendDisabled}`)
  record('G7-4 底色为白', dom.bg === 'rgb(255, 255, 255)', `实得 ${dom.bg}`)
  record('G7-4 默认强调色 = A 墨青', dom.accent.toLowerCase() === '#17494d', `实得 ${dom.accent}`)

  await win.webContents.executeJavaScript(`document.querySelectorAll('.swatch')[1].click()`)
  await sleep(200)
  const accentB = await win.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
  )
  record('G7-4 切到 B 案靛蓝生效', accentB.toLowerCase() === '#2b4c7e', `实得 ${accentB}`)

  win.close()
}

app
  .whenReady()
  .then(main)
  .then(async () => {
    const failed = results.filter((r) => !r.ok)
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}\n       ${r.detail}`)
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
    await sleep(100)
    app.exit(failed.length === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(`FAIL 冒烟脚本自身异常: ${err && err.stack ? err.stack : err}`)
    app.exit(1)
  })
