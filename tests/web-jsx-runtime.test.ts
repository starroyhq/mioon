import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Vite takes JSX settings from the nearest tsconfig.json and ignores
// jsconfig.json. Without apps/web/tsconfig.json the renderer shipped
// React.createElement calls, so a component that forgot `import React` passed
// the type checker and the esbuild test bundles (both use the automatic
// runtime) and only failed in the running app.
const root = fileURLToPath(new URL('..', import.meta.url));
const viteEntry = createRequire(path.join(root, 'apps/web/package.json')).resolve('vite');

test('the renderer build compiles TSX with React’s automatic JSX runtime, like the type checker and test bundles', async () => {
  const {transformWithEsbuild} = await import(pathToFileURL(viteEntry).href) as {transformWithEsbuild(code: string, filename: string): Promise<{code: string}>};
  for (const file of ['apps/web/src/TimelineAudioPreview.tsx', 'packages/ui/src/components/button.tsx']) {
    const filename = path.join(root, file);
    const {code} = await transformWithEsbuild(readFileSync(filename, 'utf8'), filename);
    assert.match(code, /from "react\/jsx-runtime"/, file);
    assert.doesNotMatch(code, /React\.createElement\(/, file);
  }
});
