/**
 * G7 · 真启动冒烟（M4：工作台图表、主题/回滚、评分与门禁）
 *
 * 关键取舍：本脚本不自己建窗口，而是 require 生产入口 out/main/index.js，
 * 让它按 src/main/index.ts 的窗口配置、preload 路径、IPC 注册、runtime 子进程与导航守卫起窗。
 * 上一版自建窗口，结果 app:meta 报 No handler registered ——那验的是脚手架，不是产品。
 *
 * 断言七组互相独立的事：
 *   1 生产入口建出了窗口，且加载的是构建产物（file:// 下的 out/renderer/index.html）
 *   2 内容尺寸 = 设计基准 1440x900（useContentSize 让这条在各平台可比）
 *   3 画面真的画出来了：按 BGRA 统计非白像素 ≥1%——空白截图也算「窗口起来了」，那是假绿
 *   4 preload + IPC 端到端：状态栏与 runtime 握手结果由主进程应答渲染出来（在 sandbox: true 下）
 *   5 结构与交互：阶段轨道 7 节、工作台 6 标签、runtime 就绪后输入区可用、点色块换 --accent
 *   6 中文按真字形渲染——用「国」与空心框「□」的墨量比值区分；像素总量和
 *     document.fonts.check 都分不清字与方框，上一轮的豆腐块截图就是这么混过去的
 *   7 M3 闭环：新赛题停在 K2 → 确认后 K3 三张候选 → 解释抽屉不清待选 →
 *     runtime 重启后待选仍在 → 换一批 → 选择后进入阶段 4
 *   8 M2 回归：自由问答仍能流式出字、list_templates 工具卡走到完成、设置页不回显 Key
 *
 * 假 provider 只在本脚本进程里打开（MMS_FAKE_PROVIDER=1），不联网、不需要 Key；
 * 真实 DeepSeek/Kimi 需要用户自己的 Key，不能在这里代跑。
 * userData 指到临时目录，避免开发机上已有的 settings.json 改变默认选中项。
 *
 * 退出码：0 全部通过 / 1 任一断言失败 / 2 环境错误（没有构建产物或窗口没起来）
 */
const { app, BrowserWindow, Menu, safeStorage } = require('electron')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const OUT_DIR = process.env.SMOKE_OUT || 'screenshots'
const MIN_INK_RATIO = 0.01
const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 必须在 require 生产入口之前：主进程会在 whenReady 后按这份环境变量拉起 Python。
process.env.MMS_FAKE_PROVIDER = '1'
process.env.MMS_FAKE_DELAY_MS = process.env.MMS_FAKE_DELAY_MS || '20'

const userDataDir = mkdtempSync(join(tmpdir(), 'mms-g7-userdata-'))
app.setPath('userData', userDataDir)

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

async function waitFor(win, expression, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return true
    } catch {
      /* 页面还在加载 */
    }
    await sleep(100)
  }
  return false
}

// 重渲染后 capturePage 可能拿到上一帧；先请求一次整页重绘再截。
async function freshShot(win) {
  try {
    win.show()
    win.focus()
    win.webContents.invalidate()
  } catch {
    /* 窗口已销毁 */
  }
  await sleep(250)
  // 第一次 capture 常拿到切换标签前的那一帧；丢弃后再取一次。
  await win.webContents.capturePage()
  await sleep(350)
  return win.webContents.capturePage()
}

function measureInk(image) {
  const bmp = image.toBitmap() // BGRA
  let ink = 0
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    if (bmp[i + 2] < 250 || bmp[i + 1] < 250 || bmp[i] < 250) ink++
  }
  const total = Math.floor(bmp.length / 4)
  return { ink, total, ratio: total > 0 ? ink / total : 0 }
}

async function main() {
  const distMain = join(__dirname, '..', 'out', 'main', 'index.js')
  if (!existsSync(distMain)) envFail('没有 out/main/index.js，先跑 npm run build')

  // 直接加载生产入口：窗口配置、preload 路径、ipcMain.handle、runtime 子进程都走它那一份
  require(distMain)

  const win = await firstWindow(20000)
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${source}:${line})`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[renderer gone] ${JSON.stringify(details)}`)
  })
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
  const shot = measureInk(img)
  record('G7-2 截图面非空', iw > 0 && ih > 0 && img.toBitmap().length >= iw * ih * 4, `捕获 ${iw}x${ih}`)
  record(
    'G7-2 画面非空白',
    shot.ratio >= MIN_INK_RATIO,
    `非白像素 ${shot.ink} / ${shot.total} = ${(shot.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const pngBuf = img.toPNG()
  const pngPath = join(OUT_DIR, 'window-smoke.png')
  writeFileSync(pngPath, pngBuf)
  console.log(`截图: ${pngPath} (${(pngBuf.length / 1024).toFixed(1)} KB)`)

  // runtime 由主进程在 whenReady 里拉起，握手完成后状态栏才会变。等它，而不是固定睡一段时间。
  const ready = await waitFor(
    win,
    `(document.querySelector('.statusbar')?.textContent || '').includes('运行时已连接')`,
    20000
  )
  // provider 清单是另一条 IPC，工作台状态也在同时加载；等模型条真的选中再抓 DOM。
  const providerReady = await waitFor(
    win,
    `(document.querySelector('.pill--model')?.textContent || '').includes('离线演示')`,
    15000
  )

  const dom = await win.webContents.executeJavaScript(`({
    statusbar: document.querySelector('.statusbar')?.textContent ?? '',
    phases: document.querySelectorAll('.phase').length,
    tabs: document.querySelectorAll('.tab').length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    sendDisabled: document.querySelector('.pill--send')?.disabled ?? null,
    sendText: document.querySelector('.pill--send')?.textContent?.trim() ?? '',
    inputDisabled: document.querySelector('.composer__input')?.disabled ?? null,
    modelPill: document.querySelector('.pill--model')?.textContent?.trim() ?? '',
    bg: getComputedStyle(document.body).backgroundColor
  })`)

  // executeJavaScript 会等页面里的 Promise，所以这一行就是「页面 → preload → 主进程 → 原路返回」的端到端调用
  const ipc = await win.webContents.executeJavaScript(`window.studio.meta()`)
  record(
    'G7-3 IPC 端到端（主进程的 runtime 信息穿过 preload 回到页面）',
    ipc && ipc.Electron === process.versions.electron && ipc.platform === process.platform,
    `页面收到 ${JSON.stringify(ipc)} / 主进程实际 electron ${process.versions.electron}、platform ${process.platform}`
  )
  const shownVersion = String(dom.statusbar).match(/v(\d+\.\d+\.\d+)/)
  record(
    'G7-3 状态栏渲染出主进程版本号',
    shownVersion !== null,
    `状态栏: ${JSON.stringify(String(dom.statusbar).trim().slice(0, 80))}`
  )
  record(
    'G7-3 runtime 通过握手就绪',
    ready &&
      String(dom.statusbar).includes('离线演示') &&
      String(dom.statusbar).includes('运行时已连接'),
    `状态栏: ${JSON.stringify(String(dom.statusbar).trim().slice(0, 120))}`
  )
  record(
    'G7-3 离线演示 provider 自动选中',
    providerReady && dom.modelPill.includes('离线演示') && dom.modelPill.includes('fake-stream'),
    `模型条: ${JSON.stringify(dom.modelPill)}`
  )

  record('G7-4 阶段轨道 7 节', dom.phases === 7, `实得 ${dom.phases}`)
  const appMenu = Menu.getApplicationMenu()
  record(
    'G7-4 Windows/Linux 不挂英文系统菜单',
    process.platform === 'darwin' || appMenu === null,
    `platform=${process.platform}，应用菜单=${appMenu === null ? 'null' : 'still set'}`
  )
  record('G7-4 工作台 6 个标签', dom.tabs === 6, `实得 ${dom.tabs}`)
  record(
    'G7-4 输入区在 runtime 就绪后可用',
    ready && dom.sendDisabled === false && dom.inputDisabled === false,
    `发送 disabled=${dom.sendDisabled}，输入 disabled=${dom.inputDisabled}`
  )
  record('G7-4 底色为白', dom.bg === 'rgb(255, 255, 255)', `实得 ${dom.bg}`)
  record('G7-4 默认强调色 = A 墨青', dom.accent.toLowerCase() === '#17494d', `实得 ${dom.accent}`)

  await win.webContents.executeJavaScript(`document.querySelectorAll('.swatch')[1].click()`)
  await sleep(200)
  const accentB = await win.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
  )
  record('G7-4 切到 B 案靛蓝生效', accentB.toLowerCase() === '#2b4c7e', `实得 ${accentB}`)

  // 中文字体可用性。不能再用 document.fonts.check(具名族)：
  // Chromium 在有回退字体时对任何族名都返回 true，包括根本没装的族。
  // 改成能双向区分的度量：把笔画复杂的「国」与空心框「□」画进 canvas 比墨量。
  const glyph = await win.webContents.executeJavaScript(`(() => {
    const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-cjk')
    const density = (ch) => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const x = c.getContext('2d')
      x.fillStyle = '#ffffff'
      x.fillRect(0, 0, 64, 64)
      x.fillStyle = '#000000'
      x.font = '48px ' + stack
      x.textBaseline = 'top'
      x.fillText(ch, 4, 6)
      const d = x.getImageData(0, 0, 64, 64).data
      let dark = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++
      return dark
    }
    const s = document.createElement('span')
    s.style.cssText = 'position:absolute;left:-9999px;top:0;font-family:var(--font-cjk);font-size:13.5px'
    s.textContent = '国赛建模'
    document.body.appendChild(s)
    const width = s.getBoundingClientRect().width
    s.remove()
    const complex = density('国')
    const box = density('□')
    return { complex, box, ratio: box > 0 ? complex / box : 0, width }
  })()`)
  record(
    'G7-5 中文按真字形渲染（不是空心方框）',
    glyph.complex > 50 && glyph.ratio > 1.5,
    `「国」暗像素 ${glyph.complex} / 「□」${glyph.box}，比值 ${glyph.ratio.toFixed(2)}（缺字体时两者接近，比值≈1）`
  )
  record('G7-5 中文探针有实际占位', glyph.width > 40, `「国赛建模」13.5px 宽 ${glyph.width}`)

  // —— M2：设置页不回显 Key ——
  await win.webContents.executeJavaScript(`document.querySelector('.pill--model')?.click()`)
  await sleep(250)
  const settings = await win.webContents.executeJavaScript(`({
    open: !!document.querySelector('.settings[role="dialog"]'),
    chips: [...document.querySelectorAll('.provider-chip')].map((b) => b.textContent.trim()),
    hasKeyField: !!document.querySelector('.settings input[type="password"]')
  })`)
  record(
    'G7-6 设置对话框打开并列出服务商',
    settings.open && settings.chips.length >= 4 && settings.chips.some((c) => c.includes('离线演示')),
    `chips=${JSON.stringify(settings.chips)}`
  )
  writeFileSync(join(OUT_DIR, 'settings.png'), (await win.webContents.capturePage()).toPNG())

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.provider-chip')].find((b) => b.textContent.includes('DeepSeek'))?.click()`
  )
  await sleep(150)
  const keyEcho = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.settings input[type="password"]')
    return input ? { present: true, value: input.value, placeholder: input.placeholder } : { present: false }
  })()`)
  record(
    'G7-6 设置页不回显已保存的 Key',
    keyEcho.present === true && keyEcho.value === '' && !/sk-|Bearer/.test(keyEcho.placeholder || ''),
    `password input ${JSON.stringify(keyEcho)}`
  )

  // 真实走一遍 safeStorage：写一个哨兵 Key，再读回磁盘，只允许看到密文字段。
  // 安全存储不可用的平台（无 Secret Service 的 Linux）必须明确拒绝，且不得落盘。
  const sentinel = 'sk-g7-SENTINEL-NOT-A-REAL-KEY'
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.settings input[type="password"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(sentinel)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value.length
  })()`)
  await sleep(120)
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.settings .btn')].find((b) => b.textContent.trim() === '保存')?.click()`
  )
  await sleep(400)

  const encryptionAvailable = safeStorage.isEncryptionAvailable()
  const settingsPath = join(userDataDir, 'settings.json')
  let disk = { exists: false, hasPlain: false, hasKey: false }
  try {
    const raw = readFileSync(settingsPath, 'utf8')
    disk = {
      exists: true,
      hasPlain: raw.includes(sentinel),
      hasKey: /"key"\s*:\s*"[A-Za-z0-9+/=]{16,}"/.test(raw)
    }
  } catch {
    /* 拒绝保存时文件可能根本不存在 */
  }
  let refused = false
  if (!encryptionAvailable) {
    const err = await win.webContents.executeJavaScript(
      `document.querySelector('.settings__error')?.textContent ?? ''`
    )
    refused = err.includes('安全存储不可用') && !disk.hasKey
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.settings .btn')].find((b) => b.textContent.trim() === '取消')?.click()`
    )
    await sleep(150)
  }
  record(
    'G7-6 Key 落盘只有密文或明确拒绝',
    encryptionAvailable
      ? disk.exists && !disk.hasPlain && disk.hasKey
      : refused && !disk.exists,
    `safeStorage 可用=${encryptionAvailable}，文件存在=${disk.exists}，含明文=${disk.hasPlain}，含密文字段=${disk.hasKey}，明确拒绝=${refused}`
  )

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.settings .btn')].find((b) => b.textContent.trim() === '取消')?.click()`
  )
  await sleep(200)
  const closed = await win.webContents.executeJavaScript(`!document.querySelector('.settings')`)
  record('G7-6 设置对话框可以关闭', closed === true, `关闭后仍存在=${!closed}`)

  // 切回离线演示再对话：上一步把 active provider 指到了 DeepSeek，这里不能带着假 Key 去联网。
  await win.webContents.executeJavaScript(`document.querySelector('.pill--model')?.click()`)
  await sleep(250)
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.provider-chip')].find((b) => b.textContent.includes('离线演示'))?.click()`
  )
  await sleep(120)
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.settings .btn')].find((b) => b.textContent.trim() === '保存')?.click()`
  )
  await sleep(300)
  const backToFake = await waitFor(
    win,
    `!document.querySelector('.settings') && (document.querySelector('.pill--model')?.textContent || '').includes('离线演示')`,
    5000
  )
  if (!backToFake) throw new Error('切回离线演示 provider 失败，拒绝继续以免带着假 Key 联网')

  // —— M3：从赛题到选模卡，再到持久化恢复 ——
  const defaultMode = await win.webContents.executeJavaScript(
    `document.querySelector('.mode-switch__btn[data-mode="workflow"]')?.getAttribute('aria-pressed')`
  )
  record('G7-7 默认进入建模模式', defaultMode === 'true', `aria-pressed=${defaultMode}`)

  const problem = '问题1 预测未来三个月的销量。\n问题2 给出补货建议。'
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.composer__input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(problem)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value.length
  })()`)
  await sleep(100)
  await win.webContents.executeJavaScript(`document.querySelector('.pill--send[data-mode="workflow"]')?.click()`)

  const k2Open = await waitFor(
    win,
    `!!document.querySelector('.decision[data-card="problem-confirm"]')`,
    15000
  )
  const k2 = await win.webContents.executeJavaScript(`({
    questions: document.querySelectorAll('.decision[data-card="problem-confirm"] .decision__questions li').length,
    phase1: document.querySelector('.rail .phase[data-phase="1"]')?.dataset.state ?? null,
    sendDisabled: document.querySelector('.pill--send[data-mode="workflow"]')?.disabled ?? null,
    cardText: document.querySelector('.decision[data-card="problem-confirm"]')?.textContent ?? ''
  })`)
  record(
    'G7-7 K2 卡切出两个子问题',
    k2Open && k2.questions === 2 && k2.cardText.includes('赛题与附件确认'),
    `卡片出现=${k2Open}，子问题=${k2.questions}`
  )
  record(
    'G7-7 阶段 1 停在等你确认',
    k2.phase1 === 'waiting',
    `阶段 1 状态=${k2.phase1}`
  )
  record(
    'G7-7 待决时建模发送禁用',
    k2.sendDisabled === true,
    `发送按钮 disabled=${k2.sendDisabled}`
  )

  const snapK2 = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  record(
    'G7-7 K2 待决已写入会话表',
    snapK2?.session?.pending?.card === 'problem-confirm' &&
      snapK2.session.messages.some((m) => m.role === 'user' && m.content.includes('销量')),
    `pending=${snapK2?.session?.pending?.card} 消息数=${snapK2?.session?.messages?.length}`
  )

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="confirm"]')?.click()`)
  const k3Open = await waitFor(
    win,
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].some((c) => !c.querySelector('.decision__resolved'))`,
    15000
  )
  const k3 = await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))
    return {
      candidates: card ? card.querySelectorAll('.candidate').length : 0,
      phase3: document.querySelector('.rail .phase[data-phase="3"]')?.dataset.state ?? null,
      names: card ? [...card.querySelectorAll('.candidate__name')].map((n) => n.textContent) : []
    }
  })()`)
  const snapK3 = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  const candidatesK3 = snapK3?.session?.pending?.payload?.candidates ?? []
  record(
    'G7-7 确认后出现三张候选，含创新性高的一项',
    k3Open &&
      k3.candidates === 3 &&
      candidatesK3.length === 3 &&
      candidatesK3.some((c) => c.innovation === '高'),
    `候选=${k3.candidates} 创新度=${candidatesK3.map((c) => c.innovation)}`
  )
  record('G7-7 阶段 3 停在等你选', k3.phase3 === 'waiting', `阶段 3 状态=${k3.phase3}`)

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))?.querySelector('[data-action="explain"]')?.click()`
  )
  const drawerOpen = await waitFor(win, `!!document.querySelector('.drawer[data-drawer="explain"]')`, 5000)
  const explainState = await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))
    return {
      cardStill: !!card,
      phase3: document.querySelector('.rail .phase[data-phase="3"]')?.dataset.state ?? null,
      sections: document.querySelectorAll('.drawer .drawer__section').length
    }
  })()`)
  const snapExplain = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  record(
    'G7-7 解释抽屉打开不清除待选',
    drawerOpen &&
      explainState.cardStill &&
      explainState.phase3 === 'waiting' &&
      explainState.sections >= 5 &&
      snapExplain?.session?.pending?.card === 'model-choice',
    `抽屉=${drawerOpen} 卡片仍在=${explainState.cardStill} 阶段3=${explainState.phase3} 小节=${explainState.sections}`
  )
  await sleep(300)
  const drawerShot = await win.webContents.capturePage()
  const drawerInk = measureInk(drawerShot)
  writeFileSync(join(OUT_DIR, 'drawer.png'), drawerShot.toPNG())
  record(
    'G7-7 解释抽屉截图非空',
    drawerInk.ratio >= MIN_INK_RATIO,
    `非白像素 ${(drawerInk.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="close-drawer"]')?.click()`)
  const drawerClosed = await waitFor(win, `!document.querySelector('.drawer')`, 5000)
  record('G7-7 解释抽屉可以关闭', drawerClosed, `关闭后仍存在=${!drawerClosed}`)

  // 杀掉 runtime 再拉起：待选卡必须从 SQLite 快照回到界面，而不是靠内存。
  const sidBefore = snapK3?.session?.id
  await win.webContents.executeJavaScript(`window.studio.runtime.restart().then(() => true)`)
  const restored = await waitFor(
    win,
    `!!document.querySelector('.decision[data-card="model-choice"]') && document.querySelector('.rail .phase[data-phase="3"]')?.dataset.state === 'waiting' && !document.querySelector('.pill--stop')`,
    25000
  )
  const snapRestored = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  record(
    'G7-7 runtime 重启后仍停在 K3',
    restored &&
      snapRestored?.session?.id === sidBefore &&
      snapRestored.session.pending?.card === 'model-choice',
    `恢复=${restored} 会话一致=${snapRestored?.session?.id === sidBefore} pending=${snapRestored?.session?.pending?.card}`
  )

  const firstName = (snapRestored?.session?.pending?.payload?.candidates ?? [])[0]?.name
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reroll"]')?.click()`)
  const rerolled = await waitFor(
    win,
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].some((c) => !c.querySelector('.decision__resolved') && c.textContent.includes('第 2 组'))`,
    15000
  )
  const snapReroll = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  const rerollCandidates = snapReroll?.session?.pending?.payload?.candidates ?? []
  record(
    'G7-7 换一批给出第 2 组新候选',
    rerolled &&
      snapReroll?.session?.batch === 2 &&
      rerollCandidates[0]?.name &&
      rerollCandidates[0].name !== firstName,
    `batch=${snapReroll?.session?.batch} 首项 ${firstName} → ${rerollCandidates[0]?.name}`
  )

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))?.scrollIntoView({ block: 'start' })`
  )
  await sleep(250)
  const decisionShot = await win.webContents.capturePage()
  const decisionInk = measureInk(decisionShot)
  writeFileSync(join(OUT_DIR, 'decision.png'), decisionShot.toPNG())
  record(
    'G7-7 选模卡截图非空',
    decisionInk.ratio >= MIN_INK_RATIO,
    `非白像素 ${(decisionInk.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )

  const pick = rerollCandidates[0]?.id
  await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.decision[data-card="model-choice"]')].find((c) => !c.querySelector('.decision__resolved'))
    card?.querySelector('[data-action="choose"][data-choice="${pick}"]')?.click()
  })()`)
  const chosen = await waitFor(
    win,
    `document.querySelector('.rail .phase[data-phase="4"]')?.dataset.state === 'running' && [...document.querySelectorAll('.msg--assistant .msg__text')].some((n) => n.textContent.includes('已选择'))`,
    15000
  )
  const snapChosen = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  const phaseChosen = await win.webContents.executeJavaScript(`({
    p3: document.querySelector('.rail .phase[data-phase="3"]')?.dataset.state ?? null,
    p4: document.querySelector('.rail .phase[data-phase="4"]')?.dataset.state ?? null,
    stop: !!document.querySelector('.pill--stop'),
    actions: [...document.querySelectorAll('.decision[data-card="model-choice"]')]
      .filter((c) => c.querySelector('.decision__resolved'))
      .flatMap((c) => [...c.querySelectorAll('[data-action="choose"], [data-action="reroll"]')])
      .map((b) => ({ action: b.dataset.action, disabled: b.disabled, opacity: getComputedStyle(b).opacity }))
  })`)
  record(
    'G7-7 选择后阶段 4 进入且待决清空',
    chosen &&
      phaseChosen.p3 === 'passed' &&
      phaseChosen.p4 === 'running' &&
      snapChosen?.session?.pending === null &&
      !phaseChosen.stop,
    `阶段3=${phaseChosen.p3} 阶段4=${phaseChosen.p4} pending=${snapChosen?.session?.pending} 停止键=${phaseChosen.stop}`
  )
  record(
    'G7-7 已选卡的动作按钮已禁用',
    phaseChosen.actions.length > 0 && phaseChosen.actions.every((b) => b.disabled),
    `动作按钮 ${JSON.stringify(phaseChosen.actions)}`
  )

  // —— M4：工作台图表、主题、回滚、评分与门禁 ——
  await waitFor(
    win,
    `!!document.querySelector('[data-role="figure-image"]') || !!document.querySelector('[data-action="render-first"]')`,
    20000
  )
  await win.webContents.executeJavaScript(`(() => {
    if (!document.querySelector('[data-role="figure-image"]')) {
      document.querySelector('[data-action="render-first"]')?.click()
    }
    return true
  })()`)
  const figureReady = await waitFor(
    win,
    `(document.querySelector('[data-role="figure-image"]')?.naturalWidth || 0) > 0`,
    90000
  )
  const figState = await win.webContents.executeJavaScript(`window.studio.workbench.state()`)
  const firstVersion = figState?.figure?.active
  const firstImage = figState?.figure?.activeImage
  record(
    'G7-8 工作台渲染出首版图表',
    figureReady && Boolean(firstVersion) && (figState?.figure?.versions?.length ?? 0) >= 1,
    `图片就绪=${figureReady} active=${firstVersion} 版本数=${figState?.figure?.versions?.length}`
  )

  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('[data-role="figure-theme"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'studio-ink')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(120)
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="render-figure"]')?.click()`)
  const reRendered = await waitFor(
    win,
    `document.querySelectorAll('.version-chip').length >= 2 && !!document.querySelector('[data-role="figure-diff"]') && (document.querySelector('[data-role="figure-image"]')?.naturalWidth || 0) > 0`,
    90000
  )
  const fig2 = await win.webContents.executeJavaScript(`window.studio.workbench.state()`)
  const secondVersion = fig2?.figure?.active
  record(
    'G7-8 换主题重渲出第二版并并排 diff',
    reRendered &&
      Boolean(secondVersion) &&
      secondVersion !== firstVersion &&
      fig2.figure.previous === firstVersion &&
      fig2.figure.activeImage !== firstImage &&
      Boolean(fig2.figure.previousImage),
    `v1=${firstVersion} v2=${secondVersion} previous=${fig2?.figure?.previous} 图像变化=${fig2?.figure?.activeImage !== firstImage}`
  )
  const figureShot = await freshShot(win)
  const figureInk = measureInk(figureShot)
  writeFileSync(join(OUT_DIR, 'figure.png'), figureShot.toPNG())
  record(
    'G7-8 图表工作台截图非空',
    figureInk.ratio >= MIN_INK_RATIO,
    `非白像素 ${(figureInk.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="rollback"]')?.click()`)
  const rolledBack = await waitFor(
    win,
    `document.querySelector('.version-chip[data-active="true"]')?.getAttribute('data-version') === ${JSON.stringify(firstVersion)}`,
    15000
  )
  const fig3 = await win.webContents.executeJavaScript(`window.studio.workbench.state()`)
  record(
    'G7-8 回滚到第一版',
    rolledBack && fig3?.figure?.active === firstVersion,
    `回滚=${rolledBack} active=${fig3?.figure?.active} 期望=${firstVersion}`
  )

  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="score"]')?.click()`)
  const scoreOpen = await waitFor(win, `!!document.querySelector('[data-panel="score"]')`, 5000)
  const scoreInfo = await win.webContents.executeJavaScript(`({
    bars: document.querySelectorAll('[data-panel="score"] .score-row').length,
    total: document.querySelector('[data-role="score-total"]')?.textContent ?? '',
    verdict: document.querySelector('[data-role="score-verdict"]')?.textContent?.trim() ?? '',
    deductions: document.querySelectorAll('[data-panel="score"] .deduction').length
  })`)
  record(
    'G7-8 评分卡五维、总分 86 且达标',
    scoreOpen && scoreInfo.bars === 5 && scoreInfo.total.includes('86') && scoreInfo.verdict === '达标',
    `五维=${scoreInfo.bars} 总分文本=${JSON.stringify(scoreInfo.total)} 判定=${scoreInfo.verdict}`
  )

  await win.webContents.executeJavaScript(`document.querySelector('[data-panel="score"] .deduction')?.click()`)
  const detailOpen = await waitFor(win, `!!document.querySelector('[data-role="deduction-detail"]')`, 5000)
  const detail = await win.webContents.executeJavaScript(
    `document.querySelector('[data-role="deduction-detail"]')?.textContent ?? ''`
  )
  record(
    'G7-8 扣分项能定位到正文',
    detailOpen && detail.includes('定位：') && (detail.includes('摘要') || detail.includes('参数') || detail.includes('模型')),
    `明细=${JSON.stringify(detail.slice(0, 100))}`
  )
  const scoreShot = await freshShot(win)
  const scoreInk = measureInk(scoreShot)
  writeFileSync(join(OUT_DIR, 'score.png'), scoreShot.toPNG())
  record(
    'G7-8 评分卡截图非空',
    scoreInk.ratio >= MIN_INK_RATIO,
    `非白像素 ${(scoreInk.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )

  await win.webContents.executeJavaScript(`document.querySelector('.score-round[data-round="3"]')?.click()`)
  const breaker = await waitFor(
    win,
    `!!document.querySelector('.breaker-bar') && (document.querySelector('[data-role="score-total"]')?.textContent || '').includes('84')`,
    5000
  )
  record('G7-8 第三轮低于 85 显示熔断提示', breaker, `熔断条=${breaker}`)
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="veto"]')?.click()`)
  const veto = await waitFor(win, `!!document.querySelector('.veto-bar')`, 5000)
  record('G7-8 一票否决示例不进入循环', veto, `红线条=${veto}`)

  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="gate"]')?.click()`)
  const gateRows = await waitFor(win, `document.querySelectorAll('[data-gate-row]').length === 3`, 5000)
  const gateState = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-gate-row]')].map((n) => ({ id: n.dataset.gateRow, ok: n.classList.contains('gate-row--ok') }))`
  )
  record(
    'G7-8 门禁条三项全绿',
    gateRows && gateState.length === 3 && gateState.every((row) => row.ok),
    JSON.stringify(gateState)
  )

  // —— M2 回归：自由问答仍能流式出字并显示工具卡 ——
  await win.webContents.executeJavaScript(`document.querySelector('.mode-switch__btn[data-mode="chat"]')?.click()`)
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.composer__input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '用一句话说明模板清单怎么用。')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  await sleep(120)
  await win.webContents.executeJavaScript(`document.querySelector('.pill--send[data-mode="chat"]')?.click()`)

  const userVisible = await waitFor(
    win,
    `[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('模板清单怎么用'))`,
    5000
  )
  record('G7-5 用户消息进入对话流', userVisible, `找到用户气泡=${userVisible}`)

  const replied = await waitFor(
    win,
    `[...document.querySelectorAll('.msg--assistant .msg__text')].some((n) => n.textContent.includes('25 个模板'))`,
    20000
  )
  const toolDone = await waitFor(
    win,
    `document.querySelector('.tool-card[data-status="ok"]')?.getAttribute('data-tool') === 'list_templates'`,
    20000
  )
  const finished = await waitFor(win, `!document.querySelector('.pill--stop')`, 20000)

  const chat = await win.webContents.executeJavaScript(`({
    assistantText: [...document.querySelectorAll('.msg--assistant .msg__text')].map((n) => n.textContent).join('\\n'),
    thinkOpen: document.querySelector('.think')?.open ?? null,
    toolText: document.querySelector('.tool-card')?.textContent ?? '',
    toolStatus: document.querySelector('.tool-card')?.getAttribute('data-status') ?? null,
    toolName: document.querySelector('.tool-card')?.getAttribute('data-tool') ?? null,
    cursor: !!document.querySelector('.cursor'),
    sendText: document.querySelector('.pill--send')?.textContent?.trim() ?? '',
    sendDisabled: document.querySelector('.pill--send')?.disabled ?? null
  })`)

  record(
    'G7-5 思考过程默认折叠',
    chat.thinkOpen === false,
    `存在思考块=${chat.thinkOpen !== null}，默认展开=${chat.thinkOpen}`
  )
  record(
    'G7-5 工具卡完成并给出结构化结果',
    toolDone &&
      chat.toolStatus === 'ok' &&
      chat.toolName === 'list_templates' &&
      chat.toolText.includes('模板清单') &&
      chat.toolText.includes('25 个模板'),
    `status=${chat.toolStatus}，卡片文本 ${JSON.stringify(chat.toolText.slice(0, 120))}`
  )
  record(
    'G7-5 回复文本含模板总数',
    replied && chat.assistantText.includes('25 个模板'),
    `助手文本 ${JSON.stringify(chat.assistantText.slice(0, 160))}`
  )
  record(
    'G7-5 流结束后回到可发送状态',
    finished && !chat.cursor && chat.sendText === '发送' && chat.sendDisabled === false,
    `结束=${finished}，光标=${chat.cursor}，按钮=${JSON.stringify(chat.sendText)} disabled=${chat.sendDisabled}`
  )

  const convo = await win.webContents.capturePage()
  const convoShot = measureInk(convo)
  writeFileSync(join(OUT_DIR, 'conversation.png'), convo.toPNG())
  record(
    'G7-5 对话截图非空',
    convoShot.ratio >= MIN_INK_RATIO,
    `非白像素 ${(convoShot.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )

  // 结论落盘：CI 的通过与否由 scripts/check-window-smoke.mjs 读这份 JSON 判定，
  // 不依赖 Electron 的退出码管道——上一版就是 app.exit(1) 被生产入口的
  // window-all-closed → app.quit() 抢先，10/12 项通过却把 job 跑绿了。
  const summary = {
    ok: results.every((r) => r.ok),
    total: results.length,
    failed: results.filter((r) => !r.ok).length,
    contentSize: `${w}x${h}`,
    inkRatio: Number(shot.ratio.toFixed(4)),
    minInkRatio: MIN_INK_RATIO,
    url,
    results: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail }))
  }
  writeFileSync(join(OUT_DIR, 'window-smoke.json'), JSON.stringify(summary, null, 2) + '\n')
}

app
  .whenReady()
  .then(main)
  .then(async () => {
    const failed = results.filter((r) => !r.ok)
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}\n       ${r.detail}`)
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
    process.exitCode = failed.length === 0 ? 0 : 1
    await sleep(100)
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
    // 不关窗口：关掉会触发生产入口的 window-all-closed → app.quit()，把上面的退出码顶掉
    app.exit(failed.length === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(`FAIL 冒烟脚本自身异常: ${err && err.stack ? err.stack : err}`)
    try {
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(
        join(OUT_DIR, 'window-smoke.json'),
        JSON.stringify(
          {
            ok: false,
            total: results.length,
            failed: results.length + 1,
            error: String(err && err.message ? err.message : err)
          },
          null,
          2
        ) + '\n'
      )
    } catch {
      /* 落盘失败时仍然靠非零退出码变红 */
    }
    app.exit(1)
  })
