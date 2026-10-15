import * as React from 'react'
import { Button } from '@mioon/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mioon/ui/components/dialog'

export type ConfirmationMessage = string | Readonly<{ key: string; params?: Readonly<Record<string, string | number>> }>
type Confirm = (message: ConfirmationMessage) => Promise<boolean>
const ConfirmationContext = React.createContext<Confirm | null>(null)

/** Explicit, cancellable editor confirmations. Concurrent requests never auto-approve. */
function ConfirmationProvider({ children, labels = { title: '请确认此操作', cancel: '取消', continue: '继续' }, renderMessage = value => typeof value === 'string' ? value : '' }: { children: React.ReactNode; labels?: { title: string; cancel: string; continue: string }; renderMessage?: (message: ConfirmationMessage) => React.ReactNode }) {
  const [message, setMessage] = React.useState<ConfirmationMessage | null>(null)
  const pending = React.useRef<((answer: boolean) => void) | null>(null)
  const cancel = React.useRef<HTMLButtonElement>(null)
  const settle = React.useCallback((answer: boolean) => {
    const resolve = pending.current
    pending.current = null
    setMessage(null)
    resolve?.(answer)
  }, [])
  const confirm = React.useCallback<Confirm>(next => {
    if (pending.current) return Promise.resolve(false)
    return new Promise(resolve => { pending.current = resolve; setMessage(next) })
  }, [])
  React.useEffect(() => () => { pending.current?.(false); pending.current = null }, [])
  return <ConfirmationContext.Provider value={confirm}>{children}
    <Dialog open={message !== null} onOpenChange={open => { if (!open) settle(false) }}>
      <DialogContent className="workbench-confirm" showCloseButton={false} initialFocus={cancel}>
        <DialogTitle>{labels.title}</DialogTitle>
        <DialogDescription>{message === null ? '' : renderMessage(message)}</DialogDescription>
        <div className="workbench-confirm-actions">
          <Button ref={cancel} variant="outline" onClick={() => settle(false)}>{labels.cancel}</Button>
          <Button onClick={() => settle(true)} data-testid="confirm-action">{labels.continue}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </ConfirmationContext.Provider>
}
function useConfirmation() {
  const confirm = React.useContext(ConfirmationContext)
  if (!confirm) throw new Error('useConfirmation requires ConfirmationProvider')
  return confirm
}
export { ConfirmationProvider, useConfirmation }
