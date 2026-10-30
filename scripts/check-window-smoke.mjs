#!/usr/bin/env node
/**
 * G6b · 真启动结果的独立核验
 *
 * 为什么需要第二个脚本判一遍：上一轮 CI 里冒烟打印了「10/12 项通过」，
 * 但 job 却是绿的——app.exit(1) 被生产入口的 window-all-closed → app.quit() 抢先顶掉了。
 * 「通过与否」不能吊在 Electron 的退出码管道上，所以结果落成 JSON，由本脚本独立判定，
 * 并且**复算读数**而不是只看 ok 标志：ok:true 但内容尺寸 1439x899 一样判失败。
 *
 * 本脚本自带 --selftest，不需要真起窗口就能证明它会失败（本机即可跑）。
 * 退出码：0 通过 / 1 判据不满足或没有证据 / 2 用法错误
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FILE = join(ROOT, 'screenshots/window-smoke.json')
// 新增断言时同步抬高这里：它的作用是「断言集合被删空」也会判失败
const MIN_ASSERTIONS = 82
const MIN_THRESHOLD_FLOOR = 0.01
const EXPECT_SIZE = '1440x900'
// 只认条数不够：把关键断言整条删掉、再拿凑数的 A 行补齐，条数照样够。
// 这里点名 M2 闭环最关键的几条，少一条就判失败。
const REQUIRED_ASSERTIONS = [
  'G7-3 runtime 通过握手就绪',
  'G7-4 空状态大框与加号居中',
  'G7-4 拖入文件时大框高亮',
  'G7-4 附件正文抽取（PDF/CSV）',
  'G7-4 只读取工作区附件',
  'G7-4 附件暂存到工作区',
  'G7-4 真拖放走完暂存与移除',
  'G7-4 文件页列出工作区文件',
  'G7-4 默认工作区在桌面「赛题」',
  'G7-4 移除只删暂存副本',
  'G7-4 粘贴截图进输入区并落盘',
  'G7-4 输入区不常驻附件按钮',
  'G7-5 中文按真字形渲染（不是空心方框）',
  'G7-5 工具卡完成并给出结构化结果',
  'G7-5 回复文本含模板总数',
  'G7-6 设置对话框打开并列出服务商',
  'G7-6 Key 落盘只有密文或明确拒绝',
  'G7-7 K2 卡切出两个子问题',
  'G7-7 解释抽屉打开不清除待选',
  'G7-7 附件随消息送给模型',
  'G7-7 重开后附件还原且不铺正文',
  'G7-7 runtime 重启后仍停在 K3',
  'G7-7 选择后阶段 4 进入且待决清空',
  'G7-8 工作台渲染出首版图表',
  'G7-8 换主题重渲出第二版并并排 diff',
  'G7-8 回滚到第一版',
  'G7-8 评分卡五维、总分 86 且达标',
  'G7-8 扣分项能定位到正文',
  'G7-8 第三轮低于 85 显示熔断提示',
  'G7-8 门禁条四项全绿',
  'G7-9 论文页打开且构建按钮可用',
  'G7-9 论文构建出 PDF 与 DOCX',
  'G7-9 去 AI 与章节门禁全绿',
  'G7-9 论文 PDF 预览渲染且截图非空',
  'G7-10 宽屏右栏按比例放宽',
  'G7-10 宽屏论文页两栏且预览限宽',
  'G7-10 宽屏评分页两栏',
  'G7-10 握把高亮跟随指针',
  'G7-10 左栏固定不可拖拽',
  'G7-10 中/右分隔条可拖拽',
  'G7-10 离开分隔条后握把保持在指针处',
  'G7-10 输入框上沿可拖拽',
  'G7-10 输入框上沿空心长条居中骑在框线',
  'G7-10 按钮行在输入框卡片外且同宽',
  'G7-10 按钮行不随输入框拉伸移动'
]

const problems = []
const fail = (msg) => problems.push(msg)

function parseArgs(argv) {
  const opts = { file: DEFAULT_FILE, selftest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') opts.selftest = true
    else if (a === '-h' || a === '--help') {
      process.stdout.write('用法: node scripts/check-window-smoke.mjs [--file <path>] [--selftest]\n')
      process.exit(0)
    } else if (a === '--file') {
      const v = argv[++i]
      if (!v) usage('--file 缺参数值')
      opts.file = resolve(v)
    } else usage(`未知选项: ${a}`)
  }
  return opts
}

function usage(msg) {
  process.stderr.write(`用法错误: ${msg}\n`)
  process.exit(2)
}

/** 对一份结果对象做判据；返回问题列表，空即通过。 */
export function judge(data) {
  const errs = []
  if (!data || typeof data !== 'object') return ['结果不是对象']
  if (typeof data.ok !== 'boolean') errs.push('缺布尔字段 ok')
  if (!Number.isInteger(data.total) || data.total < MIN_ASSERTIONS) {
    errs.push(`断言条数 ${data.total} 少于下限 ${MIN_ASSERTIONS}（断言集合被删空也是失败）`)
  }
  if (data.failed !== 0) errs.push(`failed=${data.failed}，必须为 0`)
  if (data.ok !== true) errs.push('ok 不为 true')
  if (data.contentSize !== EXPECT_SIZE) errs.push(`内容尺寸实读 ${data.contentSize}，应为 ${EXPECT_SIZE}`)
  if (typeof data.minInkRatio !== 'number' || data.minInkRatio < MIN_THRESHOLD_FLOOR) {
    errs.push(`非白像素阈值被调到 ${data.minInkRatio}，不得低于 ${MIN_THRESHOLD_FLOOR}（把阈值调成 0 来「过」是假的通过）`)
  }
  if (typeof data.inkRatio !== 'number' || !(data.inkRatio >= (data.minInkRatio ?? 0))) {
    errs.push(`inkRatio=${data.inkRatio} 未达阈值 ${data.minInkRatio}`)
  }
  if (!Array.isArray(data.results)) errs.push('results 不是数组')
  else {
    const badShape = data.results.filter((r) => !r || typeof r.name !== 'string' || typeof r.ok !== 'boolean' || typeof r.detail !== 'string')
    if (badShape.length) errs.push(`${badShape.length} 条结果缺 name/ok/detail`)
    const countedFail = data.results.filter((r) => r && r.ok === false).length
    if (countedFail !== data.failed) errs.push(`自述 failed=${data.failed} 与明细里的 ${countedFail} 条 FAIL 不一致`)
    const selfTotal = data.results.length
    if (selfTotal !== data.total) errs.push(`自述 total=${data.total} 与明细 ${selfTotal} 条不一致`)
    const names = data.results.map((r) => (r && typeof r.name === 'string' ? r.name : ''))
    const missing = REQUIRED_ASSERTIONS.filter((name) => !names.includes(name))
    if (missing.length) errs.push(`缺少关键断言: ${missing.join('；')}`)
    const dupes = [...new Set(names.filter((name, i) => name && names.indexOf(name) !== i))]
    if (dupes.length) errs.push(`断言名重复: ${dupes.join('；')}（重复行可以凑条数）`)
    const ready = data.results.find((r) => r && r.name === 'G7-3 runtime 通过握手就绪')
    if (ready && !String(ready.detail).includes('离线演示')) {
      errs.push('runtime 就绪那条没有证明是离线演示 provider 在跑')
    }
  }
  return errs
}

function runJudge(file) {
  if (!existsSync(file)) {
    // 没有证据就是没过：上一轮的假绿正是「脚本没真跑成但也报了绿」的同类问题
    return ['没有结果文件 ' + file]
  }
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return [`结果文件不是合法 JSON: ${e.message}`]
  }
  return judge(data)
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'mms-wsmoke-'))
  const requiredRows = REQUIRED_ASSERTIONS.map((name) => ({
    name,
    ok: true,
    detail: name === 'G7-3 runtime 通过握手就绪' ? '状态栏: 运行时已连接 · 离线演示' : 'ok'
  }))
  const filler = Array.from(
    { length: Math.max(0, MIN_ASSERTIONS - requiredRows.length) },
    (_, i) => ({ name: `A${i}`, ok: true, detail: 'ok' })
  )
  const good = {
    ok: true,
    total: MIN_ASSERTIONS,
    failed: 0,
    contentSize: EXPECT_SIZE,
    inkRatio: 0.0211,
    minInkRatio: MIN_THRESHOLD_FLOOR,
    url: 'file:///abs/out/renderer/index.html',
    results: [...requiredRows, ...filler]
  }
  const cases = [
    { name: '全绿夹具应通过', mutate: () => good, wantPass: true },
    { name: '有一条 FAIL 必须判失败', mutate: (d) => ((d.failed = 1), (d.results[0].ok = false), (d.ok = false)), wantPass: false },
    { name: 'ok=true 但尺寸读数不对', mutate: (d) => (d.contentSize = '1439x899'), wantPass: false },
    { name: 'ok=true 但非白像素低于阈值', mutate: (d) => (d.inkRatio = 0.0002), wantPass: false },
    { name: 'ok=true 但阈值被调成 0', mutate: (d) => ((d.minInkRatio = 0), (d.inkRatio = 0)), wantPass: false },
    { name: '断言条数被删到下限以下', mutate: (d) => ((d.total = 3), (d.results = d.results.slice(0, 3))), wantPass: false },
    { name: '自述 failed 与明细不一致', mutate: (d) => (d.failed = 2), wantPass: false },
    {
      name: '删掉关键断言、用凑数行补满条数',
      mutate: (d) => {
        const idx = d.results.findIndex((r) => r.name === 'G7-5 工具卡完成并给出结构化结果')
        d.results[idx] = { name: 'A-extra', ok: true, detail: 'ok' }
      },
      wantPass: false
    },
    {
      name: '删掉 M3 的持久化断言、补一条 A 行',
      mutate: (d) => {
        const idx = d.results.findIndex((r) => r.name === 'G7-7 runtime 重启后仍停在 K3')
        d.results[idx] = { name: 'A-m3', ok: true, detail: 'ok' }
      },
      wantPass: false
    },
    {
      name: '关键断言的 detail 不再证明离线演示',
      mutate: (d) => {
        const row = d.results.find((r) => r.name === 'G7-3 runtime 通过握手就绪')
        row.detail = '状态栏: runtime 已连接'
      },
      wantPass: false
    },
    { name: '结果文件不存在', mutate: null, wantPass: false }
  ]

  const rows = []
  for (const [i, c] of cases.entries()) {
    const label = `${String(i + 1).padStart(2, '0')} ${c.name}`
    if (c.mutate === null) {
      const errs = runJudge(join(dir, 'nope.json'))
      rows.push({ label, pass: c.wantPass ? errs.length === 0 : errs.length > 0, detail: errs.join(' / ') || '居然放过了' })
      continue
    }
    const data = structuredClone(good)
    c.mutate(data)
    const file = join(dir, `case-${i}.json`)
    writeFileSync(file, JSON.stringify(data, null, 2))
    const errs = runJudge(file)
    rows.push({
      label,
      pass: c.wantPass ? errs.length === 0 : errs.length > 0,
      detail: errs.join(' / ') || '判为通过'
    })
  }

  // 再验一次「本脚本自己的退出码约定」：真把自己 spawn 起来跑一次坏结果
  const badFile = join(dir, 'spawn-bad.json')
  const bad = structuredClone(good)
  bad.failed = 1
  bad.ok = false
  bad.results[0].ok = false
  writeFileSync(badFile, JSON.stringify(bad, null, 2))
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--file', badFile], { encoding: 'utf8' })
  rows.push({
    label: '99 作为 CLI 对被污染结果必须非零退出',
    pass: r.status === 1,
    detail: `exit ${r.status}`
  })

  rmSync(dir, { recursive: true, force: true })
  for (const row of rows) {
    process.stdout.write(`${row.pass ? 'PASS' : 'FAIL'} ${row.label}\n       ${row.detail}\n`)
  }
  const bad2 = rows.filter((x) => !x.pass)
  process.stdout.write(`\n${rows.length - bad2.length}/${rows.length} 条核验自测通过\n`)
  process.exit(bad2.length === 0 ? 0 : 1)
}

const opts = parseArgs(process.argv.slice(2))
if (opts.selftest) selftest()

const errs = runJudge(opts.file)
if (errs.length === 0) {
  const data = JSON.parse(readFileSync(opts.file, 'utf8'))
  process.stdout.write(
    `PASS 真启动结果核验：${data.total} 条断言全过，内容尺寸 ${data.contentSize}，非白像素 ${(data.inkRatio * 100).toFixed(2)}%（阈值 ${(data.minInkRatio * 100).toFixed(2)}%）\n`
  )
  process.exit(0)
}
process.stderr.write(`FAIL 真启动结果核验（${opts.file}）：\n`)
for (const e of errs) process.stderr.write(`  - ${e}\n`)
process.exit(1)
