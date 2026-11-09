import type { AttachmentRef } from '../../lib/attachments'
import { formatSize } from '../../lib/format'

function badge(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : 'FILE'
}

export default function FileChips({
  items,
  onRemove,
  label = '附件'
}: {
  items: AttachmentRef[]
  onRemove?: (index: number) => void
  label?: string
}) {
  if (items.length === 0) return null
  return (
    <ul className="file-chips" aria-label={label}>
      {items.map((item, index) => (
        <li className="file-chip" key={`${item.name}-${index}`}>
          <span className="file-chip__kind">{badge(item.name)}</span>
          <span className="file-chip__name" title={item.name}>
            {item.name}
          </span>
          {typeof item.size === 'number' ? (
            <span className="file-chip__size">{formatSize(item.size)}</span>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              className="file-chip__remove"
              aria-label={`移除 ${item.name}`}
              onClick={() => onRemove(index)}
            >
              ×
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
