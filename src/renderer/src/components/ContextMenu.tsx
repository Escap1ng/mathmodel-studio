import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  id: string
  label: string
  danger?: boolean
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onSelect: (id: string) => void
  onClose: () => void
}

const MARGIN = 8

// 右键菜单挂在 body 上：面板有滚动容器，留在原地会被裁掉。
export default function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(0)
  // 事件监听只注册一次，用 ref 取最新的回调，避免每次渲染重绑。
  const latest = useRef({ items, active, onSelect, onClose })
  latest.current = { items, active, onSelect, onClose }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - rect.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - rect.height - MARGIN))
    })
  }, [x, y, items.length])

  useEffect(() => {
    ref.current?.focus()
    const onPointer = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node)) return
      latest.current.onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      const { items: list, active: index, onSelect: select, onClose: close } = latest.current
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive(Math.min(list.length - 1, index + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(Math.max(0, index - 1))
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const item = list[index]
        if (item) select(item.id)
      }
    }
    const onDismiss = (): void => latest.current.onClose()
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('blur', onDismiss)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? 'visible' : 'hidden'
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="context-menu__item"
          data-active={index === active ? 'true' : 'false'}
          data-danger={item.danger ? 'true' : undefined}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
