// Shared by existing confirmation dialogs and the compact cost sheet.
export function containDialogFocus(event: KeyboardEvent, element?: HTMLElement) {
  if (event.key !== 'Tab' || !element) return
  const focusable = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first) { event.preventDefault(); element.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) {
    event.preventDefault(); first.focus()
  }
}
