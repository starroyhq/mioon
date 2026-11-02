// Where a project file may be kept (task card L1, plan 8.2): network shares,
// cloud sync folders, disks without permission bits and symbolic links. Mount
// tables are parsed from sample lines, then read for real; media is read in
// every place.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  checkMediaStatus, cloudSyncProviderOf, inspectLocation, locationFactsOf, mountFor, parseLinuxMountInfo, parseMacMounts, projectFileLocationVerdict,
  referenceForFile,
} from '../packages/business/src/media-reference/index.ts';
import type {LocationFacts, MediaAccess, MountEntry} from '../packages/business/src/media-reference/index.ts';

const posix = path.posix, win32 = path.win32;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), randomBytes(8000)]);
function temporary(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-l1-location-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
const mount = (mountPoint: string, fileSystem: string, network = false, ownersIgnored = false): MountEntry => ({mountPoint, fileSystem, network, ownersIgnored});
const facts = (fields: Partial<LocationFacts>): LocationFacts => ({fileSystem: null, network: null, permissionBits: null, cloudSync: null, symbolicLink: false, ...fields});

const MAC_MOUNTS = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  '//me@nas.local/素材 on /Volumes/素材 (smbfs, nodev, nosuid, mounted by me)',
  '/dev/disk4s1 on /Volumes/USB 盘 (exfat, local, nodev, nosuid, noowners, noatime, mounted by me)',
  '//guest@nas/Back on Track on /Volumes/Back on Track (smbfs, nodev, nosuid, mounted by me)',
  'devices -- file:///Users/me/Library/Containers/com.apple.CoreDevice.CoreDeviceService/Data/ on /Users/me/Library/Developer/CoreDevice/DeviceFS ' +
    '(devicefs, local, nodev, nosuid, noowners, noatime, quarantine, nobrowse, fskit, mounted by me)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '/dev/disk5s1 on /Volumes/Untitled (1) (msdos, local, nodev, nosuid, noowners)',
  'not a mount line',
  '',
].join('\n');
const LINUX_MOUNTINFO = [
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro',
  '30 22 0:26 / /mnt/nas rw,relatime shared:12 - nfs4 nas:/export rw,vers=4.2',
  '31 22 0:27 / /mnt/share rw,relatime - cifs //nas/share rw,vers=3.1.1',
  '32 22 8:17 / /media/me/USB rw,nosuid,nodev,relatime shared:13 - vfat /dev/sdb1 rw,fmask=0022',
  '33 22 8:33 / /media/me/My\\040Disk rw,nosuid,nodev,relatime shared:14 - exfat /dev/sdc1 rw',
  '34 22 0:28 / /tmp rw,nosuid,nodev shared:15 - tmpfs tmpfs rw',
  '35 22 0:29 / /home/me/remote rw,nosuid,nodev,relatime shared:16 - fuse.sshfs me@host:/srv rw,user_id=1000',
  '',
].join('\n');

test('parseMacMounts: local volumes, network shares, noowners and FAT disks, and names holding " on " or parentheses', () => {
  const entries = parseMacMounts(MAC_MOUNTS);
  assert.deepEqual(entries, [
    mount('/', 'apfs'),
    mount('/System/Volumes/Data', 'apfs'),
    mount('/Volumes/素材', 'smbfs', true),
    mount('/Volumes/USB 盘', 'exfat', false, true),
    mount('/Volumes/Back on Track', 'smbfs', true),
    mount('/Users/me/Library/Developer/CoreDevice/DeviceFS', 'devicefs', false, true),
    mount('/System/Volumes/Data/home', 'autofs', true),
    mount('/Volumes/Untitled (1)', 'msdos', false, true),
  ]);
  assert.equal(mountFor(entries, '/Volumes/USB 盘/Film/Film.mioon')?.fileSystem, 'exfat');
  assert.equal(mountFor(entries, '/Volumes/Back on Track/Film.mioon')?.network, true);
  assert.equal(mountFor(entries, '/Users/me/Movies/Mioon/Film/Film.mioon')?.mountPoint, '/');
  assert.equal(mountFor(entries, '/Volumes/素材盘/a.mp4')?.mountPoint, '/');
});

test('parseLinuxMountInfo: the escaped mount point and the type after the separator', () => {
  const entries = parseLinuxMountInfo(LINUX_MOUNTINFO);
  assert.deepEqual(entries, [
    mount('/', 'ext4'),
    mount('/mnt/nas', 'nfs4', true),
    mount('/mnt/share', 'cifs', true),
    mount('/media/me/USB', 'vfat', false, true),
    mount('/media/me/My Disk', 'exfat', false, true),
    mount('/tmp', 'tmpfs'),
    mount('/home/me/remote', 'fuse.sshfs', true),
  ]);
  assert.equal(mountFor(entries, '/media/me/My Disk/Film/Film.mioon')?.fileSystem, 'exfat');
  assert.equal(mountFor(entries, '/mnt/nas2/Film.mioon')?.mountPoint, '/');
  assert.equal(mountFor(entries, '/tmp')?.mountPoint, '/tmp');
  // A later mount on the same point covers the earlier one.
  assert.equal(mountFor([...entries, mount('/tmp', 'ext4')], '/tmp/a')?.fileSystem, 'ext4');
  assert.equal(mountFor([], '/tmp/a'), null);
});

test('cloudSyncProviderOf tells sync folders below the home folder, on macOS and Windows', () => {
  const home = '/Users/me';
  for (const [file, provider] of [
    ['Library/Mobile Documents/com~apple~CloudDocs/Film/Film.mioon', 'icloud'],
    ['Library/CloudStorage/Dropbox/Film/Film.mioon', 'dropbox'],
    ['Library/CloudStorage/OneDrive-Personal/Film.mioon', 'onedrive'],
    ['Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Film.mioon', 'google-drive'],
    ['Library/CloudStorage/Box-Box/Film.mioon', 'box'],
    ['Library/CloudStorage/pCloud/Film.mioon', 'cloud-storage'],
    ['Dropbox/Film/Film.mioon', 'dropbox'],
    ['Dropbox (Personal)/Film.mioon', 'dropbox'],
    ['Google Drive/Film.mioon', 'google-drive'],
    ['OneDrive/Film.mioon', 'onedrive'],
    ['OneDrive - Contoso/Film.mioon', 'onedrive'],
    ['Box/Film.mioon', 'box'],
    ['Movies/Mioon/Film/Film.mioon', null],
    ['Library/CloudStorage', null],
    ['DropboxFiles/Film.mioon', null],
    ['iCloudDrive/Film.mioon', null],
  ] as const) {
    assert.equal(cloudSyncProviderOf(`${home}/${file}`, home, posix), provider, file);
  }
  assert.equal(cloudSyncProviderOf('/Users/other/Dropbox/Film.mioon', home, posix), null);
  assert.equal(cloudSyncProviderOf('/Volumes/素材/Dropbox/Film.mioon', home, posix), null);
  const windowsHome = 'C:\\Users\\me';
  assert.equal(cloudSyncProviderOf('C:\\Users\\me\\OneDrive - Contoso\\Film\\Film.mioon', windowsHome, win32), 'onedrive');
  assert.equal(cloudSyncProviderOf('C:\\Users\\me\\iCloudDrive\\Film\\Film.mioon', windowsHome, win32), 'icloud');
  assert.equal(cloudSyncProviderOf('c:\\users\\ME\\dropbox\\Film.mioon', windowsHome, win32), 'dropbox');
  assert.equal(cloudSyncProviderOf('D:\\Dropbox\\Film.mioon', windowsHome, win32), null);
  assert.equal(cloudSyncProviderOf('C:\\Users\\me\\Library\\Mobile Documents\\Film.mioon', windowsHome, win32), null);
});

test('locationFactsOf: the mount of a POSIX path; on Windows a share is on the network and a drive letter unknown', () => {
  const mac = parseMacMounts(MAC_MOUNTS);
  assert.deepEqual(locationFactsOf({realPath: '/Volumes/USB 盘/Film/Film.mioon', symbolicLink: false, mounts: mac, homeDir: '/Users/me', pathApi: posix}),
    facts({fileSystem: 'exfat', network: false, permissionBits: false}));
  assert.deepEqual(locationFactsOf({realPath: '/Users/me/Dropbox/Film/Film.mioon', symbolicLink: true, mounts: mac, homeDir: '/Users/me', pathApi: posix}),
    facts({fileSystem: 'apfs', network: false, permissionBits: true, cloudSync: 'dropbox', symbolicLink: true}));
  assert.deepEqual(locationFactsOf({realPath: '/Volumes/素材/Film.mioon', symbolicLink: false, mounts: null, homeDir: '/Users/me', pathApi: posix}), facts({}));
  assert.deepEqual(locationFactsOf({realPath: '\\\\nas\\share\\Film\\Film.mioon', symbolicLink: false, mounts: [], homeDir: 'C:\\Users\\me', pathApi: win32}),
    facts({network: true}));
  assert.deepEqual(locationFactsOf({realPath: 'D:\\Film\\Film.mioon', symbolicLink: false, mounts: [], homeDir: 'C:\\Users\\me', pathApi: win32}), facts({}));
  assert.deepEqual(locationFactsOf({realPath: 'C:\\Users\\me\\OneDrive\\Film.mioon', symbolicLink: false, mounts: [], homeDir: 'C:\\Users\\me', pathApi: win32}),
    facts({cloudSync: 'onedrive'}));
});

test('projectFileLocationVerdict: a link or a network share is refused, a sync folder or a disk without permission bits warns', () => {
  assert.deepEqual(projectFileLocationVerdict(facts({symbolicLink: true, network: true})), {allowed: false, reason: 'symbolic-link'});
  assert.deepEqual(projectFileLocationVerdict(facts({network: true, cloudSync: 'dropbox'})), {allowed: false, reason: 'network'});
  assert.deepEqual(projectFileLocationVerdict(facts({cloudSync: 'icloud'})), {allowed: true, warnings: ['cloud-sync']});
  assert.deepEqual(projectFileLocationVerdict(facts({permissionBits: false})), {allowed: true, warnings: ['no-permission-bits']});
  assert.deepEqual(projectFileLocationVerdict(facts({cloudSync: 'onedrive', permissionBits: false, network: false})),
    {allowed: true, warnings: ['cloud-sync', 'no-permission-bits']});
  assert.deepEqual(projectFileLocationVerdict(facts({})), {allowed: true, warnings: []});
  assert.deepEqual(projectFileLocationVerdict(facts({fileSystem: 'apfs', network: false, permissionBits: true})), {allowed: true, warnings: []});
});

test('in temporary folders: a share refuses the project file, exFAT and a sync folder warn, a link refuses; media is read in all of them', async t => {
  const root = temporary(t);
  const nas = path.join(root, 'nas'), usb = path.join(root, 'usb'), home = path.join(root, 'home');
  const dropbox = path.join(home, 'Library', 'CloudStorage', 'Dropbox', 'Film');
  for (const folder of [nas, path.join(usb, 'Film'), dropbox]) mkdirSync(folder, {recursive: true});
  const mounts = [mount('/', 'apfs'), mount(nas, 'smbfs', true), mount(usb, 'exfat', false, true)];
  const options = {homeDir: home, readMounts: async (): Promise<readonly MountEntry[]> => mounts};
  // The project files do not exist yet, as when a project is created.
  assert.deepEqual(projectFileLocationVerdict(await inspectLocation(path.join(nas, 'Film.mioon'), options)), {allowed: false, reason: 'network'});
  const exfat = await inspectLocation(path.join(usb, 'Film', 'Film.mioon'), options);
  assert.deepEqual(exfat, facts({fileSystem: 'exfat', network: false, permissionBits: false}));
  assert.deepEqual(projectFileLocationVerdict(exfat), {allowed: true, warnings: ['no-permission-bits']});
  const synced = await inspectLocation(path.join(dropbox, 'Film.mioon'), options);
  assert.equal(synced.cloudSync, 'dropbox');
  assert.deepEqual(projectFileLocationVerdict(synced), {allowed: true, warnings: ['cloud-sync']});
  const real = path.join(root, 'Real.mioon'), link = path.join(root, 'Link.mioon');
  writeFileSync(real, '');
  symlinkSync(real, link);
  assert.deepEqual(projectFileLocationVerdict(await inspectLocation(link, options)), {allowed: false, reason: 'symbolic-link'});
  assert.deepEqual(projectFileLocationVerdict(await inspectLocation(real, options)), {allowed: true, warnings: []});
  await assert.rejects(inspectLocation('Film.mioon', options), TypeError);
  // Media on the share and in the sync folder is online all the same; a file
  // the sync folder has not downloaded is missing.
  const project = path.join(root, 'project');
  mkdirSync(project);
  writeFileSync(path.join(project, 'Film.mioon'), '');
  const access: MediaAccess = {projectDir: project, projectFile: path.join(project, 'Film.mioon'), mayReadOutside: () => true};
  for (const file of [path.join(nas, 'a.mp4'), path.join(usb, 'Film', 'b.mp4'), path.join(dropbox, 'c.mp4')]) {
    writeFileSync(file, MP4);
    const status = await checkMediaStatus(access, (await referenceForFile(access, file)).reference);
    assert.deepEqual([status.status, status.reason], ['online', 'same-stats'], file);
  }
  const placeholder = path.join(dropbox, 'd.mp4');
  writeFileSync(placeholder, MP4);
  const {reference} = await referenceForFile(access, placeholder);
  rmSync(placeholder);
  writeFileSync(placeholder, '');
  truncateSync(placeholder, MP4.length);
  const status = await checkMediaStatus(access, reference);
  assert.deepEqual([status.status, status.reason], ['missing', 'not-downloaded']);
});

test('the real mount table: a temporary folder is a local disk with permission bits, outside any sync folder', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const root = temporary(t);
  const found = await inspectLocation(path.join(root, 'Film.mioon'));
  assert.equal(typeof found.fileSystem, 'string');
  assert.ok((found.fileSystem ?? '').length > 0);
  assert.deepEqual({...found, fileSystem: null}, facts({network: false, permissionBits: true}));
  assert.deepEqual(projectFileLocationVerdict(found), {allowed: true, warnings: []});
});
