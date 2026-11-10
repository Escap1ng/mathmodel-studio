/**
 * 文档截图采集：离线演示驱动真实流程，1.5 倍密率重拍 docs/images。
 * 运行：npm run build 后 `npx electron --force-device-scale-factor=1.5 scripts/docshots.cjs`
 * 产出：workbench.png（通用欢迎，整行）、conversation.png（对话，整行）、
 *       decision.png（五维雷达，整行）、process.png（过程总览，整行）、
 *       score.png / paper.png（评分与论文，窄窗面板裁切，README 双列）。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

process.env.MMS_FAKE_PROVIDER = '1'
process.env.MMS_FAKE_DELAY_MS = '20'
const userDataDir = mkdtempSync(join(tmpdir(), 'mms-docshots-'))
app.setPath('userData', userDataDir)
process.env.MMS_WORKSPACE = join(userDataDir, 'workspace')

app.commandLine.appendSwitch('disable-dev-shm-usage')
app.commandLine.appendSwitch('force-device-scale-factor', '1.5')
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const IMG_DIR = join(ROOT, 'docs', 'images')
const BACKUP_DIR = join(tmpdir(), 'mms-docshots-backup')
const SHOTS = ['workbench.png', 'conversation.png', 'decision.png', 'score.png', 'paper.png']
// process.png 是新增文件；其余五张先备份，采完不满意可回退。
if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  for (const name of SHOTS) {
    const src = join(IMG_DIR, name)
    if (existsSync(src)) copyFileSync(src, join(BACKUP_DIR, name))
  }
}

async function firstWindow(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) return win
    await sleep(100)
  }
  throw new Error('没有等到窗口')
}

async function waitLoaded(win, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const url = win.webContents.getURL()
    if (url && !url.startsWith('about:')) return url
    await sleep(100)
  }
  throw new Error('页面没有加载完成')
}

async function waitFor(win, expression, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return true
    } catch {
      /* 还在加载 */
    }
    await sleep(150)
  }
  throw new Error(`等待超时：${expression.slice(0, 80)}`)
}

async function settle(win) {
  win.show()
  win.focus()
  win.webContents.invalidate()
  await sleep(250)
  await win.webContents.capturePage()
  await sleep(350)
}

async function shotFull(win, name) {
  await settle(win)
  const img = await win.webContents.capturePage()
  const size = img.getSize()
  if (size.width < 2000) throw new Error(`${name} 密率不对：${size.width}x${size.height}，应约 2160x1352`)
  writeFileSync(join(IMG_DIR, name), img.toPNG())
  console.log(`${name}: ${size.width}x${size.height}`)
}

async function shotRect(win, name, selector, minWidth) {
  win.show()
  win.focus()
  win.webContents.invalidate()
  await sleep(250)
  await win.webContents.capturePage()
  await sleep(350)
  const rect = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('${selector}').getBoundingClientRect()
    return { x: Math.max(0, Math.round(b.left)), y: Math.max(0, Math.round(b.top)), width: Math.round(b.width), height: Math.round(b.height) }
  })()`)
  let img = null
  for (let i = 0; i < 4; i++) {
    try {
      img = await win.webContents.capturePage(rect)
      break
    } catch {
      await sleep(400)
    }
  }
  if (!img) throw new Error(`${name} 截取失败`)
  const size = img.getSize()
  if (size.width < minWidth) throw new Error(`${name} 裁切异常：${size.width}x${size.height}`)
  writeFileSync(join(IMG_DIR, name), img.toPNG())
  console.log(`${name}: ${size.width}x${size.height}（面板 ${rect.width}x${rect.height} @ (${rect.x},${rect.y})）`)
}

async function typeAndSend(win, text, mode) {
  const sent = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.composer__input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!sent) throw new Error('输入框不存在')
  await sleep(200)
  const clicked = await win.webContents.executeJavaScript(`document.querySelector('.pill--send[data-mode="${mode}"]')?.click() ?? true`)
  if (!clicked) throw new Error('发送按钮不可用')
}

async function main() {
  require(join(__dirname, '..', 'out', 'main', 'index.js'))
  const win = await firstWindow(20000)
  await waitLoaded(win, 20000)
  await sleep(700)

  await waitFor(win, `(document.querySelector('.statusbar')?.textContent || '').includes('运行时已连接')`, 25000)
  await waitFor(win, `(document.querySelector('.pill--model')?.textContent || '').includes('离线演示')`, 20000)
  await sleep(600)
  await shotFull(win, 'workbench.png')

  // 对话：离线演示走 list_templates 工具卡，等回复与工具卡都落定再拍
  await typeAndSend(win, '模板清单怎么用', 'chat')
  await waitFor(win, `[...document.querySelectorAll('.msg--assistant .msg__text')].some((n) => n.textContent.includes('25 个模板'))`, 30000)
  await waitFor(win, `!!document.querySelector('.tool-card[data-tool="list_templates"][data-status="ok"]')`, 20000)
  await waitFor(win, `!document.querySelector('.pill--stop')`, 20000)
  await sleep(900)
  await shotFull(win, 'conversation.png')

  // 数模：切模式 → 发题 → K2 → 确认 → K3（三张候选带雷达）
  await win.webContents.executeJavaScript(`document.querySelector('.mode-switch__btn[data-mode="workflow"]')?.click()`)
  await sleep(1100)
  await typeAndSend(win, '问题1 预测未来三个月的销量。\n问题2 给出补货建议。', 'workflow')
  await waitFor(win, `!!document.querySelector('.decision[data-card="problem-confirm"]')`, 20000)
  await sleep(500)
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="confirm"]')?.click()`)
  const k3 = await waitFor(
    win,
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].some((c) => !c.querySelector('.decision__resolved') && c.querySelectorAll('.candidate__radar svg').length === 3)`,
    20000
  )
  if (!k3) throw new Error('K3 卡没有带出三张雷达')
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))?.scrollIntoView({ block: 'start' })`
  )
  await sleep(900)
  await shotFull(win, 'decision.png')
  // 面板裁切换 1500 宽窗：面板 ≈570 CSS → 裁切 855 物理px，README 双列显示时字号比例与旧图一致
  win.setContentSize(1500, 900)
  await sleep(600)
  await shotRect(win, 'process.png', '.workspace', 700)

  // 选第一张候选，等阶段四真跑出图，再拍评分
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))?.querySelector('[data-action="choose"]')?.click()`
  )
  await waitFor(win, `document.querySelector('.rail .phase[data-phase="4"]')?.dataset.state === 'running'`, 20000)
  await waitFor(
    win,
    `(async () => { const s = await window.studio.workbench.state(); return !document.querySelector('.pill--stop') && s.figure.versions.length >= 1 })()`,
    180000
  )
  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="score"]')?.click()`)
  await waitFor(win, `document.querySelectorAll('[data-panel="score"] .score-row').length === 5 && (document.querySelector('[data-role="score-total"]')?.textContent || '').includes('86')`, 20000)
  await sleep(700)
  await shotRect(win, 'score.png', '.workspace', 700)

  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="paper"]')?.click()`)
  await waitFor(win, `!!document.querySelector('.panel[data-panel="paper"]') && document.querySelector('[data-action="build-paper"]')?.disabled === false`, 20000)
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="build-paper"]')?.click()`)
  await waitFor(
    win,
    `document.querySelectorAll('[data-role="paper-steps"] li').length >= 6 && document.querySelectorAll('[data-role="paper-gates"] .paper-gate').length === 3`,
    240000
  )
  await waitFor(
    win,
    `(() => { const c = document.querySelector('[data-role="paper-preview"] canvas'); return !!c && c.width > 200 && c.height > 200 })()`,
    30000
  )
  await sleep(900)
  await shotRect(win, 'paper.png', '.workspace', 700)

  console.log('DOC_SHOTS_OK')
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch (cleanupErr) {
    console.log(`[残留] ${userDataDir} 未删净: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
  }
  app.quit()
}

main().catch((err) => {
  console.error('DOC_SHOTS_FAIL', err instanceof Error ? err.stack : String(err))
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 运行时还占着，稍后手动清 */
  }
  app.exit(1)
})
