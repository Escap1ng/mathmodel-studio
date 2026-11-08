import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { chunkAt, chunkBoundaries } from '../lib/md-chunks'
import '../styles/markdown.css'

const remarkPlugins = [remarkGfm, remarkMath]
// rehype-katex 内部已按 throwOnError:false 渲染：坏公式红字原样显示，不炸整条消息
const rehypePlugins = [rehypeKatex]
const COMPONENTS = { pre: PreBlock }

/** 代码块右上角复制：用 pre 的 textContent，保证与渲染源一致 */
function PreBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)

  const copy = async (): Promise<void> => {
    const text = ref.current?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  return (
    <pre ref={ref} data-action="copy-code">
      <button type="button" className="md-copy" onClick={() => void copy()}>
        {copied ? '已复制' : '复制'}
      </button>
      {children}
    </pre>
  )
}

/** 单块渲染：内容字符串不变就跳过（memo），流式时历史块不再重解析。 */
const Chunk = memo(function Chunk({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  )
})

/**
 * 流式分块：切分全按最新文本即时算（便宜），真正昂贵的 Markdown/KaTeX 解析
 * 由 reveal 节流到约 10Hz；停止流式时整段重排一次，保证边界补全后格式完整。
 */
function Chunked({ text, streaming }: { text: string; streaming: boolean }) {
  const [reveal, setReveal] = useState(text)
  const lastRendered = useRef(0)
  const timer = useRef(0)

  useEffect(() => {
    const update = (): void => {
      window.clearTimeout(timer.current)
      timer.current = 0
      lastRendered.current = Date.now()
      setReveal(text)
    }
    if (!streaming) return update()
    const elapsed = Date.now() - lastRendered.current
    if (elapsed >= 95) return update()
    timer.current = window.setTimeout(update, 95 - elapsed)
    return () => window.clearTimeout(timer.current)
  }, [text, streaming])

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
    },
    []
  )

  const bounds = chunkBoundaries(reveal)
  return (
    <>
      {bounds.map((bound, index) => (
        <Chunk
          key={index}
          text={chunkAt(reveal, index === 0 ? 0 : bounds[index - 1] + 2, bound)}
        />
      ))}
      <Chunk text={chunkAt(reveal, (bounds[bounds.length - 1] ?? -2) + 2)} />
    </>
  )
}

/**
 * 助手正文按 Markdown 渲染。容器保留 msg__text（冒烟按 textContent 断言），
 * 外加 markdown 类接管排版；不引 rehype-raw，模型给的 HTML 一律按文本显示。
 * 流式末尾的光标用最后一个块的 ::after 实现，不往 DOM 里塞节点。
 */
function MarkdownViewBase({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`msg__text markdown${streaming ? ' is-streaming' : ''}`}>
      <Chunked text={text} streaming={streaming === true} />
    </div>
  )
}

export default memo(MarkdownViewBase)
