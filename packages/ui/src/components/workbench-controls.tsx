import React from 'react'
import { Button } from '@mioon/ui/components/button'
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible'
import { DialogContent, DialogDescription, DialogTitle } from '@mioon/ui/components/dialog'
import { cn } from '@mioon/ui/lib/utils'

export type WorkbenchTone = 'neutral' | 'danger' | 'warning' | 'success'
export type WorkbenchMediaKind = 'video' | 'image' | 'audio' | 'subtitle'
export type WorkbenchButtonProps = Omit<React.ComponentProps<typeof Button>, 'variant' | 'size'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'icon'
  size?: 'compact' | 'default' | 'large'
  loading?: boolean
}

/** Application styling stays outside the pinned registry component. The class
 * survives TooltipTrigger's data-slot replacement and Base UI render merging. */
export function WorkbenchButton({ variant = 'secondary', size = 'default', loading = false, disabled, className, children, ...props }: WorkbenchButtonProps) {
  return <Button {...props} variant="ghost" size={size === 'compact' ? 'xs' : size === 'large' ? 'lg' : 'sm'}
    disabled={disabled || loading} aria-busy={loading || undefined} data-variant={variant} data-size={size}
    className={cn('wb-button', className)}>
    {loading && <span className="wb-spinner" aria-hidden="true" />}{children}
  </Button>
}

export interface WorkbenchTabOption {
  readonly value: string
  readonly label: React.ReactNode
  readonly disabled?: boolean
  readonly testId?: string
}
export interface WorkbenchTabsProps {
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly options: readonly WorkbenchTabOption[]
  readonly label: string
  readonly appearance?: 'segmented' | 'underline'
  readonly className?: string
  readonly children?: React.ReactNode
}

/** Uses Base UI's manual activation and roving focus rather than click-only tabs. */
export function WorkbenchTabs({ value, onValueChange, options, label, appearance = 'segmented', className, children }: WorkbenchTabsProps) {
  return <Tabs value={value} onValueChange={next => {
    if (typeof next === 'string' && options.some(option => option.value === next && !option.disabled)) onValueChange(next)
  }} className={cn('wb-tabs', className)} data-appearance={appearance}>
    <TabsList aria-label={label} activateOnFocus={false} variant={appearance === 'underline' ? 'line' : 'default'}>
      {options.map(option => <TabsTrigger key={option.value} value={option.value} disabled={option.disabled} data-testid={option.testId}>{option.label}</TabsTrigger>)}
    </TabsList>{children}
  </Tabs>
}

export function WorkbenchChip({ selected = false, className, children, ...props }: Omit<WorkbenchButtonProps, 'variant' | 'size'> & { selected?: boolean }) {
  return <WorkbenchButton {...props} variant="secondary" size="compact" aria-pressed={selected} data-selected={selected || undefined} className={cn('wb-chip', className)}>{children}</WorkbenchButton>
}

export function WorkbenchBadge({ tone = 'neutral', media, dot = false, className, children, ...props }: React.ComponentProps<'span'> & { tone?: WorkbenchTone; media?: WorkbenchMediaKind; dot?: boolean }) {
  return <span {...props} className={cn('wb-badge', className)} data-tone={tone} data-media={media}>
    {dot && <span className="wb-status-dot" aria-hidden="true" />}{children}
  </span>
}

export function WorkbenchAlert({ tone = 'neutral', icon, actions, className, children, ...props }: React.ComponentProps<'div'> & { tone?: WorkbenchTone; icon?: React.ReactNode; actions?: React.ReactNode }) {
  return <div role={tone === 'danger' ? 'alert' : 'status'} {...props} className={cn('wb-alert', className)} data-tone={tone}>
    {icon && <span className="wb-feedback-icon" aria-hidden="true">{icon}</span>}<div className="wb-feedback-copy">{children}</div>{actions && <div className="wb-feedback-actions">{actions}</div>}
  </div>
}

export function WorkbenchEmptyState({ title, description, icon, actions, className, ...props }: Omit<React.ComponentProps<'div'>, 'title' | 'children'> & { title: React.ReactNode; description?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode }) {
  return <div {...props} className={cn('wb-empty-state', className)}>
    {icon && <span className="wb-empty-icon" aria-hidden="true">{icon}</span>}<h3>{title}</h3>{description && <p>{description}</p>}{actions && <div className="wb-empty-actions">{actions}</div>}
  </div>
}

export function WorkbenchProgress({ value, label, className }: { value: number; label: string; className?: string }) {
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  return <div className={cn('wb-progress', className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
    <span style={{ width: `${progress}%` }} />
  </div>
}

export function WorkbenchPanel({ title, icon, count, actions, footer, className, children, ...props }: Omit<React.ComponentProps<'section'>, 'title'> & { title: React.ReactNode; icon?: React.ReactNode; count?: React.ReactNode; actions?: React.ReactNode; footer?: React.ReactNode }) {
  const heading = React.useId()
  return <section aria-labelledby={heading} {...props} className={cn('wb-panel', className)}>
    <header className="wb-panel-heading">{icon && <span aria-hidden="true">{icon}</span>}<h2 id={heading}>{title}</h2>{count != null && <span className="wb-panel-count">{count}</span>}<div className="wb-panel-actions">{actions}</div></header>
    <div className="wb-panel-content">{children}</div>{footer && <footer className="wb-panel-footer">{footer}</footer>}
  </section>
}

export function WorkbenchGroup({ title, children, className, ...props }: Omit<React.ComponentProps<typeof Collapsible>, 'title'> & { title: React.ReactNode }) {
  return <Collapsible {...props} className={cn('wb-group', className)}>
    <CollapsibleTrigger className="wb-group-trigger"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" /></svg>{title}</CollapsibleTrigger>
    <CollapsibleContent keepMounted className="wb-group-content">{children}</CollapsibleContent>
  </Collapsible>
}

/** The caller retains the Dialog root and its lifetime/navigation admission. */
export function WorkbenchDialogContent({ title, description, footer, size = 'standard', className, children, ...props }: Omit<React.ComponentProps<typeof DialogContent>, 'title'> & {
  title: React.ReactNode
  description?: React.ReactNode
  footer?: React.ReactNode
  size?: 'confirm' | 'standard' | 'large'
}) {
  const descriptionId = React.useId()
  return <DialogContent aria-describedby={description ? descriptionId : undefined} {...props} className={cn('wb-dialog', className)} data-size={size}>
    <header className="wb-dialog-heading"><DialogTitle>{title}</DialogTitle>{description && <DialogDescription id={descriptionId}>{description}</DialogDescription>}</header>
    <div className="wb-dialog-content">{children}</div>{footer && <footer className="wb-dialog-footer">{footer}</footer>}
  </DialogContent>
}

export function WorkbenchToastRegion({ label, className, ...props }: React.ComponentProps<'ol'> & { label: string }) {
  return <ol aria-label={label} aria-live="polite" aria-relevant="additions text" {...props} className={cn('wb-toasts', className)} />
}

export function WorkbenchToast({ tone = 'neutral', className, children, ...props }: React.ComponentProps<'li'> & { tone?: WorkbenchTone }) {
  return <li {...props} className={cn('wb-toast', className)} data-tone={tone}>{children}</li>
}
