/**
 * 最小真启动冒烟：require 生产入口，等窗口与 runtime 就绪，按 DOM 与像素断言。
 *
 * 不联网、不需要 API Key；runtime 由主进程按 MMS_PYTHON 拉起。
 * 退出码：0 全部通过 / 1 断言失败 / 2 窗口或构建产物没起来。
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const OUT_DIR = process.env.SMOKE_OUT || 'screenshots'
const MIN_INK_RATIO = 0.01
const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.setPath('userData', mkdtempSync(join(tmpdir(), 'mms-smoke-')))
require('../out/main/index.js')

function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
}

async function waitFor(check, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch {
      // 页面还没加载完，下一轮再试
    }
    await sleep(stepMs)
  }
  return null
}

function inkRatio(image) {
  const { width, height } = image.getSize()
  if (!width || !height) return 0
  const bitmap = image.toBitmap()
  let ink = 0
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    if (bitmap[index] < 245 || bitmap[index + 1] < 245 || bitmap[index + 2] < 245) ink += 1
  }
  return ink / (width * height)
}

function finish(code) {
  mkdirSync(OUT_DIR, { recursive: true })
  const payload = { ok: code === 0, at: new Date().toISOString(), results }
  writeFileSync(join(OUT_DIR, 'window-smoke.json'), JSON.stringify(payload, null, 2))
  process.exitCode = code
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  setTimeout(() => app.exit(code), 100)
}

async function main() {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 20_000)
  if (!win) {
    record('窗口创建', false, '20 秒内没有窗口')
    return finish(2)
  }
  record('窗口创建', true, win.getTitle())

  const ready = await waitFor(
    async () => {
      const text = await win.webContents.executeJavaScript('document.body.innerText')
      return text.includes('就绪') && !text.includes('启动中') ? text : null
    },
    30_000,
    400
  )
  if (!ready) {
    record('runtime 就绪', false, '30 秒内没有出现“运行时就绪”')
    return finish(2)
  }
  record('runtime 就绪', true, '握手完成')

  record('窗口标题', win.getTitle() === 'MathModel Studio', win.getTitle())
  const [width, height] = win.getContentSize()
  record('内容尺寸 1280x860', width === 1280 && height === 860, `${width}x${height}`)
  record(
    '加载构建产物',
    win.webContents.getURL().includes('/out/renderer/index.html'),
    win.webContents.getURL()
  )
  for (const text of ['MathModel Studio', '把赛题变成可交付的论文', '工作区', '对话', '新建对话', '设置']) {
    record(`界面含「${text}」`, ready.includes(text), text)
  }

  const image = await win.webContents.capturePage()
  const ratio = inkRatio(image)
  record('画面非空白', ratio >= MIN_INK_RATIO, `墨迹占比 ${(ratio * 100).toFixed(1)}%`)
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'window-smoke.png'), image.toPNG())
  } catch (err) {
    record('截图落盘', false, err instanceof Error ? err.message : String(err))
  }

  const failed = results.filter((item) => !item.ok)
  return finish(failed.length ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch((err) => {
    record('冒烟脚本', false, err instanceof Error ? err.stack || err.message : String(err))
    finish(1)
  })
})
