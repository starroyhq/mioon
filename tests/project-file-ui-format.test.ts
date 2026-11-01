import test from 'node:test';
import assert from 'node:assert/strict';
import { aspectLabel, byteSize, clockTime, dayBucket, displayPath, fileNameOf, folderOf, lastSeenLabel, projectFilePathPreview, projectNameProblem, revealLabelKey, sameYear, stemOf } from '../apps/web/src/project-file/format.ts';

test('file name, stem and folder for POSIX, drive and UNC paths', () => {
  const cases = [
    ['/Users/mioon/Movies/Mioon/城市夜景短片/城市夜景短片.mioon', '城市夜景短片.mioon', '城市夜景短片', '/Users/mioon/Movies/Mioon/城市夜景短片'],
    ['/project.mioon', 'project.mioon', 'project', '/'],
    ['C:\\Users\\mioon\\Videos\\Mioon\\Demo\\Demo.mioon', 'Demo.mioon', 'Demo', 'C:\\Users\\mioon\\Videos\\Mioon\\Demo'],
    ['D:\\Demo.MIOON', 'Demo.MIOON', 'Demo', 'D:\\'],
    ['\\\\nas\\media\\访谈\\访谈.mioon', '访谈.mioon', '访谈', '\\\\nas\\media\\访谈'],
    ['\\\\nas\\media\\访谈.mioon', '访谈.mioon', '访谈', '\\\\nas\\media'],
    ['/Users/mioon/notes.txt', 'notes.txt', 'notes.txt', '/Users/mioon'],
    ['/Users/mioon/.mioon', '.mioon', '.mioon', '/Users/mioon'],
  ] as const;
  for (const [path, name, stem, folder] of cases) {
    assert.equal(fileNameOf(path), name, path);
    assert.equal(stemOf(path), stem, path);
    assert.equal(folderOf(path), folder, path);
  }
});

test('home directory shows as ~ and last-seen names the volume, drive or share', () => {
  const home = '/Users/mioon';
  assert.equal(displayPath('/Users/mioon/Movies/Mioon', home), '~/Movies/Mioon');
  assert.equal(displayPath('/Users/mioon', `${home}/`), '~');
  assert.equal(displayPath('/Users/mioonx/Movies', home), '/Users/mioonx/Movies');
  assert.equal(displayPath('C:\\Users\\mioon\\Videos', 'C:\\Users\\mioon'), '~\\Videos');
  assert.equal(displayPath('/Volumes/素材盘/产品演示', null), '/Volumes/素材盘/产品演示');
  assert.equal(lastSeenLabel('/Volumes/外接硬盘/访谈剪辑样片/访谈剪辑样片.mioon', home), '/Volumes/外接硬盘');
  assert.equal(lastSeenLabel('E:\\Projects\\访谈\\访谈.mioon'), 'E:');
  assert.equal(lastSeenLabel('\\\\nas\\media\\访谈\\访谈.mioon'), '\\\\nas\\media');
  assert.equal(lastSeenLabel('/Users/mioon/Desktop/片头/片头.mioon', home), '~/Desktop/片头');
});

test('path preview and project name checks', () => {
  assert.equal(projectFilePathPreview('~/Movies/Mioon', '未命名项目', true), '~/Movies/Mioon/未命名项目/未命名项目.mioon');
  assert.equal(projectFilePathPreview('~/Movies/Mioon/', '未命名项目', false), '~/Movies/Mioon/未命名项目.mioon');
  assert.equal(projectFilePathPreview('D:\\Videos', 'Demo', true), 'D:\\Videos\\Demo\\Demo.mioon');
  assert.equal(projectNameProblem(''), 'empty');
  assert.equal(projectNameProblem('   '), 'empty');
  for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', ' 前面', '后面 ']) assert.equal(projectNameProblem(name), 'invalid', name);
  assert.equal(projectNameProblem('访谈剪辑 第 2 版'), null);
});

test('sizes use decimal units with one decimal place', () => {
  assert.deepEqual(byteSize(0), { value: 0, unit: 'b' });
  assert.deepEqual(byteSize(999), { value: 999, unit: 'b' });
  assert.deepEqual(byteSize(1000), { value: 1, unit: 'kb' });
  assert.deepEqual(byteSize(1_250_000), { value: 1.3, unit: 'mb' });
  assert.deepEqual(byteSize(999_960), { value: 1, unit: 'mb' });
  assert.deepEqual(byteSize(4_820_000_000), { value: 4.8, unit: 'gb' });
  assert.deepEqual(byteSize(3.2e15), { value: 3200, unit: 'tb' });
  assert.deepEqual(byteSize(Number.NaN), { value: 0, unit: 'b' });
});

test('days are local calendar days, across a month and a year boundary', () => {
  const now = new Date(2026, 9, 21, 14, 40);
  assert.equal(dayBucket(new Date(2026, 9, 21, 0, 0).toISOString(), now), 'today');
  assert.equal(dayBucket(new Date(2026, 9, 20, 23, 59).toISOString(), now), 'yesterday');
  assert.equal(dayBucket(new Date(2026, 9, 19, 23, 59).toISOString(), now), 'earlier');
  const firstOfMonth = new Date(2026, 10, 1, 9, 0);
  assert.equal(dayBucket(new Date(2026, 9, 31, 22, 0).toISOString(), firstOfMonth), 'yesterday');
  const newYear = new Date(2027, 0, 1, 8, 0);
  assert.equal(dayBucket(new Date(2026, 11, 31, 23, 0).toISOString(), newYear), 'yesterday');
  assert.equal(sameYear(new Date(2026, 11, 31, 23, 0).toISOString(), newYear), false);
  assert.equal(sameYear(new Date(2027, 0, 1, 0, 0).toISOString(), newYear), true);
  assert.equal(dayBucket('not a date', now), 'earlier');
});

test('clock time, aspect ratio and the reveal label', () => {
  assert.equal(clockTime(42 * 30, 30), '00:42');
  assert.equal(clockTime(196 * 30 + 29, 30), '03:16');
  assert.equal(clockTime(3725 * 30, 30), '1:02:05');
  assert.equal(clockTime(0, 30), '00:00');
  assert.equal(aspectLabel(1080, 1920), '9:16');
  assert.equal(aspectLabel(1920, 1080), '16:9');
  assert.equal(aspectLabel(1080, 1080), '1:1');
  assert.equal(aspectLabel(0, 1080), '');
  assert.equal(revealLabelKey('mac'), 'projectPackage.revealFinder');
  assert.equal(revealLabelKey('windows'), 'projectPackage.revealExplorer');
  assert.equal(revealLabelKey('linux'), 'projectPackage.revealFiles');
  assert.equal(revealLabelKey('web'), 'projectPackage.revealFiles');
});
