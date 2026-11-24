import React from 'react';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {generationServiceChoices} from '../generation-service-choices.ts';
import type {GenerationServiceChoice} from '../generation-service-choices.ts';
import type {GenerationProvider} from '../generation-settings.ts';


export interface GenerationServiceMenuProps {
  readonly providers: readonly GenerationProvider[];
  readonly disabled?: boolean;
  readonly menuClassName: string;
  readonly menuTestId: string;
  readonly itemTestIdPrefix: string;
  readonly onChoose: (choice: GenerationServiceChoice) => void;
  readonly onOpenSettings?: (() => void) | undefined;
}

export default function GenerationServiceMenu({providers, disabled, menuClassName, menuTestId,
  itemTestIdPrefix, onChoose, onOpenSettings}: GenerationServiceMenuProps): React.ReactElement {
  const {t} = useI18n();
  const choices = generationServiceChoices(providers, t as never);
  return <div className={menuClassName} role="menu" data-testid={menuTestId}>
    {choices.map(choice => <button type="button" role="menuitem" key={choice.key}
      data-testid={`${itemTestIdPrefix}-${choice.testId}`} disabled={disabled}
      onClick={() => onChoose(choice)}>
      <span>{choice.label}</span>
      {choice.detail && <small>{choice.detail}</small>}
    </button>)}
    {!choices.length && <button type="button" role="menuitem" data-testid={`${itemTestIdPrefix}-open-settings`}
      disabled={disabled || !onOpenSettings} onClick={() => onOpenSettings?.()}>
      <span>{t('boardUi.servicePicker.openSettings')}</span>
    </button>}
  </div>;
}

export {generationServiceChoices} from '../generation-service-choices.ts';
export type {GenerationServiceChoice} from '../generation-service-choices.ts';
