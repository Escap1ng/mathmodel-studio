#!/usr/bin/env node
/**
 * 由 build/icon.svg 生成 build/icon.png（1024）与 build/icon.ico（16–256 多尺寸）。
 *
 * 栅格化用 PyMuPDF（requirements.txt 已含），ico 用 Vista+ 的 PNG 条目手工封装——
 * 不引第三方图标库，也保证 exe/任务栏/安装包拿到同一份图形。
 *
 *   node scripts/make-icon.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const RASTER = `
import fitz
page = fitz.open(${JSON.stringify(join(BUILD, 'icon.svg'))})[0]
for size in ${JSON.stringify(SIZES)}:
    page.get_pixmap(matrix=fitz.Matrix(size / 1024.0, size / 1024.0), alpha=True).save(
        ${JSON.stringify(BUILD)} + '/icon-%d.png' % size)
page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=True).save(${JSON.stringify(join(BUILD, 'icon.png'))})
`

const render = spawnSync('python', ['-c', RASTER], { cwd: ROOT, stdio: 'inherit' })
if (render.error) {
  console.error(`[icon] 无法执行 python：${render.error.message}`)
  process.exit(1)
}
if (render.status !== 0) process.exit(render.status ?? 1)

function pngSize(buffer) {
  // PNG IHDR 的宽高固定在第 16–24 字节
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const images = []
for (const size of SIZES) {
  const buffer = await readFile(join(BUILD, `icon-${size}.png`))
  const actual = pngSize(buffer)
  if (actual.width !== size || actual.height !== size) {
    console.error(`[icon] icon-${size}.png 实际是 ${actual.width}x${actual.height}`)
    process.exit(1)
  }
  images.push({ size, buffer })
}

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

const directory = Buffer.alloc(16 * images.length)
let offset = header.length + directory.length
images.forEach(({ size, buffer }, index) => {
  const base = index * 16
  directory.writeUInt8(size === 256 ? 0 : size, base)
  directory.writeUInt8(size === 256 ? 0 : size, base + 1)
  directory.writeUInt8(0, base + 2)
  directory.writeUInt8(0, base + 3)
  directory.writeUInt16LE(1, base + 4)
  directory.writeUInt16LE(32, base + 6)
  directory.writeUInt32LE(buffer.length, base + 8)
  directory.writeUInt32LE(offset, base + 12)
  offset += buffer.length
})

await writeFile(join(BUILD, 'icon.ico'), Buffer.concat([header, directory, ...images.map((i) => i.buffer)]))
for (const size of SIZES) await rm(join(BUILD, `icon-${size}.png`))

console.log(`[icon] build/icon.png 1024x1024，build/icon.ico ${images.map((i) => i.size).join('/')}`)
