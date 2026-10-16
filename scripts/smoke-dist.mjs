#!/usr/bin/env node
/**
 * G6 · 构建产物冒烟
 *
 * 只断言三件事：产物存在、HTML 真的挂上了 JS/CSS、bundle 里确实含有本项目的文案与配色令牌。
 * 最后一条是关键——「构建成功」不等于「打进去了我们的代码」，
 * 空模板目录也能构建出一个绿色的 dist。
 *
 * 退出码：0 通过 / 1 断言失败 / 2 环境错误（没跑过 build）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'out')
const RENDERER = join(DIST, 'renderer')

if (!existsSync(DIST)) {
  process.stderr.write('环境错误: 没有 out/ 目录，先跑 npm run build\n')
  process.exit(2)
}

const rows = []
const record = (name, ok, detail) => rows.push({ name, ok, detail })

// D1 三个入口都在
for (const [label, p] of [
  ['out/main/index.js', join(DIST, 'main/index.js')],
  ['out/preload/index.js', join(DIST, 'preload/index.js')],
  ['out/renderer/index.html', join(RENDERER, 'index.html')]
]) {
  record(`D1 存在 ${label}`, existsSync(p), existsSync(p) ? `${(readFileSync(p).length / 1024).toFixed(1)} KB` : '缺失')
}

const htmlPath = join(RENDERER, 'index.html')
const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : ''

// D2 挂载点与资源引用真的能落到磁盘上的文件
const rootMount = /id=["']root["']/.test(html)
const scriptSrc = html.match(/<script[^>]*\ssrc=["']([^"']+)["']/)?.[1] ?? null
const cssHref = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)].map((m) => m[1])
const resolved = (ref) => {
  if (!ref) return false
  const clean = ref.replace(/^[./]+/, '')
  return existsSync(join(RENDERER, clean))
}
record('D2 #root 挂载点存在', rootMount, rootMount ? 'ok' : 'HTML 里没有 id="root"')
record('D2 脚本引用可解析', scriptSrc !== null && resolved(scriptSrc), `引用 ${scriptSrc ?? '无'}`)
record('D2 样式引用可解析', cssHref.length > 0 && cssHref.every(resolved), `引用 ${cssHref.join(', ') || '无'}`)

// D3 CSP 未被构建过程丢掉
record('D3 CSP meta 仍在', /http-equiv=["']Content-Security-Policy["']/.test(html), /Content-Security-Policy/.test(html) ? 'ok' : '构建后 CSP meta 不见了')

// D4 bundle 里确实含有本项目的内容（而不是一个空模板）
const assets = existsSync(join(RENDERER, 'assets')) ? readdirSync(join(RENDERER, 'assets')) : []
const js = assets.filter((a) => a.endsWith('.js')).map((a) => readFileSync(join(RENDERER, 'assets', a), 'utf8')).join('\n')
const css = assets.filter((a) => a.endsWith('.css')).map((a) => readFileSync(join(RENDERER, 'assets', a), 'utf8')).join('\n')
const needles = [
  ['阶段文案「环境预检」', js.includes('环境预检')],
  ['卡点文案「等你确认」', js.includes('等你确认')],
  ['工作台文案「评分」', js.includes('评分')],
  ['A 案强调色 #17494d', css.includes('#17494d')],
  ['B 案强调色 #2b4c7e', css.includes('#2b4c7e')],
  ['C 案强调色 #b03a2e', css.includes('#b03a2e')],
  ['主色白 #ffffff', css.includes('#ffffff')]
]
for (const [label, ok] of needles) {
  record(`D4 ${label}`, ok, ok ? '在 bundle 内' : `未打进产物（js ${js.length} B / css ${css.length} B）`)
}

const failed = rows.filter((r) => !r.ok)
for (const r of rows) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}\n       ${r.detail}\n`)
}
process.stdout.write(`\n${rows.length - failed.length}/${rows.length} 项通过\n`)
process.exit(failed.length === 0 ? 0 : 1)
