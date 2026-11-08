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
 *   9 内核路由：设置页不再暴露内核开关，离线演示始终可用（真实服务商由 runtime 自动走 DSH）
 *
 * 假 provider 只在本脚本进程里打开（MMS_FAKE_PROVIDER=1），不联网、不需要 Key；
 * 真实 DeepSeek/Kimi 需要用户自己的 Key，不能在这里代跑。
 * userData 指到临时目录，避免开发机上已有的 settings.json 改变默认选中项。
 *
 * 退出码：0 全部通过 / 1 任一断言失败 / 2 环境错误（没有构建产物或窗口没起来）
 */
const { app, BrowserWindow, Menu, safeStorage } = require('electron')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const OUT_DIR = process.env.SMOKE_OUT || 'screenshots'
const MIN_INK_RATIO = 0.01
const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 最小可用 PDF（含一行 Helvetica 文本），用来验证主进程的 pdfjs 抽取。
// 交叉引用表按实际偏移生成，不依赖任何外部工具。
function minimalPdf(text) {
  const objs = {}
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// 必须在 require 生产入口之前：主进程会在 whenReady 后按这份环境变量拉起 Python。
process.env.MMS_FAKE_PROVIDER = '1'
process.env.MMS_FAKE_DELAY_MS = process.env.MMS_FAKE_DELAY_MS || '20'

const userDataDir = mkdtempSync(join(tmpdir(), 'mms-g7-userdata-'))
app.setPath('userData', userDataDir)
// 工作区默认是桌面「赛题」；冒烟指到临时目录，不在真实桌面留目录。
process.env.MMS_WORKSPACE = join(userDataDir, 'workspace')

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
// Windows 上窗口被遮挡时 Chromium 会抛 UnknownVizError，属于合成器偶发失败，重试即可。
async function capture(win, tries = 4) {
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      win.show()
      win.focus()
      win.webContents.invalidate()
      await sleep(200)
      return await win.webContents.capturePage()
    } catch (err) {
      last = err
      await sleep(400)
    }
  }
  throw last
}

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
  await capture(win)
  await sleep(350)
  return capture(win)
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

  const img = await capture(win)
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
    icons: document.querySelectorAll('.workspace-icon').length,
    pane: Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0),
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

  record('G7-4 阶段轨道 7 节不因变阵卸载', dom.phases === 7, `实得 ${dom.phases}`)
  const appMenu = Menu.getApplicationMenu()
  record(
    'G7-4 Windows/Linux 不挂英文系统菜单',
    process.platform === 'darwin' || appMenu === null,
    `platform=${process.platform}，应用菜单=${appMenu === null ? 'null' : 'still set'}`
  )
  record(
    'G7-4 问答默认收起为 7 图标',
    dom.icons === 7 && dom.tabs === 0 && dom.pane <= 60,
    `icons=${dom.icons}，tabs=${dom.tabs}，pane=${dom.pane}`
  )
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

  // —— G7-4b 附件拖拽区：大框、拖拽高亮、暂存与移除 ——
  // 拖拽用合成 DataTransfer 触发真实的 dragenter/dragleave，验的是 React 侧的状态切换；
  // 暂存走 window.studio.files → preload → ipcMain → 磁盘，验的是整条落盘链路。
  const drop = await win.webContents.executeJavaScript(`(async () => {
    const area = document.querySelector('.chat__empty')
    const box = document.querySelector('.dropzone')
    if (!area || !box) return { found: false }
    const b = box.getBoundingClientRect()
    const p = box.querySelector('.dropzone__plus')?.getBoundingClientRect()
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const dt = new DataTransfer()
    dt.items.add(new File(['smoke'], 'problem.pdf', { type: 'application/pdf' }))
    area.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await frame()
    const active = document.querySelector('.dropzone')
    const dragOn = active?.dataset.drag === 'true'
    const borderStyle = getComputedStyle(active).borderStyle
    area.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await frame()
    return {
      found: true,
      hasPlus: Boolean(box.querySelector('.dropzone__plus svg path')),
      hitLabel: box.querySelector('.dropzone__hit')?.getAttribute('aria-label') || '',
      w: Math.round(b.width),
      h: Math.round(b.height),
      dx: p ? Math.round(Math.abs((p.left + p.right) / 2 - (b.left + b.right) / 2)) : -1,
      dragOn,
      borderStyle,
      dragCleared: document.querySelector('.dropzone')?.dataset.drag !== 'true'
    }
  })()`)
  record(
    'G7-4 空状态大框与加号居中',
    drop.found && drop.hasPlus && drop.hitLabel === '选择赛题或数据文件' && drop.w >= 560 && drop.h >= 280 && drop.dx <= 2,
    `框 ${drop.w}x${drop.h}，加号偏移 ${drop.dx}px，命中区=${JSON.stringify(drop.hitLabel)}`
  )
  record(
    'G7-4 拖入文件时大框高亮',
    drop.dragOn === true && drop.borderStyle === 'solid' && drop.dragCleared === true,
    `drag=${drop.dragOn}，边框=${drop.borderStyle}，离开后复位=${drop.dragCleared}`
  )

  const samplePath = join(userDataDir, 'sample-problem.txt')
  writeFileSync(samplePath, 'mock problem\n', 'utf8')

  // CDP 注入的是「带真实路径」的拖放：渲染层会走 webUtils.getPathForFile → IPC → 落盘，
  // 和用鼠标从资源管理器拖进来是同一条路径；合成 File 没有本地路径，验不到这一段。
  const dragPath = join(userDataDir, 'drag-problem.csv')
  writeFileSync(dragPath, 'x,y\n1,2\n', 'utf8')
  let dragUi = { ok: false, detail: 'CDP 不可用' }
  let filesUi = { ok: false, detail: '未执行' }
  try {
    const dbg = win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    const point = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.dropzone').getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    })()`)
    const data = { items: [], files: [dragPath], dragOperationsMask: 1 }
    const send = (type) =>
      dbg.sendCommand('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data })
    await send('dragEnter')
    await send('dragOver')
    await sleep(200)
    const hot = await win.webContents.executeJavaScript(
      `document.querySelector('.dropzone')?.dataset.drag === 'true'`
    )
    await send('drop')
    await sleep(900)
    const listed = await win.webContents.executeJavaScript(`({
      chips: [...document.querySelectorAll('.file-chip__name')].map((n) => n.textContent),
      foot: document.querySelector('.dropzone__foot')?.textContent?.trim() ?? ''
    })`)
    const stagedName = join(userDataDir, 'workspace', '附件')
    const landed = existsSync(stagedName) && readdirSync(stagedName, { recursive: true }).some(
      (p) => String(p).includes('drag-problem.csv')
    )
    const shot = await capture(win)
    writeFileSync(join(OUT_DIR, 'dropzone.png'), shot.toPNG())

    // 文件页：答辩模式默认收起，先用文件图标展开成标签态，后续 tab 用例在展开态继续。
    await win.webContents.executeJavaScript(
      `document.querySelector('.workspace-icon[data-tab="files"]')?.click()`
    )
    await sleep(260)
    const expandedTabs = await win.webContents.executeJavaScript(`({
      pane: Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0),
      tabs: document.querySelectorAll('.tab').length,
      stored: localStorage.getItem('mms.workspaceCollapsed.chat')
    })`)
    record(
      'G7-4 图标展开后 7 个标签',
      expandedTabs.pane > 100 && expandedTabs.tabs === 7 && expandedTabs.stored === '0',
      JSON.stringify(expandedTabs)
    )
    // 文件页：切过去应当看到工作区路径，并在列表里看到刚拖进来的文件；
    // 移除并刷新后，条目要跟着消失（列表读的是磁盘，不是缓存）。
    await win.webContents.executeJavaScript(
      `document.querySelector('.tab[data-tab="files"]')?.click()`
    )
    const sawFiles = await waitFor(
      win,
      `[...document.querySelectorAll('.file-row__name')].some((n) => n.textContent === 'drag-problem.csv')`,
      6000
    )
    const filesView = await win.webContents.executeJavaScript(`({
      path: document.querySelector('.files__path code')?.textContent?.trim() ?? '',
      names: [...document.querySelectorAll('.file-row__name')].map((n) => n.textContent),
      meta: document.querySelector('.panel[data-panel="files"] .panel__meta')?.textContent?.trim() ?? ''
    })`)
    const filesShot = await capture(win)
    writeFileSync(join(OUT_DIR, 'files.png'), filesShot.toPNG())

    await win.webContents.executeJavaScript(`document.querySelector('.file-chip__remove')?.click()`)
    await sleep(400)
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.files__actions .btn')].find((b) => b.textContent.trim() === '刷新')?.click()`
    )
    const rowGone = await waitFor(
      win,
      `![...document.querySelectorAll('.file-row__name')].some((n) => n.textContent === 'drag-problem.csv')`,
      6000
    )
    const filesOk =
      sawFiles &&
      rowGone &&
      filesView.path === join(userDataDir, 'workspace') &&
      filesView.meta.includes('1 个文件')
    filesUi = { ok: filesOk, detail: JSON.stringify({ sawFiles, rowGone, ...filesView }) }
    const gone = !readdirSync(stagedName, { recursive: true }).some((p) =>
      String(p).includes('drag-problem.csv')
    )
    const chipsAfter = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.file-chip').length`
    )
    dragUi = {
      ok:
        hot &&
        listed.chips.includes('drag-problem.csv') &&
        listed.foot.includes('已暂存 1 个文件') &&
        landed &&
        gone &&
        chipsAfter === 0,
      detail: JSON.stringify({ hot, ...listed, landed, gone, chipsAfter })
    }
    dbg.detach()
  } catch (err) {
    dragUi = { ok: false, detail: `CDP 拖放异常: ${err instanceof Error ? err.message : String(err)}` }
  }
  record('G7-4 真拖放走完暂存与移除', dragUi.ok, dragUi.detail)
  record('G7-4 文件页列出工作区文件', filesUi.ok, filesUi.detail)

  // —— G7-4c 直接放进工作区的文件：不经拖放也能发给模型，条目可拖、可右键 ——
  // 放到「文件页」断言之后再加，避免把上面 1 个文件的计数改掉。
  const directPath = join(userDataDir, 'workspace', 'direct-note.txt')
  writeFileSync(directPath, 'DIRECT-WORKSPACE-MARKER\n', 'utf8')
  // 走产品自己的刷新事件，不用按钮：按钮在读取期间是禁用的，点空会静默失效。
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('mms:workspace-changed'))`)
  const directListed = await waitFor(
    win,
    `[...document.querySelectorAll('.file-row__name')].some((n) => n.textContent === 'direct-note.txt')`,
    10000
  )
  const directDrag = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.file-row')].find((r) => r.querySelector('.file-row__name')?.textContent === 'direct-note.txt')
    if (!row) return { found: false }
    const dt = new DataTransfer()
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const types = Array.from(dt.types)
    const chat = document.querySelector('.chat')
    chat.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    chat.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await wait(60)
    const hot = chat.dataset.drag === 'true'
    chat.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    for (let i = 0; i < 40; i++) {
      await wait(100)
      if ([...document.querySelectorAll('.composer__attach .file-chip__name')].some((n) => n.textContent === 'direct-note.txt')) break
    }
    const chips = [...document.querySelectorAll('.composer__attach .file-chip__name')].map((n) => n.textContent)
    const disk = (await window.studio.workspace.get()).entries.map((entry) => entry.rel)
    return { found: true, types, hot, chips, disk }
  })()`)
  const directContext = await win.webContents.executeJavaScript(
    `window.studio.files.context([${JSON.stringify(directPath)}])`
  )
  record(
    'G7-4 工作区文件可拖进对话',
    Boolean(directListed) &&
      directDrag.found === true &&
      directDrag.types.includes('application/x-mms-workspace-files') &&
      directDrag.hot === true &&
      directDrag.chips.includes('direct-note.txt') &&
      String(directContext?.blocks?.[0]?.text ?? '').includes('DIRECT-WORKSPACE-MARKER'),
    JSON.stringify({ directListed, ...directDrag, block: directContext?.blocks?.[0] })
  )

  const menuProbe = await win.webContents.executeJavaScript(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const row = [...document.querySelectorAll('.file-row')].find((r) => r.querySelector('.file-row__name')?.textContent === 'direct-note.txt')
    if (!row) return { found: false }
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 780, clientY: 420 }))
    await frame()
    const items = [...document.querySelectorAll('.context-menu__item')].map((b) => b.textContent.trim())
    document.querySelector('.context-menu__item[data-danger="true"]')?.click()
    await frame()
    const armed = [...document.querySelectorAll('.context-menu__item')].map((b) => b.textContent.trim())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await frame()
    return { found: true, items, armed, closed: !document.querySelector('.context-menu') }
  })()`)
  record(
    'G7-4 文件条目右键菜单可控制',
    menuProbe.found === true &&
      ['添加到对话', '打开', '在文件夹中显示', '复制路径', '移到回收站'].every((label) =>
        menuProbe.items.includes(label)
      ) &&
      menuProbe.armed.includes('确认移到回收站') &&
      menuProbe.closed === true,
    JSON.stringify(menuProbe)
  )

  // 工作区原文件只是图钉，不该被「移除」删掉；删文件只能走右键并二次确认。
  await win.webContents.executeJavaScript(
    `document.querySelector('.composer__attach .file-chip__remove')?.click()`
  )
  await sleep(400)
  const directGone = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.composer__attach .file-chip').length`
  )
  record(
    'G7-4 工作区原件移除后不删',
    directGone === 0 && existsSync(directPath),
    `剩余胶囊=${directGone}，原文件还在=${existsSync(directPath)}`
  )
  // 这条是探针自己的文件，断言完就收走，别影响后面用工作区的用例。
  rmSync(directPath, { force: true })


  // 默认工作区是桌面的「赛题」；冒烟用 MMS_WORKSPACE 指走，所以这里只核对默认路径的形状。
  const wsInfo = await win.webContents.executeJavaScript(`window.studio.workspace.get()`)
  record(
    'G7-4 默认工作区在桌面「赛题」',
    Boolean(wsInfo?.info) &&
      String(wsInfo.info.defaultPath).endsWith('赛题') &&
      wsInfo.info.path === join(userDataDir, 'workspace') &&
      wsInfo.info.isDefault === false,
    `path=${wsInfo?.info?.path}，default=${wsInfo?.info?.defaultPath}`
  )

  const staged = await win.webContents.executeJavaScript(
    `window.studio.files.stage([${JSON.stringify(samplePath)}])`
  )
  const stagedFile = staged && staged.ok && staged.files && staged.files[0]
  const stagedOnDisk = stagedFile ? existsSync(stagedFile.path) : false
  const stagedInside = stagedFile
    ? stagedFile.path.startsWith(join(userDataDir, 'workspace', '附件'))
    : false
  const stagedBody = stagedOnDisk ? readFileSync(stagedFile.path, 'utf8') : ''
  record(
    'G7-4 附件暂存到工作区',
    Boolean(stagedFile) &&
      stagedFile.name === 'sample-problem.txt' &&
      stagedFile.kind === 'text' &&
      stagedFile.size === 13 &&
      stagedInside &&
      stagedOnDisk &&
      stagedBody === 'mock problem\n',
    `落盘=${stagedInside && stagedOnDisk}，内容=${JSON.stringify(stagedBody)}，路径=${stagedFile?.path ?? '无'}`
  )

  const badStage = await win.webContents.executeJavaScript(
    `window.studio.files.stage([${JSON.stringify(join(userDataDir, 'missing', 'nope.csv'))}])`
  )
  record(
    'G7-4 坏文件给出可读原因',
    Boolean(badStage) &&
      badStage.files.length === 0 &&
      badStage.rejected.length === 1 &&
      typeof badStage.rejected[0].reason === 'string' &&
      badStage.rejected[0].reason.length > 0,
    `rejected=${JSON.stringify(badStage?.rejected)}`
  )

  await win.webContents.executeJavaScript(
    `window.studio.files.discard(${JSON.stringify(stagedFile ? stagedFile.path : '')})`
  )
  record(
    'G7-4 移除只删暂存副本',
    Boolean(stagedFile) && !existsSync(stagedFile.path) && existsSync(samplePath),
    `副本还在=${stagedFile ? existsSync(stagedFile.path) : '无副本'}，原文件还在=${existsSync(samplePath)}`
  )

  // —— 截图与剪贴板：输入区不再常驻附件按钮，粘贴的字节由主进程写进暂存区 ——
  const pasteProbe = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const area = document.querySelector('.composer__input')
    if (!area) return { ok: false, reason: '没有输入框' }
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'image.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    for (let i = 0; i < 60; i++) {
      await wait(100)
      if (document.querySelectorAll('.composer__attach .file-chip').length > 0) break
    }
    const chips = Array.from(document.querySelectorAll('.composer__attach .file-chip__name')).map((el) => el.textContent)
    const listing = await window.studio.workspace.get()
    const landed = listing.entries.filter((entry) => entry.kind === 'image' && entry.name.startsWith('截图'))
    const addButton = Boolean(document.querySelector('.composer__add'))
    document.querySelector('.composer__attach .file-chip__remove')?.click()
    await wait(400)
    const afterRemove = document.querySelectorAll('.composer__attach .file-chip').length
    return { chips, landed: landed.map((entry) => entry.name), addButton, afterRemove }
  })()`)
  record(
    'G7-4 粘贴截图进输入区并落盘',
    Boolean(pasteProbe) &&
      pasteProbe.chips?.length === 1 &&
      /^截图-\d{8}-\d{6}\.png$/.test(pasteProbe.chips[0]) &&
      pasteProbe.landed?.length === 1 &&
      pasteProbe.afterRemove === 0,
    JSON.stringify(pasteProbe)
  )
  record(
    'G7-4 输入区不常驻附件按钮',
    pasteProbe?.addButton === false,
    `composer__add=${pasteProbe?.addButton}`
  )

  // —— 附件正文抽取：PDF 走主进程里的 pdfjs，CSV 顺带算出总行数与列数 ——
  const pdfSrc = join(userDataDir, 'probe.pdf')
  writeFileSync(pdfSrc, minimalPdf('ATTACH-MARKER-2026'))
  const csvSrc = join(userDataDir, 'probe.csv')
  writeFileSync(csvSrc, 'month,sales\n2026-01,120\n2026-02,138\n', 'utf8')
  const extract = await win.webContents.executeJavaScript(`(async () => {
    const staged = await window.studio.files.stage([${JSON.stringify(pdfSrc)}, ${JSON.stringify(csvSrc)}])
    const context = await window.studio.files.context(staged.files.map((f) => f.path))
    await Promise.all(staged.files.map((f) => window.studio.files.discard(f.path)))
    return context
  })()`)
  const pdfBlock = extract?.blocks?.find((block) => block.name === 'probe.pdf')
  const csvBlock = extract?.blocks?.find((block) => block.name === 'probe.csv')
  record(
    'G7-4 附件正文抽取（PDF/CSV）',
    Boolean(pdfBlock) &&
      Boolean(csvBlock) &&
      pdfBlock.text.includes('ATTACH-MARKER-2026') &&
      String(pdfBlock.note).includes('1 页') &&
      csvBlock.text.includes('2026-01,120') &&
      String(csvBlock.note).includes('2 行 × 2 列'),
    JSON.stringify({
      pdf: { note: pdfBlock?.note, text: pdfBlock?.text?.slice(0, 40) },
      csv: { note: csvBlock?.note, text: csvBlock?.text?.slice(0, 30) }
    })
  )

  const outsidePath = join(userDataDir, 'outside.txt')
  writeFileSync(outsidePath, 'outside workspace\n', 'utf8')
  const guard = await win.webContents.executeJavaScript(`(async () => {
    try {
      await window.studio.files.context([${JSON.stringify(outsidePath)}])
      return 'allowed'
    } catch (err) {
      return String(err && err.message ? err.message : err)
    }
  })()`)
  record('G7-4 只读取工作区里的文件', String(guard).includes('工作区'), String(guard))

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
  record(
    'G7-6 设置页含四家预设与 OpenAI 格式',
    ['DeepSeek', '通义千问', 'Kimi', '智谱 GLM', 'OpenAI 格式'].every((name) =>
      settings.chips.some((chip) => chip.includes(name))
    ),
    `chips=${JSON.stringify(settings.chips)}`
  )

  const presetModels = await win.webContents.executeJavaScript(`(async () => {
    const click = (name) => {
      [...document.querySelectorAll('.provider-chip')].find((b) => b.textContent.includes(name))?.click()
    }
    const wait = () => new Promise((resolve) => setTimeout(resolve, 90))
    const out = { models: {} }
    for (const name of ['通义千问', 'Kimi', '智谱 GLM']) {
      click(name)
      await wait()
      out.models[name] = [...document.querySelectorAll('.model-chip')].map((b) => b.textContent.trim())
    }
    click('OpenAI 格式')
    await wait()
    out.openai = {
      base: !!document.querySelector('.settings__body input[placeholder^="https://example"]'),
      toggle: !!document.querySelector('.field--check input[type="checkbox"]'),
      models: document.querySelectorAll('.model-chip').length
    }
    return out
  })()`)
  record(
    'G7-6 四家预设模型名来自官方文档',
    presetModels.models['通义千问']?.includes('qwen3.8-max') &&
      presetModels.models['Kimi']?.includes('kimi-k3.1-pro') &&
      presetModels.models['智谱 GLM']?.includes('glm-5.3'),
    JSON.stringify(presetModels.models)
  )
  record(
    'G7-6 OpenAI 格式可填端点与开关',
    presetModels.openai.base && presetModels.openai.toggle && presetModels.openai.models === 0,
    JSON.stringify(presetModels.openai)
  )

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.provider-chip')].find((b) => b.textContent.includes('DeepSeek'))?.click()`
  )
  await sleep(150)
  const tuning = await win.webContents.executeJavaScript(`({
    context: [...document.querySelectorAll('.seg__btn[data-value]')].filter((b) => ['200000','400000','1000000'].includes(b.dataset.value)).length,
    depth: [...document.querySelectorAll('.seg__btn[data-value]')].filter((b) => ['medium','high','max'].includes(b.dataset.value)).length,
    models: [...document.querySelectorAll('.model-chip')].map((b) => b.textContent.trim()),
    modelInput: document.querySelector('.settings input')?.value ?? ''
  })`)
  record(
    'G7-6 预设模型与上下文/深度选择器',
    tuning.context === 3 &&
      tuning.depth === 3 &&
      tuning.models.includes('deepseek-flash') &&
      tuning.modelInput.length > 0,
    JSON.stringify(tuning)
  )
  await win.webContents.executeJavaScript(`
    document.querySelector('.seg__btn[data-value="400000"]')?.click()
    document.querySelector('.seg__btn[data-value="max"]')?.click()
  `)
  await sleep(150)
  const pickedTuning = await win.webContents.executeJavaScript(`({
    context: document.querySelector('.seg__btn[data-value="400000"]')?.getAttribute('aria-pressed'),
    depth: document.querySelector('.seg__btn[data-value="max"]')?.getAttribute('aria-pressed')
  })`)
  record(
    'G7-6 上下文与深度可切换',
    pickedTuning.context === 'true' && pickedTuning.depth === 'true',
    JSON.stringify(pickedTuning)
  )
  writeFileSync(join(OUT_DIR, 'settings.png'), (await capture(win)).toPNG())
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
  let disk = { exists: false, hasPlain: false, hasKey: false, context400: false, depthMax: false }
  try {
    const raw = readFileSync(settingsPath, 'utf8')
    disk = {
      exists: true,
      hasPlain: raw.includes(sentinel),
      hasKey: /"key"\s*:\s*"[A-Za-z0-9+/=]{16,}"/.test(raw),
      context400: /"context"\s*:\s*400000/.test(raw),
      depthMax: /"depth"\s*:\s*"max"/.test(raw)
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
  record(
    'G7-6 上下文与深度随设置落盘',
    !encryptionAvailable || (disk.exists && disk.context400 && disk.depthMax),
    `context400=${disk.context400}，depthMax=${disk.depthMax}，safeStorage 可用=${encryptionAvailable}`
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

  // —— 内核：界面不再暴露开关，离线演示始终可用 ——
  // 真实服务商由 runtime 自动路由到 DSH；离线演示固定走 python。这里验设置页没有开关、
  // 离线演示没有被摘掉，避免运行时网关把「没有 Key 的用户」挡在门外。
  await win.webContents.executeJavaScript(`document.querySelector('.pill--model')?.click()`)
  await sleep(250)
  const coreUi = await win.webContents.executeJavaScript(`({
    switchButtons: [...document.querySelectorAll('.settings .seg__btn[data-value="python"], .settings .seg__btn[data-value="dsh"]')].length,
    hasCoreLabel: (document.querySelector('.settings')?.textContent || '').includes('对话内核'),
    fakeChip: [...document.querySelectorAll('.settings .provider-chip')].find((b) => b.textContent.includes('离线演示'))?.disabled ?? null
  })`)
  record(
    'G7-11 设置页不再出现内核开关',
    coreUi.switchButtons === 0 && !coreUi.hasCoreLabel,
    JSON.stringify(coreUi)
  )
  const routed = await win.webContents.executeJavaScript(`(async () => {
    const list = await window.studio.providers.list()
    return { hasFake: Boolean(list.providers.find((p) => p.id === 'fake')), active: list.activeProvider }
  })()`)
  record(
    'G7-11 离线演示始终可用',
    routed.hasFake && coreUi.fakeChip !== true && routed.active === 'fake',
    `list=${JSON.stringify(routed)} chipDisabled=${coreUi.fakeChip}`
  )
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.settings .btn')].find((b) => b.textContent.trim() === '取消')?.click()`
  )
  await sleep(200)

  // —— M3：从赛题到选模卡，再到持久化恢复 ——
  // 现在默认是自由对话；用「全流程建模」按钮显式进入建模模式。
  const defaultMode = await win.webContents.executeJavaScript(`({
    label: document.querySelector('.mode-switch__btn')?.textContent.trim(),
    pressed: document.querySelector('.mode-switch__btn')?.getAttribute('aria-pressed')
  })`)
  record(
    'G7-7 默认进入自由对话',
    defaultMode.label === '全流程建模' && defaultMode.pressed === 'false',
    JSON.stringify(defaultMode)
  )
  await win.webContents.executeJavaScript(`document.querySelector('.mode-switch__btn[data-mode="workflow"]')?.click()`)
  await sleep(200)
  const workflowMode = await win.webContents.executeJavaScript(`({
    label: document.querySelector('.mode-switch__btn')?.textContent.trim(),
    pressed: document.querySelector('.mode-switch__btn')?.getAttribute('aria-pressed')
  })`)
  record(
    'G7-7 全流程建模按钮激活建模模式',
    workflowMode.label === '退出全流程' && workflowMode.pressed === 'true',
    JSON.stringify(workflowMode)
  )

  // 把一份 PDF 留在输入区，验证附件跟 K2 一起送给模型
  const k2Pdf = join(userDataDir, 'k2-problem.pdf')
  writeFileSync(k2Pdf, minimalPdf('K2-PDF-MARKER-88'))
  try {
    const dbg = win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    const point = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.dropzone')?.getBoundingClientRect()
      return b ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } : null
    })()`)
    const data = { items: [], files: [k2Pdf], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await dbg.sendCommand('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data })
    }
    await waitFor(
      win,
      `[...document.querySelectorAll('.file-chip__name')].some((n) => n.textContent === 'k2-problem.pdf')`,
      6000
    )
    dbg.detach()
  } catch (err) {
    console.log(`[附件预置失败] ${err instanceof Error ? err.message : String(err)}`)
  }

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

  // —— G7-14 按赛题分项目文件夹：建目录 + 暂存附件收编 ——
  const wsRoot = join(userDataDir, 'workspace')
  const projectDirs = (() => {
    try {
      return readdirSync(wsRoot, { withFileTypes: true })
        .filter(
          (item) =>
            item.isDirectory() &&
            !['附件', '图表', '论文', '代码'].includes(item.name) &&
            !item.name.startsWith('.')
        )
        .map((item) => item.name)
    } catch {
      return []
    }
  })()
  const projectName = projectDirs.find(
    (name) => /-[0-9a-f]{4}$/.test(name) && name.includes('问题1')
  )
  const projectPath = projectName ? join(wsRoot, projectName) : ''
  const projectShape =
    Boolean(projectPath) &&
    ['附件', '图表', '论文', '代码'].every((sub) => existsSync(join(projectPath, sub)))
  record(
    'G7-14 建模会话建出赛题文件夹',
    projectShape,
    `dirs=${JSON.stringify(projectDirs)}`
  )
  const adopted = projectPath
    ? readdirSync(join(projectPath, '附件')).some((name) => name.includes('k2-problem'))
    : false
  record(
    'G7-14 暂存附件收进项目附件目录',
    adopted,
    `附件=${projectPath ? JSON.stringify(readdirSync(join(projectPath, '附件'))) : '无项目目录'}`
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

  const k2Attach = await win.webContents.executeJavaScript(`({
    chips: [...document.querySelectorAll('.msg--user .file-chip__name')].map((n) => n.textContent),
    userText: document.querySelector('.msg--user .msg__text')?.textContent ?? '',
    cardText: document.querySelector('.decision[data-card="problem-confirm"]')?.textContent ?? ''
  })`)
  const k2Stored = await win.webContents.executeJavaScript(`window.studio.session.latest()`)
  const storedProblem = String(k2Stored?.session?.problem ?? '')
  const attachShot = await capture(win)
  writeFileSync(join(OUT_DIR, 'attachments.png'), attachShot.toPNG())
  record(
    'G7-7 附件随消息送给模型',
    k2Attach.chips.includes('k2-problem.pdf') &&
      k2Attach.userText.includes('问题1 预测未来三个月的销量') &&
      !k2Attach.userText.includes('K2-PDF-MARKER') &&
      k2Attach.cardText.includes('附件：1 个') &&
      storedProblem.includes('K2-PDF-MARKER-88'),
    `chips=${JSON.stringify(k2Attach.chips)}，卡片含附件=${k2Attach.cardText.includes('附件：1 个')}，题面含正文=${storedProblem.includes('K2-PDF-MARKER-88')}`
  )

  // 刷新页面（等价关窗重开）后：附件胶囊要还原，正文不能铺进气泡。
  await win.webContents.reload()
  const restoredK2 = await waitFor(
    win,
    `!!document.querySelector('.decision[data-card="problem-confirm"]')`,
    20000
  )
  const restoredMsg = await win.webContents.executeJavaScript(`({
    chips: [...document.querySelectorAll('.msg--user .file-chip__name')].map((n) => n.textContent),
    userText: document.querySelector('.msg--user .msg__text')?.textContent ?? ''
  })`)
  record(
    'G7-7 重开后附件还原且不铺正文',
    restoredK2 &&
      restoredMsg.chips.includes('k2-problem.pdf') &&
      restoredMsg.userText.includes('问题1 预测未来三个月的销量') &&
      !restoredMsg.userText.includes('K2-PDF-MARKER'),
    JSON.stringify(restoredMsg)
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
  const drawerShot = await capture(win)
  const drawerInk = measureInk(drawerShot)
  writeFileSync(join(OUT_DIR, 'drawer.png'), drawerShot.toPNG())
  record(
    'G7-7 解释抽屉截图非空',
    drawerInk.ratio >= MIN_INK_RATIO,
    `非白像素 ${(drawerInk.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="close-drawer"]')?.click()`)
  // 抽屉常挂载：关闭 = 元素还在但 data-open=false 且视觉隐藏
  const drawerClosed = await waitFor(
    win,
    `(() => {
      const d = document.querySelector('.drawer')
      return !!d && d.dataset.open === 'false' && getComputedStyle(d).visibility === 'hidden'
    })()`,
    5000
  )
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
  const decisionShot = await capture(win)
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
      snapChosen?.session?.pending === null,
    `阶段3=${phaseChosen.p3} 阶段4=${phaseChosen.p4} pending=${snapChosen?.session?.pending} 停止键=${phaseChosen.stop}`
  )
  record(
    'G7-7 已选卡的动作按钮已禁用',
    phaseChosen.actions.length > 0 && phaseChosen.actions.every((b) => b.disabled),
    `动作按钮 ${JSON.stringify(phaseChosen.actions)}`
  )

  // —— M4：工作台图表、主题、回滚、评分与门禁 ——
  // 前面的文件页检查会把右栏留在「文件」，这里显式切回「图表」。
  await win.webContents.executeJavaScript(
    `document.querySelector('.tab[data-tab="figure"]')?.click()`
  )
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
  // 阶段四会先自动登记图表版本，这里不能假设初始版本号是 1 或 0。
  const firstCount = figState?.figure?.versions?.length ?? 0
  record(
    'G7-8 工作台渲染出首版图表',
    figureReady && Boolean(firstVersion) && firstCount >= 1,
    `图片就绪=${figureReady} active=${firstVersion} 版本数=${firstCount}`
  )

  // 主题选择器是自绘下拉（弹层用圆角卡片，原生 select 的方角弹层改不到），按按钮 → 选项两步点
  await win.webContents.executeJavaScript(`document.querySelector('[data-role="figure-theme"]')?.click()`)
  await sleep(200)
  const themePicked = await win.webContents.executeJavaScript(`(() => {
    const option = document.querySelector('[data-role="figure-theme-menu"] [data-value="studio-ink"]')
    if (!option) return false
    option.click()
    return true
  })()`)
  record('G7-8 主题下拉可选到 studio-ink', themePicked, `弹层选项命中=${themePicked}`)
  await sleep(120)
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="render-figure"]')?.click()`)
  const reRendered = await waitFor(
    win,
    `(async () => {
      if (document.querySelectorAll('.version-chip').length < ${firstCount + 1}) return false
      if (document.querySelector('[data-role="figure-diff"]')) return false
      if (document.querySelectorAll('[data-role="figure-image"]').length !== 1) return false
      if (!(document.querySelector('[data-role="figure-image"]')?.naturalWidth > 0)) return false
      const next = await window.studio.workbench.state()
      return next.figure.active !== ${JSON.stringify(firstVersion)}
    })()`,
    90000
  )
  const fig2 = await win.webContents.executeJavaScript(`window.studio.workbench.state()`)
  const secondVersion = fig2?.figure?.active
  record(
    'G7-8 换主题重渲出第二版，只显示当前图',
    reRendered &&
      Boolean(secondVersion) &&
      secondVersion !== firstVersion &&
      fig2.figure.previous === firstVersion &&
      fig2.figure.activeImage !== firstImage,
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

  await win.webContents.executeJavaScript(
    `document.querySelector('.version-chip[data-version=${JSON.stringify(firstVersion)}]')?.click()`
  )
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

  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="paper"]')?.click()`)
  const paperOpen = await waitFor(win, `!!document.querySelector('[data-panel="paper"]')`, 5000)
  const paperLead = await win.webContents.executeJavaScript(`({
    button: !!document.querySelector('[data-action="build-paper"]'),
    disabled: document.querySelector('[data-action="build-paper"]')?.disabled ?? null,
    envError: document.querySelector('[data-panel="paper"] .panel__error')?.textContent ?? ''
  })`)
  record(
    'G7-9 论文页打开且构建按钮可用',
    paperOpen && paperLead.button && paperLead.disabled === false,
    `按钮=${paperLead.button} 禁用=${paperLead.disabled} 缺件提示=${JSON.stringify(paperLead.envError)}`
  )

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="build-paper"]')?.click()`)
  const paperSteps = await waitFor(
    win,
    `document.querySelectorAll('[data-role="paper-steps"] li').length >= 6 && document.querySelectorAll('[data-role="paper-gates"] .paper-gate').length === 3`,
    240000
  )
  const paperState = await win.webContents.executeJavaScript(`window.studio.workbench.state()`)
  const paper = paperState?.paper ?? {}
  record(
    'G7-9 论文构建出 PDF 与 DOCX',
    paperSteps && paper.ok === true && Boolean(paper.artifacts?.pdf) && Boolean(paper.artifacts?.docx),
    `步骤=${paperSteps} ok=${paper.ok} artifacts=${Object.keys(paper.artifacts ?? {})} error=${paper.error}`
  )
  const paperGates = paper.gates ?? []
  record(
    'G7-9 去 AI 与章节门禁全绿',
    paperGates.length === 3 && paperGates.every((row) => row.ok),
    JSON.stringify(paperGates.map((row) => [row.id, row.ok, row.detail]))
  )
  const preview = await waitFor(
    win,
    `(() => { const c = document.querySelector('[data-role="paper-preview"] canvas'); return !!c && c.width > 200 && c.height > 200 })()`,
    30000
  )
  const paperShot = await freshShot(win)
  const paperInk = measureInk(paperShot)
  writeFileSync(join(OUT_DIR, 'paper.png'), paperShot.toPNG())
  record(
    'G7-9 论文 PDF 预览渲染且截图非空',
    preview && paperInk.ratio >= MIN_INK_RATIO,
    `画布=${preview} 非白像素 ${(paperInk.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
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
  const gateRows = await waitFor(win, `document.querySelectorAll('[data-gate-row]').length === 4`, 5000)
  const gateState = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-gate-row]')].map((n) => ({ id: n.dataset.gateRow, ok: n.classList.contains('gate-row--ok') }))`
  )
  record(
    'G7-8 门禁条四项全绿',
    gateRows && gateState.length === 4 && gateState.every((row) => row.ok),
    JSON.stringify(gateState)
  )
  const headGate = await win.webContents.executeJavaScript(`({
    text: document.querySelector('.gate-summary')?.textContent ?? '',
    dots: document.querySelectorAll('.gate-summary__dot').length
  })`)
  record(
    'G7-8 门禁摘要并入栏头',
    headGate.dots === 4 && headGate.text.includes('4/4'),
    JSON.stringify(headGate)
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
    `!!document.querySelector('.tool-card[data-tool="list_templates"][data-status="ok"]')`,
    20000
  )
  const finished = await waitFor(win, `!document.querySelector('.pill--stop')`, 20000)

  const chat = await win.webContents.executeJavaScript(`({
    assistantText: [...document.querySelectorAll('.msg--assistant .msg__text')].map((n) => n.textContent).join('\\n'),
    thinkOpen: document.querySelector('.think')?.open ?? null,
    toolText: document.querySelector('.tool-card[data-tool="list_templates"]')?.textContent ?? '',
    toolStatus: document.querySelector('.tool-card[data-tool="list_templates"]')?.getAttribute('data-status') ?? null,
    toolName: document.querySelector('.tool-card[data-tool="list_templates"]')?.getAttribute('data-tool') ?? null,
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

  const convo = await capture(win)
  const convoShot = measureInk(convo)
  writeFileSync(join(OUT_DIR, 'conversation.png'), convo.toPNG())
  record(
    'G7-5 对话截图非空',
    convoShot.ratio >= MIN_INK_RATIO,
    `非白像素 ${(convoShot.ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`
  )

  // —— 多对话：历史列表、切换与删除 ——
  const convState = await win.webContents.executeJavaScript(`({
    newButton: !!document.querySelector('[data-action="new-chat"]'),
    items: [...document.querySelectorAll('.conv')].map((n) => ({
      kind: n.dataset.kind,
      title: n.querySelector('.conv__title')?.textContent ?? ''
    }))
  })`)
  record(
    'G7-7 问答会话进入历史列表',
    convState.newButton && convState.items.some((item) => item.kind === 'chat'),
    JSON.stringify(convState.items)
  )

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="new-chat"]')?.click()`)
  const cleared = await waitFor(
    win,
    `document.querySelectorAll('.msg').length === 0 && (document.querySelector('.chat__head-title')?.textContent || '').includes('新对话')`,
    5000
  )
  record('G7-7 新对话清空当前消息', cleared, `清空=${cleared}`)

  await win.webContents.executeJavaScript(
    `document.querySelector('.conv[data-kind="chat"] .conv__main')?.click()`
  )
  const restoredChat = await waitFor(
    win,
    `[...document.querySelectorAll('.msg--user')].some((n) => n.textContent.includes('模板清单怎么用'))`,
    5000
  )
  record('G7-7 切换历史会话恢复消息', restoredChat, `恢复=${restoredChat}`)

  await win.webContents.executeJavaScript(
    `document.querySelector('.conv[data-kind="chat"] .conv__del')?.click()`
  )
  await sleep(180)
  const armed = await win.webContents.executeJavaScript(
    `document.querySelector('.conv[data-kind="chat"] .conv__del')?.dataset.confirm === 'true'`
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('.conv[data-kind="chat"] .conv__del')?.click()`
  )
  const removedChat = await waitFor(
    win,
    `document.querySelectorAll('.conv[data-kind="chat"]').length === 0`,
    5000
  )
  record('G7-7 删除历史会话', armed && removedChat, `二次确认=${armed}，删除=${removedChat}`)

  // —— 布局：宽屏比例与两处分隔条 ——
  // 量的是展开态宽度：当前 prefs 可能停在收起，先显式展开。
  await win.webContents.executeJavaScript(`(() => {
    const width = Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0)
    if (width > 60) return 'already'
    const icon = document.querySelector('.workspace-icon[data-tab="files"]') ?? document.querySelector('.workspace-icon')
    icon?.click()
    return 'reopened'
  })()`)
  await sleep(260)
  win.setContentSize(2400, 1200)
  await waitFor(
    win,
    `Math.round(document.querySelector('.workspace').getBoundingClientRect().width) > 800`,
    5000
  )
  await sleep(250)
  const wide = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.workspace').getBoundingClientRect()
    const chat = document.querySelector('.chat').getBoundingClientRect()
    const rail = document.querySelector('.rail').getBoundingClientRect()
    const shell = getComputedStyle(document.querySelector('.shell'))
    return {
      inner: innerWidth,
      pane: Math.round(pane.width),
      chat: Math.round(chat.width),
      rail: Math.round(rail.width),
      paneVar: shell.getPropertyValue('--pane-w').trim(),
      railVar: shell.getPropertyValue('--rail-w').trim(),
      storedPane: localStorage.getItem('mms.paneWidth'),
      storedRail: localStorage.getItem('mms.railWidth')
    }
  })()`)
  record(
    'G7-10 宽屏右栏按比例放宽',
    wide.inner >= 2200 && wide.pane > 800 && wide.chat > 600,
    JSON.stringify(wide)
  )

  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="paper"]')?.click()`)
  const paperWide = await waitFor(
    win,
    `(() => {
      const l = document.querySelector('[data-panel="paper"] .paper-layout')
      return !!l && getComputedStyle(l).gridTemplateColumns.split(' ').length === 2
    })()`,
    5000
  )
  const paperWideInfo = await win.webContents.executeJavaScript(`(() => {
    const l = document.querySelector('[data-panel="paper"] .paper-layout')
    const preview = document.querySelector('[data-panel="paper"] .paper-preview')
    const side = document.querySelector('[data-panel="paper"] .paper-layout__side')
    return {
      columns: getComputedStyle(l).gridTemplateColumns,
      preview: Math.round(preview.getBoundingClientRect().width),
      side: Math.round(side.getBoundingClientRect().width)
    }
  })()`)
  record(
    'G7-10 宽屏论文页两栏且预览限宽',
    paperWide && paperWideInfo.preview <= 700 && paperWideInfo.side >= 250,
    JSON.stringify(paperWideInfo)
  )

  await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="score"]')?.click()`)
  const scoreWide = await waitFor(
    win,
    `(() => {
      const l = document.querySelector('[data-panel="score"] .score-layout')
      return !!l && getComputedStyle(l).gridTemplateColumns.split(' ').length === 2
    })()`,
    5000
  )
  const scoreWideInfo = await win.webContents.executeJavaScript(`(() => {
    const l = document.querySelector('[data-panel="score"] .score-layout')
    const main = document.querySelector('[data-panel="score"] .score-layout__main')
    const side = document.querySelector('[data-panel="score"] .score-layout__side')
    return {
      columns: getComputedStyle(l).gridTemplateColumns,
      main: Math.round(main.getBoundingClientRect().width),
      side: Math.round(side.getBoundingClientRect().width)
    }
  })()`)
  record(
    'G7-10 宽屏评分页两栏',
    scoreWide && scoreWideInfo.main >= 250 && scoreWideInfo.side >= 300,
    JSON.stringify(scoreWideInfo)
  )

  const grip = await win.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('[data-splitter="pane"]')
    const r = s.getBoundingClientRect()
    s.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 4, clientY: r.top + 300, pointerId: 3 }))
    const after = getComputedStyle(s, '::after')
    return {
      variable: s.style.getPropertyValue('--grip-y').trim(),
      mask: after.webkitMaskImage || after.maskImage,
      height: Math.round(r.height),
      afterHeight: after.height
    }
  })()`)
  record(
    'G7-10 握把高亮跟随指针',
    grip.variable === '300px' &&
      grip.mask.includes('300px') &&
      parseFloat(grip.afterHeight) > 600 &&
      grip.height > 600,
    JSON.stringify(grip)
  )

  const dragSplitter = (selector, dx, dy) =>
    win.webContents.executeJavaScript(`(() => {
      const s = document.querySelector(${JSON.stringify(selector)})
      const r = s.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + Math.min(120, r.height / 2)
      s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 11 }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + ${dx}, clientY: y + ${dy}, pointerId: 11 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + ${dx}, clientY: y + ${dy}, pointerId: 11 }))
      return true
    })()`)

  const railState = await win.webContents.executeJavaScript(`({
    splitter: !!document.querySelector('[data-splitter="rail"]'),
    width: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
    stored: localStorage.getItem('mms.railWidth')
  })`)
  record(
    'G7-10 左栏固定不可拖拽',
    railState.splitter === false && railState.width === 240 && railState.stored === null,
    JSON.stringify(railState)
  )

  const paneBefore = wide.pane
  await dragSplitter('[data-splitter="pane"]', -140, 0)
  await sleep(300)
  const paneAfter = await win.webContents.executeJavaScript(
    `Math.round(document.querySelector('.workspace').getBoundingClientRect().width)`
  )
  record(
    'G7-10 中/右分隔条可拖拽',
    paneAfter - paneBefore >= 100,
    `${paneBefore} → ${paneAfter}`
  )

  const gripStay = await win.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('[data-splitter="pane"]')
    const after = () => getComputedStyle(s, '::after')
    const before = s.style.getPropertyValue('--grip-y').trim()
    const maskBefore = after().webkitMaskImage || after().maskImage
    s.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerId: 11 }))
    return {
      before,
      maskBefore,
      after: s.style.getPropertyValue('--grip-y').trim(),
      maskAfter: after().webkitMaskImage || after().maskImage
    }
  })()`)
  record(
    'G7-10 离开分隔条后握把保持在指针处',
    gripStay.before !== '' &&
      gripStay.after === gripStay.before &&
      gripStay.maskAfter === gripStay.maskBefore &&
      gripStay.maskBefore.includes(gripStay.before),
    JSON.stringify(gripStay)
  )

  const composerBefore = await win.webContents.executeJavaScript(
    `Math.round(document.querySelector('.chat__composer').getBoundingClientRect().height)`
  )
  const barBefore = await win.webContents.executeJavaScript(
    `Math.round(document.querySelector('.composer__bar').getBoundingClientRect().top)`
  )
  await dragSplitter('[data-splitter="composer"]', 0, -90)
  await sleep(300)
  const composerAfter = await win.webContents.executeJavaScript(
    `Math.round(document.querySelector('.chat__composer').getBoundingClientRect().height)`
  )
  const barAfter = await win.webContents.executeJavaScript(
    `Math.round(document.querySelector('.composer__bar').getBoundingClientRect().top)`
  )
  record(
    'G7-10 输入框上沿可拖拽',
    composerAfter - composerBefore >= 60,
    `${composerBefore} → ${composerAfter}`
  )
  record(
    'G7-10 按钮行不随输入框拉伸移动',
    Math.abs(barAfter - barBefore) <= 1,
    `${barBefore} → ${barAfter}`
  )

  const composerGrip = await win.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('[data-splitter="composer"]')
    const card = document.querySelector('.composer')
    const after = getComputedStyle(s, '::after')
    const box = s.getBoundingClientRect()
    return {
      width: after.width,
      left: after.left,
      half: Math.round(box.width / 2),
      border: after.borderTopWidth,
      background: after.backgroundColor,
      shellBg: getComputedStyle(document.querySelector('.shell')).backgroundColor,
      centerY: Math.round(box.top + parseFloat(after.top) + parseFloat(after.height) / 2),
      cardTop: Math.round(card.getBoundingClientRect().top)
    }
  })()`)
  record(
    'G7-10 输入框上沿空心长条居中骑在框线',
    parseFloat(composerGrip.width) >= 60 &&
      Math.abs(parseFloat(composerGrip.left) - composerGrip.half) <= 1 &&
      composerGrip.border === '1px' &&
      composerGrip.background === composerGrip.shellBg &&
      Math.abs(composerGrip.centerY - composerGrip.cardTop) <= 1,
    JSON.stringify(composerGrip)
  )

  const barGap = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.composer')
    const bar = document.querySelector('.composer__bar')
    if (!card || !bar) return null
    const c = card.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    return {
      gap: Math.round(b.top - c.bottom),
      inCard: card.contains(bar),
      sameLeft: Math.round(b.left) === Math.round(c.left),
      sameWidth: Math.round(b.width) === Math.round(c.width)
    }
  })()`)
  record(
    'G7-10 按钮行在输入框卡片外且同宽',
    barGap != null &&
      !barGap.inCard &&
      barGap.gap >= 4 &&
      barGap.sameLeft &&
      barGap.sameWidth,
    JSON.stringify(barGap)
  )

  // —— 右栏收起：只留图标与门禁点；点图标展开并切到对应页 ——
  await win.webContents.executeJavaScript(`document.querySelector('.workspace__toggle')?.click()`)
  await sleep(260)
  const collapsedPane = await win.webContents.executeJavaScript(`({
    pane: Math.round(document.querySelector('.workspace').getBoundingClientRect().width),
    icons: document.querySelectorAll('.workspace-icon').length,
    tabs: document.querySelectorAll('.tab').length,
    splitter: getComputedStyle(document.querySelector('[data-splitter="pane"]')).display,
    gateDots: document.querySelectorAll('.workspace__gate-dots i').length,
    stored: localStorage.getItem('mms.workspaceCollapsed.chat')
  })`)
  record(
    'G7-10 右栏可收起为图标条',
    collapsedPane.pane <= 60 &&
      collapsedPane.icons === 7 &&
      collapsedPane.tabs === 0 &&
      collapsedPane.splitter === 'none' &&
      collapsedPane.gateDots === 4 &&
      collapsedPane.stored === '1',
    JSON.stringify(collapsedPane)
  )

  await win.webContents.executeJavaScript(
    `document.querySelector('.workspace-icon[data-tab="paper"]')?.click()`
  )
  await sleep(260)
  const reopenedPane = await win.webContents.executeJavaScript(`({
    pane: Math.round(document.querySelector('.workspace').getBoundingClientRect().width),
    tabs: document.querySelectorAll('.tab').length,
    paper: !!document.querySelector('[data-panel="paper"]'),
    selected: document.querySelector('.tab[data-tab="paper"]')?.getAttribute('aria-selected')
  })`)
  record(
    'G7-10 点图标展开并切到对应页',
    reopenedPane.pane > 800 &&
      reopenedPane.tabs === 7 &&
      reopenedPane.paper &&
      reopenedPane.selected === 'true',
    JSON.stringify(reopenedPane)
  )

  // —— G7-12 模式变阵：手动偏好、切换过渡、自动展开、阶段轨道换手与恢复 ——
  await win.webContents.executeJavaScript(`document.querySelector('.workspace__toggle')?.click()`)
  await sleep(200)
  const g712Collapsed = await win.webContents.executeJavaScript(`({
    pane: Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0),
    pref: localStorage.getItem('mms.workspaceCollapsed.chat')
  })`)
  record(
    'G7-12 问答手动收起写 chat 偏好',
    g712Collapsed.pane <= 60 && g712Collapsed.pref === '1',
    JSON.stringify(g712Collapsed)
  )

  await win.webContents.executeJavaScript(`document.querySelector('.mode-switch__btn')?.click()`)
  const g712Animating = await win.webContents.executeJavaScript(
    `document.querySelector('.shell')?.dataset.modeAnimating ?? null`
  )
  record(
    'G7-12 切建模有列宽过渡',
    g712Animating === 'true',
    `data-mode-animating=${g712Animating}`
  )
  await sleep(650)
  const g712Workflow = await win.webContents.executeJavaScript(`({
    mode: document.querySelector('.shell')?.dataset.mode,
    pane: Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0),
    track: Math.round(document.querySelector('.rail__phases')?.getBoundingClientRect().height ?? 0)
  })`)
  record(
    'G7-12 进入建模自动展开大工作台',
    g712Workflow.mode === 'workflow' && g712Workflow.pane > 800,
    JSON.stringify(g712Workflow)
  )
  record(
    'G7-12 建模态阶段轨道整块展开',
    g712Workflow.track > 120,
    `track=${g712Workflow.track}`
  )

  await win.webContents.executeJavaScript(`document.querySelector('.mode-switch__btn')?.click()`)
  await sleep(650)
  const g712Back = await win.webContents.executeJavaScript(`({
    mode: document.querySelector('.shell')?.dataset.mode,
    pane: Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0),
    track: Math.round(document.querySelector('.rail__phases')?.getBoundingClientRect().height ?? -1),
    phases: document.querySelectorAll('.phase').length,
    splitter: getComputedStyle(document.querySelector('[data-splitter="pane"]')).display
  })`)
  record(
    'G7-12 退出建模恢复问答收起偏好',
    g712Back.mode === 'chat' && g712Back.pane <= 60 && g712Back.splitter === 'none',
    JSON.stringify(g712Back)
  )
  record(
    'G7-12 阶段区隐藏但仍在 DOM',
    g712Back.phases === 7 && g712Back.track === 0,
    `phases=${g712Back.phases}，track=${g712Back.track}`
  )

  // —— 清空历史：二次确认后列表与阶段一起复位 ——
  await win.webContents.executeJavaScript(`document.querySelector('.rail__clear')?.click()`)
  await sleep(180)
  const clearArmed = await win.webContents.executeJavaScript(
    `document.querySelector('.rail__clear')?.dataset.confirm === 'true'`
  )
  await win.webContents.executeJavaScript(`document.querySelector('.rail__clear')?.click()`)
  const historyCleared = await waitFor(
    win,
    `document.querySelectorAll('.conv').length === 0 && document.querySelectorAll('.phase[data-state="passed"]').length === 0`,
    5000
  )
  record(
    'G7-7 清空历史后列表与阶段复位',
    clearArmed && historyCleared,
    `二次确认=${clearArmed}，清空=${historyCleared}`
  )

  // G7-12 走完停在问答收起态：先展开，分隔条的双击复位才摸得到
  await win.webContents.executeJavaScript(`(() => {
    const width = Math.round(document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0)
    if (width > 60) return 'already'
    ;(document.querySelector('.workspace-icon[data-tab="files"]') ?? document.querySelector('.workspace-icon'))?.click()
    return 'reopened'
  })()`)
  await sleep(260)
  // 双击恢复默认，再把窗口还原，避免影响后续人工看图
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-splitter="pane"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-splitter="composer"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  win.setContentSize(1440, 900)
  await sleep(300)

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
