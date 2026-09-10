// Pure keyboard-navigation logic for role="menu" lists, kept UI-free so it can run under `node --test`.

export type MenuNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

// current === -1 means no item currently has focus (e.g. focus is still on the trigger).
export function nextMenuIndex(current: number, key: MenuNavKey, length: number): number {
  if (length <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (current === -1) return key === 'ArrowDown' ? 0 : length - 1
  const delta = key === 'ArrowDown' ? 1 : -1
  return (current + delta + length) % length
}
