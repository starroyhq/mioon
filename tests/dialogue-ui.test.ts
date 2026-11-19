import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
interface PanelInputs {shot?: {id: string; dialogue?: readonly {id: string; text: string; speakerSubjectId?: string}[]}; cueCount?: number}
interface Scenes {panel(locale: Locale, inputs?: PanelInputs): string}
let scenes: Promise<Scenes> | undefined;
function fixture(): Promise<Scenes> {
  return scenes ??= (async () => {
    const entry = `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {I18nProvider,createLanguageStore} from './src/i18n/I18nProvider.tsx';
      import ShotDialogue from './src/ShotDialogue.tsx';
      const shot={id:'80000000-0000-4000-8000-000000000001',dialogue:[
        {id:'80000000-0000-4000-8000-000000000002',text:'我们回不去了。',speakerSubjectId:'80000000-0000-4000-8000-000000000101'},
        {id:'80000000-0000-4000-8000-000000000003',text:'走吧。'}]};
      const names={'80000000-0000-4000-8000-000000000101':'阿璃'};
      const language=(locale,children)=><I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>{children}</I18nProvider>;
      export function panel(locale,inputs={}){
        const rpc=async()=>({ok:true});
        return renderToStaticMarkup(language(locale,<ShotDialogue
          shot={inputs.shot === undefined ? shot : inputs.shot}
          subjectNames={names} projectId={'80000000-0000-4000-8000-000000000009'}
          cueCount={inputs.cueCount === undefined ? 2 : inputs.cueCount} rpc={rpc} onApplied={()=>{}}/>));
      }`;
    const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')}, bundle: true,
      platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: {'.css': 'empty'},
      define: {'process.env.NODE_ENV': '"production"'}});
    const loaded = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
    return loaded.exports as Scenes;
  })();
}

test('the shot dialogue panel renders the lines, speaker names and linked cue status in every locale', async () => {
  const {panel} = await fixture();
  const zh = panel('zh-Hans', {});
  assert.match(zh, /data-testid="shot-dialogue"/u);
  assert.match(zh, /台词/u, 'the section is titled dialogue');
  assert.match(zh, /阿璃：我们回不去了。\n走吧。/u, 'a stored speaker becomes the editable name prefix');
  assert.match(zh, /字幕 · 2 条，在剪辑 T 轨/u, 'the linked-cue count is shown as data');
  assert.doesNotMatch(zh, /shot-dialogue-save/u, 'an unchanged panel has no save action');
  for (const locale of LOCALES) {
    const html = panel(locale, {});
    assert.match(html, new RegExp(translate(locale, 'dialogue.ui.title')), `${locale} title`);
    assert.match(html, new RegExp(translate(locale, 'dialogue.ui.cues', {count: 2})), `${locale} cue status`);
  }
  const en = panel('en', {});
  assert.match(en, /Dialogue/u);
  assert.match(en, /Subtitles · 2 cues on the editing T track/u);
});

test('the panel renders an empty shot without inventing lines or a subtitle status', async () => {
  const {panel} = await fixture();
  const empty = panel('zh-Hans', {shot: {id: '80000000-0000-4000-8000-000000000001'}, cueCount: 0});
  assert.match(empty, /data-testid="shot-dialogue"/u);
  assert.doesNotMatch(empty, /shot-dialogue-cues/u);
  assert.doesNotMatch(empty, /shot-dialogue-save/u);
  // No textarea value: an undefined dialogue never produces a placeholder line.
  assert.match(empty, /<textarea[^>]*data-testid="shot-dialogue-text"[^>]*><\/textarea>/u);
});

test('the production shell mounts the dialogue panel and subtitle dialogue marks for format 5 only', () => {
  const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
  const app = read('apps/web/src/App.tsx');
  assert.match(app, /import ShotDialogue from '\.\/ShotDialogue\.tsx';/u);
  assert.match(app, /const shotDialogueSection = format5 && chosenShot \? <ShotDialogue/u);
  assert.match(app, /shotDialogue=\{shotDialogueSection\}/u);
  assert.match(app, /dialogueCues=\{format5 \? format5DialogueCues\.marks : null\}/u);
  assert.match(read('apps/web/src/Inspector.tsx'), /\{shotDialogue\}/u);
  assert.match(read('apps/web/src/Timeline.tsx'), /dialogueCues=\{dialogueCues\}/u);
  const lane = read('apps/web/src/SubtitleLane.tsx');
  assert.match(lane, /subtitle-dialogue-mark/u);
  assert.match(lane, /dialogueCues\?\.get\(cue\.id\)/u);
});
