import * as React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@video-workbench/ui/components/select'

/** Adapter for the editor's existing scalar fields; all interaction is Base UI Select. */
function WorkbenchSelect({ children, value, onChange, className, disabled, required, name, ...props }: Omit<React.ComponentProps<'select'>, 'onChange' | 'value'> & { value?: string | number, onChange?: (event: { target: { value: string } }) => void }) {
  const options = React.Children.toArray(children).filter(React.isValidElement).map(child => {
    const option = child as React.ReactElement<React.ComponentProps<'option'>>
    const label = React.Children.toArray(option.props.children).join('')
    return { value: String(option.props.value ?? label), label, disabled: Boolean(option.props.disabled) }
  })
  return <Select value={value == null ? null : String(value)} items={options} disabled={disabled} required={required} name={name} onValueChange={next => { if (next !== null) onChange?.({ target: { value: String(next) } }) }}>
    <SelectTrigger {...props as React.ComponentProps<typeof SelectTrigger>} className={['workbench-select', className].filter(Boolean).join(' ')}><SelectValue /></SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false} className="workbench-select-popup">
      {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>
}
export { WorkbenchSelect }
