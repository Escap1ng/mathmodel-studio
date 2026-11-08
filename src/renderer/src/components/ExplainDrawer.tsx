import { useEffect, useRef } from 'react'
import type { ModelCandidate } from './DecisionCard'

interface Props {
  candidate: ModelCandidate
  open: boolean
  onClose: () => void
}

const SECTIONS: { key: keyof ModelCandidate['explain']; label: string }[] = [
  { key: 'math', label: '数学形式' },
  { key: 'fit', label: '为何适配本题' },
  { key: 'diff', label: '与未选方案的差异' },
  { key: 'verify', label: '验证方式' },
  { key: 'eta', label: '预计运行时间' },
  { key: 'source', label: '规范条文' }
]

export default function ExplainDrawer({ candidate, open, onClose }: Props) {
  const closeBtn = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    // 记住触发按钮，关闭后焦点原路回去；打开即聚焦关闭键，键盘走 tab/esc 可用。
    returnFocus.current = document.activeElement as HTMLElement | null
    closeBtn.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (open) return
    const target = returnFocus.current
    if (target && document.contains(target)) target.focus()
    returnFocus.current = null
  }, [open])

  return (
    <aside
      className="drawer"
      role="dialog"
      aria-label="方法解释"
      data-drawer="explain"
      data-open={open ? 'true' : 'false'}
      aria-hidden={open ? undefined : 'true'}
    >
      <div className="drawer__head">
        <span className="drawer__kicker">决策点 K4 · 就地解释</span>
        <h2 className="drawer__title">{candidate.name}</h2>
        <button
          type="button"
          ref={closeBtn}
          className="btn btn--ghost btn--sm"
          data-action="close-drawer"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      <div className="drawer__body">
        {SECTIONS.map(({ key, label }) => (
          <section className="drawer__section" key={key} data-section={key}>
            <h3>{label}</h3>
            {key === 'math' ? (
              <p className="drawer__math">{candidate.explain.math || '本方法没有给出显式公式。'}</p>
            ) : (
              <p>{candidate.explain[key] || '暂无'}</p>
            )}
          </section>
        ))}
      </div>
      <p className="drawer__note">打开解释不会清除待选；关闭后仍可继续选择。</p>
    </aside>
  )
}
