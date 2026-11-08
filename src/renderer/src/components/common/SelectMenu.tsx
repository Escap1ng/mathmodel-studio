import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface SelectOption {
  id: string
  title: string
}

interface Props {
  label: string
  value: string
  options: SelectOption[]
  dataRole: string
  onChange: (value: string) => void
}

const MAX_HEIGHT = 320
const GAP = 4
const MARGIN = 12
const OPTION_HEIGHT = 27

export default function SelectMenu({ label, value, options, dataRole, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; maxWidth: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value))
  const selected = options[selectedIndex]

  const measure = (): typeof pos => {
    const trigger = triggerRef.current
    if (!trigger) return null
    const rect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN
    const spaceAbove = rect.top - MARGIN
    const wanted = Math.min(MAX_HEIGHT, options.length * OPTION_HEIGHT + 10)
    const below = spaceBelow >= wanted || spaceBelow >= spaceAbove
    const maxHeight = Math.max(120, Math.min(MAX_HEIGHT, below ? spaceBelow : spaceAbove))
    return {
      left: rect.left,
      top: below ? rect.bottom + GAP : rect.top - Math.min(wanted, maxHeight) - GAP,
      width: rect.width,
      maxHeight,
      maxWidth: Math.max(200, window.innerWidth - rect.left - MARGIN)
    }
  }

  const close = (focusTrigger: boolean): void => {
    setOpen(false)
    if (focusTrigger) triggerRef.current?.focus()
  }

  const commit = (index: number): void => {
    const option = options[index]
    if (option && option.id !== value) onChange(option.id)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const reposition = (): void => setPos(measure())
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
    // measure 只读 DOM，不随渲染变化
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    popupRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setActive(selectedIndex)
        setPos(measure())
        setOpen(true)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(options.length - 1, index + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => Math.max(0, index - 1))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(active)
        break
      case 'Escape':
        event.preventDefault()
        close(true)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  return (
    <div className="control">
      <span>{label}</span>
      <button
        type="button"
        ref={triggerRef}
        className="select-trigger"
        data-role={dataRole}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(false)
            return
          }
          setActive(selectedIndex)
          setPos(measure())
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
      >
        <span className="select-trigger__text">{selected?.title ?? ''}</span>
        <span className="select-trigger__chevron" aria-hidden="true" />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={popupRef}
              className="select-popup"
              role="listbox"
              aria-label={label}
              data-role={`${dataRole}-menu`}
              style={{
                left: pos.left,
                top: pos.top,
                minWidth: pos.width,
                maxWidth: pos.maxWidth,
                maxHeight: pos.maxHeight
              }}
            >
              {options.map((option, index) => (
                <div
                  key={option.id}
                  role="option"
                  className="select-popup__option"
                  aria-selected={option.id === value}
                  data-active={index === active ? 'true' : 'false'}
                  data-value={option.id}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(index)}
                >
                  {option.title}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
