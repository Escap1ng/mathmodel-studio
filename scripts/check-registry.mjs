#!/usr/bin/env node
/**
 * G1 · 注册表一致性门禁
 *
 * 单一事实源是 skills/manifest.json。本脚本把四处东西钉在一起：
 *   注册表 ↔ skills/ 目录 ↔ schemas/skill-manifest.schema.json 的词表
 *   ↔ README.md 技能表与徽章 ↔ README_EN.md 技能表
 * 任何一处不一致就非零退出，不允许靠人工同步。
 *
 * 退出码沿用上游 CLI 契约：0 通过 / 1 校验失败 / 2 用法或环境错误。
 * 反向覆盖见 scripts/check-registry.negative.mjs。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法: node scripts/check-registry.mjs [选项]
  --manifest <path>   注册表文件（默认 skills/manifest.json）
  --skills-dir <path> 技能目录（默认 skills/）
  --schema <path>     契约文件（默认 schemas/skill-manifest.schema.json）
  --readme <path>     中文 README（默认 README.md）
  --readme-en <path>  英文 README（默认 README_EN.md）
  --json              机器可读输出
  -h, --help          看这个`

const FLAG_KEYS = {
  manifest: 'manifest',
  'skills-dir': 'skillsDir',
  schema: 'schema',
  readme: 'readme',
  'readme-en': 'readmeEn'
}

function parseArgs(argv) {
  const opts = {
    manifest: join(ROOT, 'skills/manifest.json'),
    skillsDir: join(ROOT, 'skills'),
    schema: join(ROOT, 'schemas/skill-manifest.schema.json'),
    readme: join(ROOT, 'README.md'),
    readmeEn: join(ROOT, 'README_EN.md'),
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
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
  return readFileSync(path, 'utf8')
}

function readJson(path, label) {
  const raw = readText(path, label)
  try {
    return JSON.parse(raw)
  } catch (e) {
    process.stderr.write(`校验失败: ${label} 不是合法 JSON — ${e.message}\n`)
    process.exit(1)
  }
}

const results = []
function check(id, ok, detail) {
  results.push({ id, ok, detail })
}

const opts = parseArgs(process.argv.slice(2))
const manifest = readJson(opts.manifest, '注册表')
const schema = readJson(opts.schema, '契约')
const readmeCn = readText(opts.readme, 'README')
const readmeEn = readText(opts.readmeEn, 'README_EN')

// —— R1 顶层字段
const REQUIRED_TOP = [
  'manifest_version',
  'schema_version',
  'title',
  'description',
  'kinds',
  'status',
  'contribution',
  'cli_contract',
  'phases',
  'skills'
]
const missingTop = REQUIRED_TOP.filter((k) => manifest[k] === undefined)
check('R1', missingTop.length === 0, missingTop.length ? `缺字段: ${missingTop.join(', ')}` : '顶层字段齐')

const skills = Array.isArray(manifest.skills) ? manifest.skills : []

// —— R2 名字唯一且合式
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const badNames = skills.filter((s) => typeof s.name !== 'string' || !NAME_RE.test(s.name)).map((s) => String(s.name))
const dupNames = skills.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i)
check(
  'R2',
  badNames.length === 0 && dupNames.length === 0,
  badNames.length || dupNames.length
    ? `合式: ${badNames.join(', ') || 'ok'} / 重复: ${dupNames.join(', ') || 'ok'}`
    : `${skills.length} 个技能名唯一且合式`
)

// —— R3 注册表 ↔ 目录 双向
const dirsOnDisk = existsSync(opts.skillsDir)
  ? readdirSync(opts.skillsDir).filter((d) => {
      const p = join(opts.skillsDir, d)
      return statSync(p).isDirectory()
    })
  : []
const declared = new Set(skills.map((s) => s.name))
const missingDirs = [...declared].filter((n) => !dirsOnDisk.includes(n))
const undeclaredDirs = dirsOnDisk.filter((d) => !declared.has(d))
check(
  'R3',
  missingDirs.length === 0 && undeclaredDirs.length === 0,
  missingDirs.length || undeclaredDirs.length
    ? `登记了但没目录: ${missingDirs.join(', ') || '-'} / 有目录没登记: ${undeclaredDirs.join(', ') || '-'}`
    : `目录与注册表一一对应（${dirsOnDisk.length} 个目录）`
)

// —— R4 status 语义
const statusProblems = []
for (const s of skills) {
  const dir = join(opts.skillsDir, s.name)
  if (!existsSync(dir)) continue // R3 已经报过
  const entryPath = join(dir, s.entry ?? '')
  const hasEntry = s.entry ? existsSync(entryPath) : false
  const hasSkillMd = existsSync(join(dir, 'SKILL.md'))
  if (s.status === 'planned' && hasSkillMd) {
    statusProblems.push(`${s.name}: status=planned 却已有 SKILL.md（半 vendor）`)
  }
  if (s.status === 'vendored' && !hasEntry) {
    statusProblems.push(`${s.name}: status=vendored 但入口 ${s.entry} 不存在`)
  }
}
check('R4', statusProblems.length === 0, statusProblems.length ? statusProblems.join(' | ') : 'planned/vendored 语义一致')

// —— R5/R6 UI 契约取值
const allowedPhases = Array.isArray(manifest.phases) ? new Set(manifest.phases) : new Set()
const allowedArtifacts = new Set(Object.keys(manifest.artifact_kinds ?? {}))
const allowedHitl = new Set(Object.keys(manifest.hitl_card_kinds ?? {}))
const uiProblems = []
for (const s of skills) {
  const ui = s.ui
  if (!ui || !Array.isArray(ui.phases) || ui.phases.length === 0) {
    uiProblems.push(`${s.name}: 缺 ui.phases`)
    continue
  }
  const badPhases = ui.phases.filter((p) => !allowedPhases.has(p))
  if (badPhases.length) uiProblems.push(`${s.name}: 阶段越界 ${badPhases.join(',')}`)
  const badArt = (ui.artifacts ?? []).filter((a) => !allowedArtifacts.has(a))
  if (badArt.length) uiProblems.push(`${s.name}: 产物类型不在词表 ${badArt.join(',')}`)
  if (!Array.isArray(ui.artifacts) || ui.artifacts.length === 0) uiProblems.push(`${s.name}: 缺 ui.artifacts`)
  const badHitl = (ui.hitl ?? []).filter((h) => !allowedHitl.has(h))
  if (badHitl.length) uiProblems.push(`${s.name}: 卡点不在词表 ${badHitl.join(',')}`)
}
check('R5+R6', uiProblems.length === 0, uiProblems.length ? uiProblems.join(' | ') : 'UI 契约取值都在声明的词表内')

// —— R7 schema 词表 ↔ manifest 词表
const skillUi = schema?.$defs?.ui?.properties ?? {}
const schemaArtifacts = skillUi?.artifacts?.items?.enum ?? null
const schemaHitl = skillUi?.hitl?.items?.enum ?? null
const vocabProblems = []
if (!Array.isArray(schemaArtifacts)) vocabProblems.push('契约里缺 ui.artifacts 枚举')
else {
  const a = new Set(schemaArtifacts)
  const onlySchema = [...a].filter((x) => !allowedArtifacts.has(x))
  const onlyManifest = [...allowedArtifacts].filter((x) => !a.has(x))
  if (onlySchema.length || onlyManifest.length) {
    vocabProblems.push(`产物词表不一致 契约独有:${onlySchema.join(',') || '-'} 注册表独有:${onlyManifest.join(',') || '-'}`)
  }
}
if (!Array.isArray(schemaHitl)) vocabProblems.push('契约里缺 ui.hitl 枚举')
else {
  const h = new Set(schemaHitl)
  const onlySchema = [...h].filter((x) => !allowedHitl.has(x))
  const onlyManifest = [...allowedHitl].filter((x) => !h.has(x))
  if (onlySchema.length || onlyManifest.length) {
    vocabProblems.push(`卡点词表不一致 契约独有:${onlySchema.join(',') || '-'} 注册表独有:${onlyManifest.join(',') || '-'}`)
  }
}
check('R7', vocabProblems.length === 0, vocabProblems.length ? vocabProblems.join(' | ') : '契约枚举与注册表词表一致')

// —— R8 README 技能表
const ROW_RE = /^\|\s*\[`([a-z0-9-]+)`\]\(skills\/[^)]+\)\s*\|/gm
function tableNames(text) {
  return [...text.matchAll(ROW_RE)].map((m) => m[1])
}
const cnNames = tableNames(readmeCn)
const enNames = tableNames(readmeEn)
const tableProblems = []
for (const [label, names] of [
  ['README', cnNames],
  ['README_EN', enNames]
]) {
  const missing = [...declared].filter((n) => !names.includes(n))
  const extra = names.filter((n) => !declared.has(n))
  if (missing.length) tableProblems.push(`${label} 表缺行: ${missing.join(',')}`)
  if (extra.length) tableProblems.push(`${label} 表多行: ${extra.join(',')}`)
}
check(
  'R8',
  tableProblems.length === 0,
  tableProblems.length
    ? tableProblems.join(' | ')
    : `两份 README 技能表各 ${cnNames.length}/${enNames.length} 行，与注册表 ${skills.length} 个技能名单一致`
)

// —— R9 徽章计数
function badgeCount(text, labelText) {
  const badgeRe = /img\.shields\.io\/badge\/([A-Za-z0-9%_.+~-]+?)-(\d+)-([0-9A-Fa-f]{3,8})/g
  for (const m of text.matchAll(badgeRe)) {
    let label = m[1]
    try {
      label = decodeURIComponent(label)
    } catch {
      /* 未编码的 label 原样比较 */
    }
    if (label === labelText) return Number(m[2])
  }
  return null
}
const cnBadge = badgeCount(readmeCn, '技能')
const enBadge = badgeCount(readmeEn, 'skills')
check(
  'R9',
  cnBadge === skills.length && enBadge === skills.length,
  `中文徽章 技能=${cnBadge ?? '缺失'} / 英文徽章 skills=${enBadge ?? '缺失'} / 实际 ${skills.length}`
)

const failed = results.filter((r) => !r.ok)
if (opts.json) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: failed.length === 0,
        skills: skills.length,
        checks: results
      },
      null,
      2
    ) + '\n'
  )
} else {
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(7)} ${r.detail}\n`)
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过，技能 ${skills.length} 个\n`)
}
process.exit(failed.length === 0 ? 0 : 1)
