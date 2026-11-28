import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { CoEditingComparisonRow, CoEditingConflict } from './mio-co-editing.ts';
import './mio-co-editing.css';

export function MioEditingBadge({ color, testId }: { color: string; testId?: string }): React.ReactElement {
  const { t } = useI18n();
  return (
    <span
      className="mio-coedit-badge"
      data-testid={testId ?? 'mio-coedit-editing-badge'}
      style={{ '--mio-coedit-color': color } as React.CSSProperties}
    >
      <Icon name="sparkle" size={11} />
      <span>{t('agent.coEdit.mioEditing')}</span>
    </span>
  );
}

export interface MioCoEditingConflictCardProps {
  conflict: CoEditingConflict;
  groupLabel?: string;
  rows?: readonly CoEditingComparisonRow[];
  refreshing?: boolean;
  busy?: boolean;
  testId?: string;
  onAdoptMio?: () => unknown;
  onKeepMine?: () => unknown;
  onReconcile?: () => unknown;
  onCheckInMio?: () => unknown;
}

export function MioCoEditingConflictCard({
  conflict,
  groupLabel,
  rows = [],
  refreshing = false,
  busy = false,
  testId,
  onAdoptMio,
  onKeepMine,
  onReconcile,
  onCheckInMio,
}: MioCoEditingConflictCardProps): React.ReactElement {
  const { t } = useI18n();

  if (conflict.kind === 'mio_committing') {
    return (
      <div className="mio-coedit-conflict-card" role="status" data-testid={testId ?? 'coedit-conflict-card'} data-conflict-kind="mio_committing">
        <div className="mio-coedit-conflict-head">
          <Icon name="warning" size={13} />
          <strong>
            {groupLabel
              ? t('agent.coEdit.mioCommitting', { group: groupLabel })
              : t('agent.coEdit.mioCommittingGeneric')}
          </strong>
        </div>
      </div>
    );
  }

  if (conflict.kind === 'claim_unknown') {
    return (
      <div className="mio-coedit-conflict-card" role="alert" data-testid={testId ?? 'coedit-conflict-card'} data-conflict-kind="claim_unknown">
        <div className="mio-coedit-conflict-head">
          <Icon name="warning" size={13} />
          <strong>{t('agent.coEdit.claimUnknown')}</strong>
        </div>
        {onReconcile && (
          <div className="mio-coedit-conflict-actions">
            <Button variant="outline" size="sm" type="button" data-testid="coedit-reconcile" disabled={busy} onClick={() => { void onReconcile(); }}>
              {t('agent.task.confirmRead')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (conflict.kind === 'outcome_unknown') {
    return (
      <div className="mio-coedit-conflict-card" role="alert" data-testid={testId ?? 'coedit-conflict-card'} data-conflict-kind="outcome_unknown">
        <div className="mio-coedit-conflict-head">
          <Icon name="warning" size={13} />
          <strong>{t('agent.coEdit.mioOutcomeUnknown')}</strong>
        </div>
        {onCheckInMio && (
          <div className="mio-coedit-conflict-actions">
            <Button variant="outline" size="sm" type="button" data-testid="coedit-check-mio" disabled={busy} onClick={() => { void onCheckInMio(); }}>
              {t('agent.coEdit.checkInMio')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mio-coedit-conflict-card" role="alert" data-testid={testId ?? 'coedit-conflict-card'} data-conflict-kind="revision_changed">
      <div className="mio-coedit-conflict-head">
        <Icon name="warning" size={13} />
        <strong>
          {groupLabel
            ? t('agent.coEdit.conflictHeading', { group: groupLabel })
            : t('agent.coEdit.conflictHeadingGeneric')}
        </strong>
      </div>
      {refreshing && !rows.length && (
        <p className="mio-coedit-diff-loading" role="status">{t('agent.coEdit.conflictRefreshing')}</p>
      )}
      {rows.length > 0 && (
        <dl className="mio-coedit-diff" data-testid="coedit-conflict-diff">
          {rows.map(row => (
            <div key={row.field} className="mio-coedit-diff-row" data-testid={`coedit-diff-${row.field}`}>
              <dt>{row.label}</dt>
              <dd className="mio-coedit-diff-values">
                <span className="mio-coedit-val-mine">{t('agent.coEdit.mineValue', { value: row.mine })}</span>
                <span className="mio-coedit-val-mio">{t('agent.coEdit.mioValue', { value: row.mio })}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mio-coedit-conflict-actions">
        {onAdoptMio && (
          <Button variant="outline" size="sm" type="button" data-testid="coedit-adopt-mio" disabled={busy} onClick={() => { void onAdoptMio(); }}>
            {t('agent.coEdit.adoptMio')}
          </Button>
        )}
        {onKeepMine && (
          <Button size="sm" type="button" className="button primary" data-testid="coedit-keep-mine" disabled={busy} onClick={() => { void onKeepMine(); }}>
            {t('agent.coEdit.keepMine')}
          </Button>
        )}
      </div>
    </div>
  );
}
