import { translate, message, renderMessage } from '../../packages/i18n/src/index.ts';
import type { Locale } from '../../packages/i18n/src/index.ts';
const locale: Locale = 'zh-Hant';
translate(locale, 'common.cancel');
translate(locale, 'native.chooseExecutable', { name: 'ffmpeg' });
renderMessage(locale, message('native.chooseExecutable', { name: 'ffprobe' }));
// @ts-expect-error Region-specific resource IDs are not application locales.
translate('zh-TW', 'common.cancel');
// @ts-expect-error Missing interpolation arguments must fail type checking.
translate(locale, 'native.chooseExecutable');
// @ts-expect-error Wrong placeholder names must fail type checking.
message('native.chooseExecutable', { executable: 'ffmpeg' });
// @ts-expect-error No unrelated interpolation values accepted.
translate(locale, 'common.cancel', { projectId: 'not a display parameter' });
// @ts-expect-error Unknown semantic key must fail type checking.
message('common.undefinedKey');

import { nativeText } from '../../apps/desktop/src/app-language-text.ts';
nativeText('native.chooseExecutable', { name: 'FFmpeg' });
// @ts-expect-error Native templates also require their exact placeholders.
nativeText('native.chooseExecutable');
// @ts-expect-error Native template placeholder names cannot drift.
nativeText('native.chooseExecutable', { executable: 'FFmpeg' });
