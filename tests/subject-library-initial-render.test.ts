import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
test('real React renders the first project frame with null subject state in all four languages', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import { I18nProvider, createLanguageStore } from './i18n/I18nProvider.tsx';
    import SubjectLibrary from './SubjectLibrary.tsx';
    import { useSubjects } from './use-subjects.ts';
    import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
    const observations = [];
    function FirstProjectFrame({ visible }) {
      const subjects = useSubjects({ scope: 'fresh-project:1', projectId: 'fresh-project',
        read: async () => { throw Error('Render must not read'); },
        save: async () => { throw Error('Render must not save'); } });
      observations.push(subjects.state === null);
      return <WorkspaceVisibilityProvider visible={visible}><SubjectLibrary subjects={subjects} /></WorkspaceVisibilityProvider>;
    }
    export async function renderAll() {
      const html = {};
      for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
        const store = createLanguageStore({ systemLanguages: [locale] });
        await store.setPreference(locale);
        html[locale] = [true, false].map(visible => renderToStaticMarkup(<I18nProvider store={store}><FirstProjectFrame visible={visible} /></I18nProvider>));
        store.dispose();
      }
      return { html, observations };
    }
  `;
  const script = `
    import { build } from 'esbuild';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(source)}, loader: 'tsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web/src'))} }, bundle: true, format: 'esm', platform: 'browser', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const fixture = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(await fixture.renderAll())); process.exit(0);
  `;
  const rendered: { html: Record<string, string[]>; observations: boolean[] } = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30_000 }));
  assert.equal(rendered.observations.length, 8);
  assert.ok(rendered.observations.every(Boolean));
  for (const locale of LOCALES) for (const html of rendered.html[locale]) {
    assert.match(html, /data-testid="subject-library"/);
    assert.match(html, /role="status"/);
    assert.ok(html.includes(translate(locale, 'subjects.library.loading')));
    assert.doesNotMatch(html, /<button|<input|<select/);
  }
});
