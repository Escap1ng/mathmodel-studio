import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PaperState, WorkbenchState } from '../../../../shared/api'
import { errorText, formatSize } from '../../lib/format'

GlobalWorkerOptions.workerSrc = pdfWorker

function pdfBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const raw = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// 已解码的 PDF 按「产物路径#构建时间」缓存：切 tab 再回来免去 base64 解码与重新解析。
// LRU 只留 3 份；被逐出或键变化时连同 loadingTask 一起 destroy。
const PDF_CACHE_LIMIT = 3
interface CachedPdf {
  task: PDFDocumentLoadingTask
  promise: Promise<PDFDocumentProxy>
}
const pdfDocs = new Map<string, CachedPdf>()

function loadPdfDoc(key: string, makeBytes: () => Uint8Array): Promise<PDFDocumentProxy> {
  const hit = pdfDocs.get(key)
  if (hit) {
    pdfDocs.delete(key)
    pdfDocs.set(key, hit)
    return hit.promise
  }
  // 传二进制而不是 data: URL：pdf.js 默认会去 fetch，CSP 的 connect-src 不放行 data:。
  const task = getDocument({ data: makeBytes() })
  const entry: CachedPdf = { task, promise: task.promise }
  pdfDocs.set(key, entry)
  entry.promise.catch(() => {
    if (pdfDocs.get(key) === entry) pdfDocs.delete(key)
  })
  while (pdfDocs.size > PDF_CACHE_LIMIT) {
    const oldestKey = pdfDocs.keys().next().value as string | undefined
    if (oldestKey == null) break
    const oldest = pdfDocs.get(oldestKey)
    pdfDocs.delete(oldestKey)
    void oldest?.task.destroy().catch(() => undefined)
  }
  return entry.promise
}

function PdfPreview({
  data,
  cacheKey,
  page,
  onPage,
  onPages
}: {
  data: string
  cacheKey: string
  page: number
  onPage: (page: number) => void
  onPages?: (pages: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const [pages, setPages] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setPages(0)
    onPages?.(0)
    setError(null)
    loadPdfDoc(cacheKey, () => pdfBytes(dataRef.current))
      .then((doc) => {
        if (!alive) return
        docRef.current = doc
        setPages(doc.numPages)
        onPages?.(doc.numPages)
        if (page > doc.numPages) onPage(doc.numPages)
      })
      .catch((err: unknown) => {
        if (alive) setError(errorText(err))
      })
    return () => {
      alive = false
      docRef.current = null
    }
    // page/onPage 只用于越界回夹，不参与重载
  }, [cacheKey])

  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || pages === 0) return
    let alive = true
    doc
      .getPage(page)
      .then(async (pdfPage) => {
        const viewport = pdfPage.getViewport({ scale: 1.4 })
        if (!alive) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise
      })
      .catch((err: unknown) => {
        if (alive) setError(errorText(err))
      })
    return () => {
      alive = false
    }
  }, [page, pages])

  return (
    <div className="paper-preview" data-role="paper-preview">
      {error ? <div className="panel__error" role="alert">{error}</div> : null}
      <canvas ref={canvasRef} aria-label={`论文第 ${page} 页`} />
      {pages > 1 ? (
        <div className="paper-pager">
          <button type="button" className="linkbtn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            上一页
          </button>
          <span>
            {page} / {pages}
          </span>
          <button type="button" className="linkbtn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            下一页
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default function PaperPanel({
  state,
  building,
  error,
  page,
  onPage,
  onBuild
}: {
  state: WorkbenchState
  building: boolean
  error: string | null
  page: number
  onPage: (page: number) => void
  onBuild: () => void
}) {
  const paper: PaperState = state.paper
  const built = Boolean(paper.builtAt)
  const [pdfPages, setPdfPages] = useState(0)
  const pdfSize = paper.artifacts.pdf?.size
  const summary = built
    ? [pdfPages ? `${pdfPages} 页` : null, pdfSize ? formatSize(pdfSize) : null].filter(Boolean).join(' · ')
    : ''
  return (
    <div className="panel" data-panel="paper">
      <div className="panel__bar">
        <span className="panel__meta" data-role="paper-summary">
          {summary || '尚未构建'}
        </span>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          data-action="build-paper"
          disabled={building || !paper.env.ok}
          onClick={onBuild}
        >
          {building ? '编译中…' : built ? '重新构建' : '构建论文'}
        </button>
      </div>

      {paper.env.ok ? (
        <p className="panel__hint">
          {paper.env.xelatex.version || 'xelatex'} · {paper.env.pandoc.version || 'pandoc'} · 演示稿真跑
          xelatex → pandoc → 去 AI 与章节门禁
        </p>
      ) : (
        <div className="panel__error" role="alert">
          缺少排版工具：{paper.env.missing.join('、')}。pandoc 可放到
          %LOCALAPPDATA%\mms-tools\pandoc.exe 或加入 PATH；xelatex 由 MiKTeX 或 TeX Live 提供。
        </div>
      )}

      {error ? <div className="panel__error" role="alert">{error}</div> : null}
      {paper.error ? <div className="panel__error" role="alert" data-role="paper-error">{paper.error}</div> : null}

      <div className="paper-layout">
        <div className="paper-layout__preview">
          {paper.pdfData ? (
            <PdfPreview
              data={paper.pdfData}
              cacheKey={`${paper.artifacts.pdf?.path ?? 'paper'}#${paper.builtAt ?? paper.artifacts.pdf?.size ?? 0}`}
              page={page}
              onPage={onPage}
              onPages={setPdfPages}
            />
          ) : built ? (
            <div className="panel__empty">
              <p>上次构建的 PDF 不在了，重新构建一次。</p>
            </div>
          ) : (
            <div className="panel__empty">
              <p>还没有论文产物。</p>
              <ol className="empty-steps">
                <li>把 paper.tex 放进工作区</li>
                <li>xelatex 编 PDF，pandoc 转 DOCX</li>
                <li>三道门禁：去 AI 措辞、结构指标、章节骨架</li>
              </ol>
              <p className="panel__hint">点右上角「构建论文」开始；缺工具时上方会写明安装位置。</p>
            </div>
          )}
        </div>

        <div className="paper-layout__side">
          {paper.steps.length ? (
            <ul className="paper-steps" data-role="paper-steps">
              {paper.steps.map((step) => (
                <li key={step.id} data-ok={step.ok ? 'true' : 'false'} data-step={step.id}>
                  <span className="paper-steps__dot" aria-hidden="true" />
                  <span className="paper-steps__label">{step.label}</span>
                  <span className="paper-steps__detail">{step.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {paper.gates.length ? (
            <div className="paper-gates" data-role="paper-gates">
              {paper.gates.map((gate) => (
                <span
                  key={gate.id}
                  className="paper-gate"
                  data-gate={gate.id}
                  data-ok={gate.ok ? 'true' : 'false'}
                  title={gate.detail}
                >
                  <span className="paper-gate__dot" aria-hidden="true" />
                  {gate.label} · {gate.detail}
                </span>
              ))}
            </div>
          ) : null}

          {Object.keys(paper.artifacts).length ? (
            <div className="paper-artifacts" data-role="paper-artifacts">
              {Object.entries(paper.artifacts).map(([kind, file]) => (
                <div className="paper-artifact" key={kind}>
                  <span>{kind.toUpperCase()}</span>
                  <code title={file.path}>{file.path.split(/[\\/]/).pop()}</code>
                  <span>{formatSize(file.size)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {built ? <p className="panel__meta">构建于 {paper.builtAt}</p> : null}

          {paper.logTail ? (
            <details className="paper-log">
              <summary>编译日志尾部</summary>
              <pre className="code-block code-block--log">{paper.logTail}</pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  )
}
