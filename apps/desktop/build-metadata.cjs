const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const exactVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function isManifest(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactVersion(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !exactVersion.test(value)) {
    throw new Error(`${label} must be an exact semantic version (for example, 1.2.3); ranges and tags are not supported`);
  }
  return value;
}

// The root application version is authoritative. Validate, never repair manifests.
function validateBuildMetadata(rootPackage, desktopPackage) {
  if (!isManifest(rootPackage)) throw new Error('Root package.json must contain a JSON object');
  if (!isManifest(desktopPackage)) throw new Error('Desktop package.json must contain a JSON object');
  const appVersion = requireExactVersion(rootPackage.version, 'Root package.json version');
  const desktopVersion = requireExactVersion(desktopPackage.version, 'Desktop package.json version');
  if (desktopVersion !== appVersion) {
    throw new Error(`Desktop package.json version ${desktopVersion} does not match root package.json version ${appVersion}; update the desktop manifest before building`);
  }
  const electronVersion = requireExactVersion(rootPackage.devDependencies?.electron, 'Root package.json devDependencies.electron');
  return Object.freeze({ appVersion, electronVersion, desktopPackage });
}

function readManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw new Error(`Cannot read desktop build metadata from ${file}`, { cause }); }
}

// Synchronous so the same validation can be used by electron-builder's CJS config
// and other local tooling, without importing or running the staging build.
function readBuildMetadata(rootDir = repositoryRoot) {
  return validateBuildMetadata(readManifest(path.join(rootDir, 'package.json')),
    readManifest(path.join(rootDir, 'apps/desktop/package.json')));
}

function validateStagedMetadata(stagedPackage, { appVersion, identity }) {
  if (!isManifest(stagedPackage) || !['channel', 'appId', 'productName', 'executableName']
    .every(key => stagedPackage.mioonDesktop?.[key] === identity[key])) {
    throw new Error(`Desktop staging identity mismatch; rebuild with --channel=${identity.channel}`);
  }
  if (stagedPackage.version !== appVersion) {
    throw new Error(`Desktop staging version mismatch; rebuild version ${appVersion} with --channel=${identity.channel}`);
  }
  if (stagedPackage.name !== 'mioon-desktop' || stagedPackage.main !== 'main.cjs' || stagedPackage.private !== true ||
    stagedPackage.desktopName !== `${identity.appId}.desktop` || !isManifest(stagedPackage.dependencies) ||
    Object.keys(stagedPackage.dependencies).length !== 0) {
    throw new Error(`Desktop staging package metadata mismatch; rebuild with --channel=${identity.channel}`);
  }
}

module.exports = { readBuildMetadata, validateBuildMetadata, validateStagedMetadata, requireExactVersion };
