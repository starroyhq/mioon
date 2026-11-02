import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../packages/ui/src/styles/globals.css';
import '../../../../apps/web/src/styles.css';
import '../../../../apps/web/src/project-home.css';
import '../../../../apps/web/src/settings-center.css';
import '../../../../apps/web/src/viewport-scale.css';
import { isLocale } from '../../../../packages/i18n/src/index.ts';
import { LANGUAGE_STORAGE_KEY } from '../../../../packages/i18n/src/preference.ts';
import { I18nProvider } from '../../../../apps/web/src/i18n/I18nProvider.tsx';
import { scenes } from '../scenes.tsx';
import type { Scene } from '../scenes.tsx';

/** Screenshot gallery for the project file screens (U1). `?scene=<id>` renders
 * one scene, `?locale=` picks the language (zh-Hans by default). The scene
 * table is published on `window.__projectFileScenes` for capture.py. */
declare global {
  interface Window { __projectFileScenes?: readonly Omit<Scene, 'render'>[] }
}
window.__projectFileScenes = scenes.map(({ id, group, design, state, capture, frameWidth }) => ({ id, group, design, state, capture, frameWidth }));
const query = new URLSearchParams(location.search);
const locale = query.get('locale') ?? 'zh-Hans';
localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ version: 1, preference: isLocale(locale) ? locale : 'zh-Hans' }));
const requested = query.get('scene');
const scene = requested === null ? null : scenes.find(item => item.id === requested) ?? null;
if (requested !== null && scene === null) document.body.dataset.fixtureError = 'unknown-scene';

function Ready({ children }: { readonly children: React.ReactNode }) {
  useEffect(() => { document.body.dataset.fixtureReady = 'true'; }, []);
  return <>{children}</>;
}
const root = document.getElementById('root');
if (scene && root) createRoot(root).render(<I18nProvider><Ready>
  <div data-scene-frame data-capture={scene.capture} style={scene.frameWidth ? { width: scene.frameWidth + 32 } : undefined}>{scene.render()}</div>
</Ready></I18nProvider>);
else if (requested === null) document.body.dataset.fixtureIndex = 'true';
