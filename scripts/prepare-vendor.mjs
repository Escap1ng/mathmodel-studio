#!/usr/bin/env node
/**
 * M6 随包工具链准备。只在 Windows 开发机上执行，产物落 vendor/，不入库。
 *
 *   node scripts/prepare-vendor.mjs python [--force]
 *   node scripts/prepare-vendor.mjs pandoc [--force]
 *
 * python: python-build-standalone 的解压版解释器（npmmirror 通道）解到 vendor/python，
 *         再按 requirements.txt 装依赖，最后逐个 import 自检。
 * pandoc: 把本机 pandoc.exe 复制到 vendor/pandoc。pandoc 是 GPL-2.0-or-later，
 *         随安装包分发时需要保留上游许可与源码指引（见 docs/env-setup.md）。
 *
 * 下载地址与版本都在下面常量里，换版本时改这两行；失败先换通道再下结论。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'vendor')

const PBS_TAG = process.env['MMS_PBS_TAG'] || '20261026'
const PY_VERSION = process.env['MMS_PY_VERSION'] || '3.12.16'
const PBS_BASE =
  process.env['MMS_PBS_BASE'] || 'https://registry.npmmirror.com/-/binary/python-build-standalone'
// npmmirror 的 PyPI 代理已 404（2026-10-31 实测），改用 TUNA；腾讯云同样可用：
// https://mirrors.cloud.tencent.com/pypi/simple/
const PIP_INDEX = process.env['MMS_PIP_INDEX'] || 'https://pypi.tuna.tsinghua.edu.cn/simple/'

const PY_ASSET = `cpython-${PY_VERSION}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`
const PY_URL = `${PBS_BASE}/${PBS_TAG}/${PY_ASSET}`
const PY_DIR = join(VENDOR, 'python')
const PY_EXE = join(PY_DIR, 'python.exe')
const PANDOC_DIR = join(VENDOR, 'pandoc')
const PANDOC_EXE = join(PANDOC_DIR, 'pandoc.exe')
const MODULES = ['matplotlib', 'numpy', 'seaborn', 'docx', 'fitz', 'jsonschema']

function log(message) {
  console.log(`[vendor] ${message}`)
}

function fail(message) {
  console.error(`[vendor] 失败：${message}`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    ...options
  })
  if (result.error) fail(`${cmd} 无法执行：${result.error.message}`)
  if (result.status !== 0) fail(`${cmd} 退出码 ${result.status}`)
  return result
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function download(url, target) {
  log(`下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText}`)
  const total = Number(response.headers.get('content-length') || 0)
  const chunks = []
  let received = 0
  let lastLog = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    received += chunk.length
    if (received - lastLog >= 10 * 1024 * 1024) {
      lastLog = received
      const mb = (received / 1024 / 1024).toFixed(1)
      log(total ? `已下载 ${mb} / ${(total / 1024 / 1024).toFixed(1)} MB` : `已下载 ${mb} MB`)
    }
  }
  const buffer = Buffer.concat(chunks)
  if (total && buffer.length !== total) {
    fail(`下载不完整：${buffer.length} / ${total} 字节`)
  }
  await writeFile(target, buffer)
  const sha = createHash('sha256').update(buffer).digest('hex')
  log(`落盘 ${target}（${(buffer.length / 1024 / 1024).toFixed(1)} MB，sha256 ${sha}）`)
  return sha
}

async function preparePython(force) {
  if (await exists(PY_EXE)) {
    if (!force) {
      log(`vendor/python 已存在（${PY_EXE}），要重装加 --force`)
      return
    }
    log('移除旧的 vendor/python')
    await rm(PY_DIR, { recursive: true, force: true })
  }
  await mkdir(join(VENDOR, '.downloads'), { recursive: true })
  const archive = join(VENDOR, '.downloads', PY_ASSET)
  let sha = ''
  if (await exists(archive)) {
    log(`复用已下载的 ${PY_ASSET}（要重下先删 vendor/.downloads）`)
    sha = createHash('sha256').update(await readFile(archive)).digest('hex')
  } else {
    sha = await download(PY_URL, archive)
  }

  // 不用 PATH 上的 tar：Git for Windows 带的是 GNU tar，会把 "D:\..." 里的冒号当远程主机。
  log('解压（包内的 python/ 直接铺成 vendor/python）')
  const extract = spawnSync(
    process.env['MMS_SYSTEM_PYTHON'] || 'python',
    [
      '-c',
      'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter="data")',
      archive,
      VENDOR
    ],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (extract.error) fail(`解压需要系统 Python：${extract.error.message}`)
  if (extract.status !== 0) fail(`解压失败（退出码 ${extract.status}）`)
  if (!(await exists(PY_EXE))) fail(`解压后没找到 ${PY_EXE}`)

  const version = run(PY_EXE, ['-c', 'import sys; print(sys.version)'], { stdio: 'pipe' })
  log(`解释器就绪：${String(version.stdout).trim().split('\n')[0]}`)

  log(`安装 requirements.txt（索引 ${PIP_INDEX}）`)
  run(PY_EXE, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '-r',
    join(ROOT, 'requirements.txt'),
    '-i',
    PIP_INDEX
  ])

  log(`自检 import：${MODULES.join(', ')}`)
  const check = run(PY_EXE, ['-c', `import ${MODULES.join(', ')}; print("ok")`], {
    stdio: 'pipe'
  })
  const lines = String(check.stdout).trim().split(/\r?\n/)
  if (lines[lines.length - 1].trim() !== 'ok') fail(`import 自检输出异常：${String(check.stdout).trim()}`)

  const size = run('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-ChildItem -Recurse '${PY_DIR}' | Measure-Object -Property Length -Sum).Sum`
  ], { stdio: 'pipe' })
  const bytes = Number(String(size.stdout).trim())
  log(`vendor/python 体积 ${(bytes / 1024 / 1024).toFixed(0)} MB`)

  await writeFile(
    join(PY_DIR, '.mms-runtime.json'),
    JSON.stringify(
      { python: PY_VERSION, tag: PBS_TAG, asset: PY_ASSET, url: PY_URL, sha256: sha, index: PIP_INDEX },
      null,
      2
    ) + '\n',
    'utf8'
  )
  log('完成：vendor/python/.mms-runtime.json 记录了来源与校验值')
}

async function preparePandoc(force) {
  if ((await exists(PANDOC_EXE)) && !force) {
    log(`vendor/pandoc 已存在（${PANDOC_EXE}），要覆盖加 --force`)
    return
  }
  const sources = [
    process.env['MMS_PANDOC'],
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'mms-tools', 'pandoc.exe')
  ].filter(Boolean)
  let source = null
  for (const candidate of sources) {
    if (await exists(candidate)) {
      source = candidate
      break
    }
  }
  if (!source) {
    const found = spawnSync('where', ['pandoc'], { encoding: 'utf8' })
    const first = String(found.stdout || '').trim().split(/\r?\n/)[0]
    if (first && (await exists(first))) source = first
  }
  if (!source) {
    fail('本机没找到 pandoc.exe：设 MMS_PANDOC，或装到 %LOCALAPPDATA%\\mms-tools\\pandoc.exe')
  }

  await mkdir(PANDOC_DIR, { recursive: true })
  log(`复制 ${source} → ${PANDOC_EXE}`)
  await copyFile(source, PANDOC_EXE)
  const version = run(PANDOC_EXE, ['--version'], { stdio: 'pipe' })
  const first = String(version.stdout).trim().split('\n')[0]
  const size = (await stat(PANDOC_EXE)).size
  log(`pandoc 就绪：${first}（${(size / 1024 / 1024).toFixed(0)} MB）`)

  const other = (await readdir(PANDOC_DIR)).filter((name) => name !== 'pandoc.exe')
  if (other.length) log(`注意：vendor/pandoc 下还有 ${other.join(', ')}，打包只带 pandoc.exe`)
}

const command = process.argv[2]
const force = process.argv.includes('--force')

if (process.platform !== 'win32') {
  fail('M6 只做 Windows 安装包，这个脚本依赖 tar 与 python.exe')
}

if (command === 'python') {
  await preparePython(force)
} else if (command === 'pandoc') {
  await preparePandoc(force)
} else {
  fail('用法：node scripts/prepare-vendor.mjs python|pandoc [--force]')
}
