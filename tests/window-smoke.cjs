/**
 * G7 · 无头真启动冒烟
 *
 * M0 的判据是「起一个空窗」，而窗口启动没法只靠类型检查与打包证明。
 * 本脚本在 xvfb 下真起 Electron，并断言四件互相独立的事：
 *   1 窗口标题与内容尺寸符合设计基准
 *   2 画面真的画出来了（非白像素占比超阈值）——空白截图也算「窗口起来了」，那是假绿
 *   3 preload + IPC 端到端通了（状态栏文本由主进程应答渲染出来）
 *   4 阶段轨道与工作台标签数量对得上，输入区按事实禁用，点色块真的换掉 --accent
 *
 * 沙箱与生产一致：CI 里先把 chrome-sandbox 助手改成 root:4755（workflow 的那一步），
 * 这样窗口仍然跑在 sandbox: true 下，冒烟验的是生产那套 webPreferences，
 * 而不是靠 --no-sandbox 绕过——绕过就等于没验。
 * 仍未覆盖的一块：本脚本自己建窗口，走的是构建产物 out/renderer + out/preload，
 * 不执行 src/main/index.ts 的窗口配置与导航守卫；那条路要等 M2 有 runtime 可握手时再补真启动测试。
 *
 * 退出码：0 全部通过 / 1 任一断言失败 / 2 环境错误（没构建产物）
 */
const { app, BrowserWindow } = require('electron')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const OUT_DIR = process.env.SMOKE_OUT || 'screenshots'
const MIN_INK_RATIO = 0.01
// 版本断言取实时值而不是写死字符串，否则升版就会把冒烟测成假红
const EXPECT_VERSION = require('../package.json').version
const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-dev-shm-usage')
app.disableHardwareAcceleration()

async function main() {
  const dist = join(__dirname, '..', 'out', 'renderer', 'index.html')
  if (!existsSync(dist)) {
    console.error('环境错误: 没有 out/renderer/index.html，先跑 npm run build')
    process.exit(2)
  }

  // 必须真显示：隐藏窗口在部分平台上 capturePage 直接回空面
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#ffffff',
    title: 'mathmodel-studio',
    webPreferences: {
      preload: join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  await win.loadFile(dist)
  win.show()
  await sleep(800)

  const [w, h] = win.getContentSize()
  record('G7-1 内容尺寸 = 1440x900', w === 1440 && h === 900, `实得 ${w}x${h}`)
  record('G7-1 窗口标题', win.getTitle() === 'mathmodel-studio', `实得「${win.getTitle()}」`)

  const img = await win.webContents.capturePage()
  await sleep(200)
  const { width: iw, height: ih } = img.getSize()
  const bmp = img.toBitmap() // BGRA
  let ink = 0
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    if (bmp[i + 2] < 250 || bmp[i + 1] < 250 || bmp[i] < 250) ink++
  }
  const totalPx = (bmp.length / 4) | 0
  const ratio = totalPx > 0 ? ink / totalPx : 0
  record('G7-2 截图面非空', iw > 0 && ih > 0 && bmp.length >= iw * ih * 4, `捕获 ${iw}x${ih}，位图 ${bmp.length} B`)
  record('G7-2 画面非空白', ratio >= MIN_INK_RATIO, `非白像素 ${ink} / ${totalPx} = ${(ratio * 100).toFixed(2)}%（阈值 ${MIN_INK_RATIO * 100}%）`)

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const pngBuf = img.toPNG()
  const png = join(OUT_DIR, 'window-smoke.png')
  writeFileSync(png, pngBuf)
  console.log(`截图: ${png} (${(pngBuf.length / 1024).toFixed(1)} KB)`)

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
  await sleep(150)
  const accentB = await win.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
  )
  record('G7-4 切到 B 案靛蓝生效', accentB.toLowerCase() === '#2b4c7e', `实得 ${accentB}`)

  win.close()
}

app
  .whenReady()
  .then(main)
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}\n       ${r.detail}`)
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
    app.exit(failed.length === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(`FAIL 冒烟脚本自身异常: ${err && err.stack ? err.stack : err}`)
    app.exit(1)
  })
