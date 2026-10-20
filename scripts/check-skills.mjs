#!/usr/bin/env node
/**
 * G8 · 技能规范门禁
 *
 * 上游技能被原样 vendor 进本仓库，但桌面端只允许把 UI 契约写在 manifest.json。
 * 本脚本守住另一半：SKILL.md 必须仍然是合法的 Agent Skills 入口，且目录里没有
 * 本仓库的私有字段、占位文件或超出上游层级的结构。
 *
 * 退出码：0 通过 / 1 校验失败 / 2 用法或环境错误。
 * `--self` 是负向对照：用真实 SKILL.md 造 6 种破坏，每一种都必须让对应检查变红。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法: node scripts/check-skills.mjs [选项]
  --manifest <path>   注册表（默认 skills/manifest.json）
  --skills-dir <path> 技能目录（默认 skills/）
  --json              机器可读输出
  --self              负向对照：6 种破坏都必须被抓到
  -h, --help          看这个`

const FLAG_KEYS = { manifest: 'manifest', 'skills-dir': 'skillsDir' }

function parseArgs(argv) {
  const opts = {
    manifest: join(ROOT, 'skills/manifest.json'),
    skillsDir: join(ROOT, 'skills'),
    json: false,
    self: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--self') opts.self = true
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE + '\n')
      process.exit(0)
    } else if (a.startsWith('--')) {
      const key = FLAG_KEYS[a.slice(2)]
      if (!key) failUsage(`未知选项: ${a}`)
      const val = argv[++i]
      if (val === undefined || val.startsWith('--')) failUsage(`${a} 缺参数值`)
      opts[key] = resolve(val)
    } else failUsage(`多余参数: ${a}`)
  }
  return opts
}

function failUsage(msg) {
  process.stderr.write(`用法或环境错误: ${msg}\n${USAGE}\n`)
  process.exit(2)
}

function readText(path, label) {
  if (!existsSync(path)) failUsage(`${label} 不存在: ${path}`)
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  return raw.replace(/\r\n/g, '\n')
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
const PRIVATE_KEYS = new Set(['ui', 'phases', 'hitl', 'artifacts', 'status', 'kind', 'entry'])
const MAX_DEPTH = 3

/**
 * 只解析 Agent Skills frontmatter 需要的那一小撮 YAML：
 * 顶层 `key: value`、块标量 `key: |` / `key: >`，以及 `metadata:` 下的缩进行。
 * 不追求完整 YAML——遇到超出这一小撮的写法时宁可报错，也不静默猜。
 */
function parseFrontmatter(text, problems, label) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') {
    problems.push(`${label}: 第 1 行不是 ---，没有 frontmatter`)
    return null
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) {
    problems.push(`${label}: frontmatter 没有闭合的 ---`)
    return null
  }

  const data = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/)
    if (!m) {
      // 缩进行只有在刚开了一个块标量/映射时才合法；这里交给键值归属判断。
      if (/^\s+\S/.test(line)) continue
      problems.push(`${label}: 第 ${i + 1} 行不是受支持的 YAML 写法: ${line.trim()}`)
      return null
    }
    const [, key, rawValue = ''] = m
    if (key === 'metadata') {
      data.metadata = '<map>'
      continue
    }
    let value = rawValue.trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-' || value === '') {
      const parts = []
      let j = i + 1
      for (; j < end && (/^\s+\S/.test(lines[j]) || !lines[j].trim()); j++) {
        if (lines[j].trim()) parts.push(lines[j].trim())
      }
      value = parts.join(value.startsWith('>') ? ' ' : '\n')
      i = j - 1
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return data
}

function walkFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

function check(opts) {
  const manifest = JSON.parse(readText(opts.manifest, '注册表'))
  const skills = Array.isArray(manifest.skills) ? manifest.skills : []
  const problems = { S1: [], S2: [], S3: [], S4: [], S5: [], S6: [] }
  const details = {}

  for (const s of skills) {
    const dir = join(opts.skillsDir, s.name)
    const label = s.name
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      problems.S1.push(`${label}: 技能目录不存在`)
      continue
    }
    const entryPath = join(dir, s.entry ?? 'SKILL.md')
    if (!existsSync(entryPath)) {
      problems.S1.push(`${label}: 入口 ${s.entry ?? 'SKILL.md'} 不存在`)
      continue
    }
    const fm = parseFrontmatter(readText(entryPath, `${label} 入口`), problems.S1, label)
    if (!fm) continue

    if (typeof fm.name !== 'string' || fm.name !== s.name || !NAME_RE.test(fm.name)) {
      problems.S2.push(`${label}: frontmatter name=${JSON.stringify(fm.name ?? null)}，应与目录同名且合式`)
    }
    if (typeof fm.description !== 'string' || fm.description.trim() === '') {
      problems.S3.push(`${label}: description 为空或缺失`)
    } else if ([...fm.description].length > 1024) {
      problems.S3.push(`${label}: description 超过 1024 字符（${[...fm.description].length}）`)
    }
    for (const key of Object.keys(fm)) {
      if (PRIVATE_KEYS.has(key)) problems.S4.push(`${label}: SKILL.md 出现本仓库私有字段 ${key}`)
      else if (!ALLOWED_KEYS.has(key)) problems.S4.push(`${label}: Agent Skills 规范外的字段 ${key}`)
    }

    const files = walkFiles(dir)
    for (const f of files) {
      if (f.endsWith('PLACEHOLDER.md')) problems.S5.push(`${label}: 残留占位文件 ${relative(dir, f)}`)
      const depth = relative(dir, f).split(sep).length - 1
      if (depth > MAX_DEPTH) problems.S6.push(`${label}: ${relative(dir, f)} 有 ${depth} 层目录，超过上游的 ${MAX_DEPTH} 层`)
    }
    details[label] = { files: files.length, descriptionChars: [...(fm.description ?? '')].length }
  }

  const checks = Object.entries(problems).map(([id, list]) => ({
    id,
    ok: list.length === 0,
    detail: list.length ? list.join(' | ') : 'ok'
  }))
  return { ok: checks.every((c) => c.ok), skills: skills.length, checks, details }
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }
  for (const c of report.checks) {
    process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} ${c.detail}\n`)
  }
  const failed = report.checks.filter((c) => !c.ok).length
  process.stdout.write(`\n${report.checks.length - failed}/${report.checks.length} 项通过，技能 ${report.skills} 个\n`)
}

function buildSelfFixture(base) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'skills/manifest.json'), 'utf8'))
  const skillsDir = join(base, 'skills')
  for (const s of manifest.skills) {
    const src = join(ROOT, 'skills', s.name, s.entry ?? 'SKILL.md')
    if (!existsSync(src)) {
      process.stderr.write(`自检夹具错误: ${src} 不存在\n`)
      process.exit(2)
    }
    mkdirSync(join(skillsDir, s.name), { recursive: true })
    cpSync(src, join(skillsDir, s.name, 'SKILL.md'))
  }
  writeFileSync(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { manifest: join(base, 'manifest.json'), skillsDir }
}

function runChild(fx) {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--manifest', fx.manifest, '--skills-dir', fx.skillsDir, '--json'],
    { encoding: 'utf8' }
  )
  let parsed = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    /* 交给 code 断言 */
  }
  return { code: r.status, parsed, stderr: r.stderr }
}

function selfCheck() {
  const base = mkdtempSync(join(tmpdir(), 'mms-skills-self-'))
  const rows = []
  try {
    const baseline = runChild(buildSelfFixture(join(base, 'baseline')))
    rows.push({ id: 'S0', expect: '-', actual: `exit ${baseline.code}`, pass: baseline.code === 0 })
    if (baseline.code !== 0) {
      process.stderr.write(`自检基线失败，夹具不可信:\n${baseline.stderr}\n`)
      return 2
    }

    const first = JSON.parse(readFileSync(join(base, 'baseline/manifest.json'), 'utf8')).skills[0].name
    const mutations = [
      {
        id: 'M1',
        expect: 'S1',
        label: '删掉 SKILL.md',
        apply: (fx) => rmSync(join(fx.skillsDir, first, 'SKILL.md'))
      },
      {
        id: 'M2',
        expect: 'S2',
        label: 'frontmatter name 与目录不同名',
        apply: (fx) => {
          const p = join(fx.skillsDir, first, 'SKILL.md')
          writeFileSync(p, readFileSync(p, 'utf8').replace(/^name: .*$/m, 'name: wrong-name'), 'utf8')
        }
      },
      {
        id: 'M3',
        expect: 'S3',
        label: 'description 置空',
        apply: (fx) => {
          const p = join(fx.skillsDir, first, 'SKILL.md')
          writeFileSync(p, readFileSync(p, 'utf8').replace(/^description: .*$/m, 'description: ""'), 'utf8')
        }
      },
      {
        id: 'M4',
        expect: 'S4',
        label: '把 UI 契约塞进 SKILL.md',
        apply: (fx) => {
          const p = join(fx.skillsDir, first, 'SKILL.md')
          const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
          const close = text.indexOf('\n---\n', 3)
          if (close < 0) {
            process.stderr.write('自检夹具错误: 找不到 frontmatter 的闭合 ---\n')
            process.exit(2)
          }
          writeFileSync(p, text.slice(0, close) + '\nui:\n  phases: [4]' + text.slice(close), 'utf8')
        }
      },
      {
        id: 'M5',
        expect: 'S5',
        label: '残留 PLACEHOLDER.md',
        apply: (fx) => writeFileSync(join(fx.skillsDir, first, 'PLACEHOLDER.md'), 'x\n', 'utf8')
      },
      {
        id: 'M6',
        expect: 'S6',
        label: '目录深到第 4 层',
        apply: (fx) => {
          const deep = join(fx.skillsDir, first, 'a/b/c/d')
          mkdirSync(deep, { recursive: true })
          writeFileSync(join(deep, 'x.txt'), 'x\n', 'utf8')
        }
      }
    ]

    for (const m of mutations) {
      const root = join(base, m.id)
      const fx = buildSelfFixture(root)
      m.apply(fx)
      const out = runChild(fx)
      const ids = (out.parsed?.checks ?? []).filter((c) => !c.ok).map((c) => c.id)
      const pass = out.code === 1 && ids.includes(m.expect)
      rows.push({ id: m.id, label: m.label, expect: m.expect, actual: `exit ${out.code}，失败项: ${ids.join(',') || '无'}`, pass })
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  for (const r of rows) {
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id.padEnd(3)} ${r.label ?? '未改动的夹具退出 0'}\n`)
    process.stdout.write(`       期望 ${r.expect} / 实得 ${r.actual}\n`)
  }
  const bad = rows.filter((r) => !r.pass)
  process.stdout.write(`\n${rows.length - bad.length}/${rows.length} 条自检通过（含 1 条基线自证）\n`)
  if (bad.length) {
    process.stderr.write('技能规范检查器存在假绿\n')
    return 1
  }
  return 0
}

const opts = parseArgs(process.argv.slice(2))
if (opts.self) process.exit(selfCheck())
const report = check(opts)
printReport(report, opts.json)
process.exit(report.ok ? 0 : 1)
