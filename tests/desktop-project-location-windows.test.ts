import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWindowsProjectPath,windowsExtendedPath,windowsOrdinaryPath,windowsProjectPathIdentity} from '../apps/desktop/src/project-location-windows.ts';

const rejected = (value: unknown, reason: string): boolean => {
  try {normalizeWindowsProjectPath(value);return false;}
  catch (error) {return (error as {code?: unknown;reason?: unknown}).code === 'PROJECT_LOCATION_INVALID' && (error as {reason?: unknown}).reason === reason;}
};
test('ordinary drive paths keep their spelling, normalize the drive letter and separators', () => {
  assert.deepEqual(normalizeWindowsProjectPath(String.raw`c:\Users\Film Maker\Movie.mioon`), {path: String.raw`C:\Users\Film Maker\Movie.mioon`, unc: false, longPath: false});
  assert.deepEqual(normalizeWindowsProjectPath(String.raw`D:/Projects//Film/`), {path: String.raw`D:\Projects\Film`, unc: false, longPath: false});
  assert.deepEqual(normalizeWindowsProjectPath('C:\\'), {path: 'C:\\', unc: false, longPath: false});
});
test('extended-length and UNC prefixes are accepted in ordinary display form', () => {
  assert.deepEqual(normalizeWindowsProjectPath(String.raw`\\?\C:\Long\Film.mioon`), {path: String.raw`C:\Long\Film.mioon`, unc: false, longPath: false});
  assert.deepEqual(normalizeWindowsProjectPath(String.raw`\\?\UNC\server\share\Film.mioon`), {path: String.raw`\\server\share\Film.mioon`, unc: true, longPath: false});
  assert.deepEqual(normalizeWindowsProjectPath(String.raw`\\server\share\Folder\Film.mioon`), {path: String.raw`\\server\share\Folder\Film.mioon`, unc: true, longPath: false});
  const longPath = 'C:\\' + Array.from({length: 3}, () => 'd'.repeat(90)).join('\\');
  assert.equal(normalizeWindowsProjectPath(longPath).longPath, true);
  assert.equal(windowsExtendedPath(longPath).startsWith('\\\\?\\C:\\'), true);
  assert.equal(windowsOrdinaryPath(String.raw`\\?\UNC\server\share\Film.mioon`), String.raw`\\server\share\Film.mioon`);
  assert.equal(windowsOrdinaryPath(String.raw`\\?\C:\Film.mioon`), String.raw`C:\Film.mioon`);
});
test('device, relative and malformed UNC paths are refused with a stable reason', () => {
  for (const [value, reason] of [
    [String.raw`\\.\C:\Film.mioon`, 'device-path'],
    [String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1`, 'device-path'],
    ['Film.mioon', 'relative'], ['C:', 'not-normalized'], ['C:Film.mioon', 'relative'],
    ['\\\\server', 'unc-invalid'], ['\\\\\\share\\film', 'unc-invalid'],
    [42, 'not-string'], ['', 'too-long'], ['C:\\' + 'x'.repeat(4100), 'too-long'],
    ['C:\\Film\u0000.mioon', 'control-character'], ['C:\\a\\.\\b', 'not-normalized'], ['C:\\a\\..\\b', 'not-normalized'],
  ] as const) assert.ok(rejected(value, reason), `${String(value)} must be rejected as ${reason}`);
});
test('Windows reserved names, forbidden characters and trailing dots/spaces are refused per component', () => {
  for (const value of ['C:\\CON', 'C:\\con.txt', 'C:\\NUL.mioon', 'C:\\folder\\PRN ', 'C:\\COM1', 'C:\\lpt9.log', 'C:\\COM¹', 'C:\\aux\\file', 'C:\\CLOCK$']) {
    if (value.endsWith(' ')) assert.ok(rejected(value, 'trailing-dot-or-space'), value);
    else assert.ok(rejected(value, 'reserved-name'), value);
  }
  for (const value of ['C:\\a<b', 'C:\\a>b', 'C:\\a:b', 'C:\\a"b', 'C:\\a|b', 'C:\\a?b', 'C:\\a*b']) assert.ok(rejected(value, 'invalid-character'), value);
  for (const [value, reason] of [['C:\\Film ', 'trailing-dot-or-space'], ['C:\\Film.', 'trailing-dot-or-space'], ['C:\\a.\\b', 'trailing-dot-or-space'], ['C:\\ff', null]] as const) {
    assert.equal(rejected(value, reason ?? ''), reason !== null, value);
  }
  assert.equal(normalizeWindowsProjectPath(String.raw`C:\console\auxiliary\film.mioon`).path, String.raw`C:\console\auxiliary\film.mioon`);
});
test('comparison identity ignores case and separators but display spelling is preserved', () => {
  assert.equal(windowsProjectPathIdentity(String.raw`c:\Users\Film\Movie.mioon`), windowsProjectPathIdentity(String.raw`C:/Users/Film/Movie.mioon`));
  assert.notEqual(windowsProjectPathIdentity(String.raw`C:\Users\Film`), windowsProjectPathIdentity(String.raw`C:\Users\Other`));
  assert.equal(normalizeWindowsProjectPath(String.raw`c:\Users\Film\Movie.mioon`).path, String.raw`C:\Users\Film\Movie.mioon`);
});
