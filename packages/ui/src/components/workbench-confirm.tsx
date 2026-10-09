import * as React from 'react'
import { Button } from '@video-workbench/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@video-workbench/ui/components/dialog'

type Confirm = (message: string) => Promise<boolean>
const ConfirmationContext = React.createContext<Confirm | null>(null)

/** Explicit, cancellable editor confirmations. Concurrent requests never auto-approve. */
function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = React.useState<string | null>(null)
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
        <DialogTitle>请确认此操作</DialogTitle>
        <DialogDescription>{message}</DialogDescription>
        <div className="workbench-confirm-actions">
          <Button ref={cancel} variant="outline" onClick={() => settle(false)}>取消</Button>
          <Button onClick={() => settle(true)} data-testid="confirm-action">继续</Button>
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
