import React from 'react';
import Icon from './icons.tsx';
import './provider-brand-icon.css';

// Keep brand identity independent of a connection's editable display name.
const marks: Readonly<Record<string, { file: string; monochrome?: boolean }>> = {
  runway: { file: 'runway.svg', monochrome: true },
  ark: { file: 'volcengine-color.svg' },
  veo: { file: 'google-color.svg' },
  minimax: { file: 'minimax-color.svg' },
  vidu: { file: 'vidu-color.svg' },
  kling: { file: 'kling-color.svg' },
  wan: { file: 'alibabacloud-color.svg' },
};

export default function ProviderBrandIcon({ providerId, size = 20 }: { providerId?: string; size?: number }) {
  const mark = providerId && Object.hasOwn(marks, providerId) ? marks[providerId] : undefined;
  const source = mark ? `/provider-icons/${mark.file}` : undefined;
  return <span className="provider-brand-icon" data-provider-icon={mark ? providerId : 'local'} aria-hidden="true" style={{ width: size, height: size }}>
    {mark?.monochrome ? <span className="provider-brand-icon-mask" style={{ maskImage: `url("${source}")`, WebkitMaskImage: `url("${source}")` }} />
      : source ? <img src={source} alt="" draggable={false} width={size} height={size} /> : <Icon name="film" size={size} />}
  </span>;
}
