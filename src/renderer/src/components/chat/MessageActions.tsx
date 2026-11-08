import { useEffect, useRef, useState } from 'react'
import { assistantText, type ChatEntry } from '../../lib/chat'
import { copyText } from '../../lib/clipboard'

interface Props {
  entry: ChatEntry
  /** 正常模式的「重新生成」；数模错误重试走消息里的重试按钮 */
  onRegenerate?: (entryId: string) => void
}

/** 助手消息底部的操作行：复制原始 markdown（与渲染源一致）+ 正常模式重新生成。
    不占布局：默认透明，hover 或键盘聚焦时显形。 */
export default function MessageActions({ entry, onRegenerate }: Props) {
  const text = assistantText(entry)
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
    },
    []
  )

  const copy = async (): Promise<void> => {
    if (!text) return
    if (await copyText(text)) {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <div className="msg__actions">
      {text ? (
        <button type="button" className="linkbtn" data-action="copy-message" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      ) : null}
      {onRegenerate ? (
        <button
          type="button"
          className="linkbtn"
          data-action="regenerate"
          onClick={() => onRegenerate(entry.id)}
        >
          重新生成
        </button>
      ) : null}
    </div>
  )
}
