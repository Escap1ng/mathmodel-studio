#!/usr/bin/env node
/**
 * xlsx 读取自检：用内存里拼出的最小工作簿跑 src/main/xlsx.ts。
 *
 * 覆盖共享字符串与富文本、拼音剔除、内联字符串、稀疏列、布尔/错误/公式缓存值、
 * 日期与时间格式、1904 日期系统、行列表数上限，以及两种坏文件必须报错。
 * 退出码：0 通过 / 1 断言失败 / 2 环境错误。
 */
import { crc32, deflateRawSync } from 'node:zlib'

const USAGE = '用法: node scripts/check-xlsx.mjs [-h]'

function failUsage(message) {
  process.stderr.write(`用法或环境错误: ${message}\n${USAGE}\n`)
  process.exit(2)
}

for (const arg of process.argv.slice(2)) {
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(USAGE + '\n')
    process.exit(0)
  }
  failUsage(`未知参数: ${arg}`)
}

function zip(parts) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(data)
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += 30 + nameBytes.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(parts).length, 8)
  end.writeUInt16LE(Object.keys(parts).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function workbook({ date1904 = false, sheets, shared, styles }) {
  const sheetTags = sheets
    .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  const rels = sheets
    .map(
      (sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheet.target}"/>`
    )
    .join('')
  return zip({
    'xl/workbook.xml': `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets>${sheetTags}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    'xl/sharedStrings.xml': shared,
    'xl/styles.xml': styles,
    ...Object.fromEntries(sheets.map((sheet) => [sheet.path, sheet.xml]))
  })
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><cellXfs count="4"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/><xf numFmtId="20" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`

const SHARED = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>地区</t></si><si><t>华东 &amp; 华南</t></si><si><r><rPr><b/></rPr><t>销量</t></r><r><t>合计</t></r></si><si><t>带</t><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si></sst>`

const SHEET1 = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>备注</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12.5</v></c><c r="C2" s="1"><v>45999</v></c><c r="D2" t="b"><v>1</v></c></row><row r="3"><c r="A3" s="2"><v>45999.5</v></c><c r="B3" s="3"><v>0.75</v></c><c r="C3" t="str"><f>SUM(B2)</f><v>行合计</v></c><c r="D3" t="e"><v>#DIV/0!</v></c></row><row r="4"><c r="B4" t="s"><v>999</v></c></row><row r="5"><c r="A5"><v>7</v></c><c r="C5" t="s"><v>3</v></c><c r="E5"><v>9</v></c></row></sheetData></worksheet>`

const SHEET2 = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`

const MAIN_TEXT = [
  '[工作表 数据&表] 4 行 × 5 列',
  '地区\t销量合计\t\t备注',
  '华东 & 华南\t12.5\t2025-12-08\tTRUE',
  '2025-12-08 12:00:00\t18:00:00\t行合计\t#DIV/0!',
  '7\t\t带\t\t9',
  '',
  '[工作表 第二页] 空表'
].join('\n')

const expected = {
  text: MAIN_TEXT,
  note: '2 个工作表；数据&表 4 行 × 5 列、第二页 空表'
}

const checks = []
function check(name, run) {
  try {
    const detail = run()
    checks.push({ name, ok: true, detail })
  } catch (err) {
    checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

function equal(actual, want, label) {
  if (actual !== want) {
    throw new Error(`${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(want)}`)
  }
}

function includes(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label}：找不到 ${JSON.stringify(needle)}`)
}

let extractXlsx
try {
  ;({ extractXlsx } = await import('../src/main/xlsx.ts'))
} catch (err) {
  failUsage(`加载 src/main/xlsx.ts 失败（需要 Node 22.18+）: ${err.message}`)
}
if (typeof extractXlsx !== 'function') failUsage('src/main/xlsx.ts 没有导出 extractXlsx')

const main = workbook({
  sheets: [
    { name: '数据&amp;表', target: 'worksheets/sheet1.xml', path: 'xl/worksheets/sheet1.xml', xml: SHEET1 },
    { name: '第二页', target: '/xl/worksheets/sheet2.xml', path: 'xl/worksheets/sheet2.xml', xml: SHEET2 }
  ],
  shared: SHARED,
  styles: STYLES
})

check('主工作表：文本与表头', () => {
  const out = extractXlsx(main)
  equal(out.text, expected.text, '正文不一致')
  return '两表文本一致'
})

check('主工作表：说明含行×列', () => {
  const out = extractXlsx(main)
  equal(out.note, expected.note, '说明不一致')
  return out.note
})

check('共享字符串：实体、富文本拼合、拼音剔除', () => {
  const out = extractXlsx(main)
  includes(out.text, '华东 & 华南', 'XML 实体')
  includes(out.text, '销量合计', '富文本')
  if (out.text.includes('PHONETIC')) throw new Error('拼音行没有剔除')
  return '实体/富文本/拼音均正确'
})

check('稀疏列与日期时间', () => {
  const out = extractXlsx(main)
  includes(out.text, '2025-12-08\tTRUE', '日期列')
  includes(out.text, '2025-12-08 12:00:00\t18:00:00', '自定义日期与时间格式')
  includes(out.text, '7\t\t带\t\t9', '空列补齐')
  return '日期/时间/空列正确'
})

const longSheet = `${XML_HEAD}<worksheet><sheetData>${Array.from(
  { length: 305 },
  (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index + 1}</v></c></row>`
).join('')}</sheetData></worksheet>`

check('行数上限：只读 300 行并写入说明', () => {
  const out = extractXlsx(
    workbook({
      sheets: [{ name: '长表', target: 'worksheets/sheet1.xml', path: 'xl/worksheets/sheet1.xml', xml: longSheet }],
      shared: SHARED,
      styles: STYLES
    })
  )
  const lines = out.text.split('\n')
  equal(lines.length, 301, '正文行数')
  if (lines[300] !== '300') throw new Error(`第 300 行不是 300：${JSON.stringify(lines[300])}`)
  if (lines.includes('301')) throw new Error('第 301 行不该读入')
  includes(out.note, '每个工作表最多 300 行', '截断说明')
  return out.note
})

check('日期格式不带时间：小数部分不显示', () => {
  const xml = `${XML_HEAD}<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>45999.5</v></c></row></sheetData></worksheet>`
  const out = extractXlsx(
    workbook({
      sheets: [{ name: '日期', target: 'worksheets/sheet1.xml', path: 'xl/worksheets/sheet1.xml', xml }],
      shared: SHARED,
      styles: STYLES
    })
  )
  includes(out.text, '2025-12-08', '日期')
  if (out.text.includes('12:00:00')) throw new Error('日期格式不该带出时间')
  return '2025-12-08'
})

check('1904 日期系统', () => {
  const xml = `${XML_HEAD}<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>`
  const out = extractXlsx(
    workbook({
      date1904: true,
      sheets: [{ name: '日期', target: 'worksheets/sheet1.xml', path: 'xl/worksheets/sheet1.xml', xml }],
      shared: SHARED,
      styles: STYLES
    })
  )
  includes(out.text, '1904-01-02', '序列号 1')
  return '1904-01-02'
})

check('图表页不当作空表', () => {
  const wb = zip({
    'xl/workbook.xml': `${XML_HEAD}<workbook><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="图表" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEAD}<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
    'xl/sharedStrings.xml': SHARED,
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': SHEET2,
    'xl/chartsheets/sheet1.xml': `${XML_HEAD}<chartsheet/>`
  })
  const out = extractXlsx(wb)
  equal(out.note, '1 个工作表；数据 空表', '说明')
  if (out.text.includes('图表')) throw new Error('图表页不该出现在正文里')
  return out.note
})

check('坏文件：不是 ZIP', () => {
  let message = ''
  try {
    extractXlsx(Buffer.from('not a zip at all'))
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  includes(message, '缺少压缩目录', '错误说明')
  return message
})

check('坏文件：ZIP 里没有工作簿', () => {
  let message = ''
  try {
    extractXlsx(zip({ 'xl/worksheets/sheet1.xml': SHEET1 }))
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  includes(message, '缺少工作簿', '错误说明')
  return message
})

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}\n`)
}
if (failed.length > 0) {
  process.stderr.write(`\n${failed.length}/${checks.length} 条未通过\n`)
  process.exit(1)
}
process.stdout.write(`\nOK ${checks.length}/${checks.length}\n`)
