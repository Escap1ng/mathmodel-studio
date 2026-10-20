#!/usr/bin/env node
/**
 * G1 门禁的反向覆盖
 *
 * check-registry.mjs 报 PASS 本身不构成证据：一个永远返回 0 的检查器最危险。
 * 本脚本把真实注册表拷进临时目录，先证明**未改动的夹具退出 0**（夹具真的跑得通被测脚本），
 * 再逐个植入 8 种破坏，每种都必须让对应的检查项变红。
 *
 * 断言方式是「预期失败的检查项 ∈ 实际失败集合」而非「只有一项失败」：
 * 有些破坏天然会级联（删一个技能会同时让目录、表格、徽章三处不一致），
 * 级联清单会整行打印出来供人看，不隐藏。
 *
 * 退出码：0 = 门禁确实能失败且约定正确 / 1 = 有一条破坏没被抓到 / 2 = 夹具或环境自身出错
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = join(ROOT, 'scripts/check-registry.mjs')
const SKILL_DIRS = [
  'mathmodel-core',
  'mathmodel-methods',
  'mathmodel-paper',
  'mathmodel-figure',
  'mathmodel-diagram',
  'mathmodel-deai',
  'mathmodel-score'
]

if (!existsSync(CHECKER)) {
  process.stderr.write(`环境错误: 找不到被测脚本 ${CHECKER}\n`)
  process.exit(2)
}

const base = mkdtempSync(join(tmpdir(), 'mms-registry-negative-'))

function buildFixture() {
  const fx = {
    root: base,
    skills: join(base, 'skills'),
    manifest: join(base, 'skills/manifest.json'),
    schema: join(base, 'schemas/skill-manifest.schema.json'),
    readme: join(base, 'README.md'),
    readmeEn: join(base, 'README_EN.md')
  }
  mkdirSync(join(base, 'schemas'), { recursive: true })
  cpSync(join(ROOT, 'skills/manifest.json'), fx.manifest)
  cpSync(join(ROOT, 'schemas/skill-manifest.schema.json'), fx.schema)
  cpSync(join(ROOT, 'README.md'), fx.readme)
  cpSync(join(ROOT, 'README_EN.md'), fx.readmeEn)
  for (const d of SKILL_DIRS) {
    // 夹具只复制入口文件：R4 判的就是「vendored 时 entry 是否存在」。
    // 整目录复制会让 9 个用例各拷 16MB，且与判据无关。
    const src = join(ROOT, `skills/${d}/SKILL.md`)
    if (!existsSync(src)) {
      process.stderr.write(`夹具错误: ${src} 不存在——技能未 vendor 或目录已改名\n`)
      process.exit(2)
    }
    mkdirSync(join(fx.skills, d), { recursive: true })
    cpSync(src, join(fx.skills, d, 'SKILL.md'))
  }
  return fx
}

function run(fx, extraArgs = []) {
  const args = [
    CHECKER,
    '--manifest',
    fx.manifest,
    '--skills-dir',
    fx.skills,
    '--schema',
    fx.schema,
    '--readme',
    fx.readme,
    '--readme-en',
    fx.readmeEn,
    '--json',
    ...extraArgs
  ]
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  let parsed = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    /* 非零退出时输出可能不是 JSON，交给下面的 code 断言处理 */
  }
  return { code: r.status, parsed, stderr: r.stderr, stdout: r.stdout }
}

const failedIds = (out) => (out.parsed?.checks ?? []).filter((c) => !c.ok).map((c) => c.id)

function patchJson(path, mutate) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  mutate(data)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function patchText(path, from, to) {
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) {
    process.stderr.write(`夹具错误: ${path} 里找不到锚点「${from}」——夹具已与仓库脱节\n`)
    process.exit(2)
  }
  writeFileSync(path, text.replace(from, to), 'utf8')
}

const cases = [
  {
    id: 'M1',
    expect: 'R3',
    label: '从注册表删掉一个技能 → 目录与清单不再一一对应',
    apply: (fx) => patchJson(fx.manifest, (m) => (m.skills = m.skills.slice(1)))
  },
  {
    id: 'M2',
    expect: 'R4',
    label: '把 vendored 技能的入口指向不存在的文件 → 入口缺失被拦下',
    apply: (fx) => patchJson(fx.manifest, (m) => (m.skills[3].entry = 'MISSING.md'))
  },
  {
    id: 'M3',
    expect: 'R5+R6',
    label: '给技能塞一个词表外的产物类型 → UI 契约取值被拦下',
    apply: (fx) => patchJson(fx.manifest, (m) => m.skills[0].ui.artifacts.push('hologram'))
  },
  {
    id: 'M4',
    expect: 'R7',
    label: '只改契约、让枚举少一项 → 两处词表漂移被拦下',
    apply: (fx) =>
      patchJson(fx.schema, (s) => {
        const enumList = s.$defs.ui.properties.artifacts.items.enum
        const i = enumList.indexOf('svg')
        enumList.splice(i, 1)
      })
  },
  {
    id: 'M5',
    expect: 'R8',
    label: '删掉中文 README 技能表一行 → 文档与注册表不一致被拦下',
    apply: (fx) => {
      const text = readFileSync(fx.readme, 'utf8')
      const line = text.split('\n').find((l) => l.startsWith('| [`mathmodel-deai`]('))
      if (!line) {
        process.stderr.write('夹具错误: README 里找不到 | [`mathmodel-deai`]( 开头的那一行\n')
        process.exit(2)
      }
      writeFileSync(fx.readme, text.replace(line + '\n', ''), 'utf8')
    }
  },
  {
    id: 'M6',
    expect: 'R9',
    label: '把徽章计数从 7 改成 6 → 徽章说谎被拦下',
    apply: (fx) => patchText(fx.readme, '%E6%8A%80%E8%83%BD-7-', '%E6%8A%80%E8%83%BD-6-')
  },
  {
    id: 'M7',
    expect: 'PARSE',
    label: '注册表写成非法 JSON → 退出 1 而不是崩在读取阶段',
    apply: (fx) => writeFileSync(fx.manifest, '{ "skills": [', 'utf8')
  },
  {
    id: 'M8',
    expect: 'ENV',
    label: '注册表路径不存在 → 退出 2（用法/环境错误），不与校验失败混淆',
    apply: (fx) => rmSync(fx.manifest, { force: true })
  }
]

const rows = []
let baseline = run(buildFixture())
if (baseline.code !== 0 || baseline.parsed?.ok !== true) {
  process.stderr.write(
    `夹具基线就没通过（退出 ${baseline.code}）：\n${baseline.stdout}\n${baseline.stderr}\n夹具不可信，拒绝继续。\n`
  )
  rmSync(base, { recursive: true, force: true })
  process.exit(2)
}
rows.push({ id: 'M0', label: `未改动的夹具退出 0（${baseline.parsed.skills} 个技能，${baseline.parsed.checks.length} 项检查全绿）`, expect: '-', actual: 'exit 0', pass: true })

for (const c of cases) {
  const fx = buildFixture()
  c.apply(fx)
  const out = run(fx)
  let pass
  let actual
  if (c.expect === 'PARSE') {
    pass = out.code === 1
    actual = `exit ${out.code}`
  } else if (c.expect === 'ENV') {
    pass = out.code === 2
    actual = `exit ${out.code}`
  } else {
    const ids = failedIds(out)
    pass = out.code === 1 && ids.includes(c.expect)
    actual = `exit ${out.code}，失败项: ${ids.join(',') || '无'}`
  }
  rows.push({ id: c.id, label: c.label, expect: c.expect, actual, pass })
}

rmSync(base, { recursive: true, force: true })

for (const r of rows) {
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id.padEnd(3)} ${r.label}\n`)
  process.stdout.write(`       期望 ${r.expect} / 实得 ${r.actual}\n`)
}
const bad = rows.filter((r) => !r.pass)
process.stdout.write(`\n${rows.length - bad.length}/${rows.length} 条破坏被门禁抓到（含 1 条夹具基线自证）\n`)
if (bad.length) {
  process.stderr.write('门禁存在假绿：有破坏没被抓到\n')
  process.exit(1)
}
process.exit(0)
