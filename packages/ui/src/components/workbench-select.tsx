import * as React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mioon/ui/components/select'

/** Adapter for the editor's existing scalar fields; all interaction is Base UI Select. */
function WorkbenchSelect({ children, value, onChange, className, disabled, required, name, visible = true, ...props }: Omit<React.ComponentProps<'select'>, 'onChange' | 'value'> & { value?: string | number, visible?: boolean, onChange?: (event: { target: { value: string } }) => void }) {
  const [open, setOpen] = React.useState(false)
  const scope = React.useMemo(() => ({ visible }), [visible])
  const current = React.useRef<typeof scope | null>(scope)
  const trigger = React.useRef<HTMLButtonElement>(null), content = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => { current.current = scope; if (!visible) setOpen(false); return () => { current.current = null } }, [scope, visible])
  const canInteract = () => visible && current.current === scope && !disabled
  const finalFocus = () => {
    const document = trigger.current?.ownerDocument, active = document?.activeElement
    return canInteract() && Boolean(trigger.current?.isConnected && (!active || active === document?.body || active === trigger.current || content.current?.contains(active)))
  }
  const options = React.Children.toArray(children).filter(React.isValidElement).map(child => {
    const option = child as React.ReactElement<React.ComponentProps<'option'>>
    const label = React.Children.toArray(option.props.children).join('')
    return { value: String(option.props.value ?? label), label, disabled: Boolean(option.props.disabled) }
  })
  return <Select value={value == null ? null : String(value)} items={options} disabled={disabled || !visible} required={required} name={name} open={open && visible} onOpenChange={next => { if (canInteract()) setOpen(next) }} onValueChange={next => { if (next !== null && canInteract()) onChange?.({ target: { value: String(next) } }) }}>
    <SelectTrigger {...props as React.ComponentProps<typeof SelectTrigger>} ref={trigger} className={['workbench-select', className].filter(Boolean).join(' ')}><SelectValue /></SelectTrigger>
    <SelectContent ref={content} align="start" alignItemWithTrigger={false} className="workbench-select-popup" finalFocus={visible ? finalFocus : false} hidden={!visible} inert={!visible}>
      {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>
}
export { WorkbenchSelect }
