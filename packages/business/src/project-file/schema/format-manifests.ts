import {FORMAT3_RELEASE_MANIFEST} from './format3-manifest.ts';
import {FORMAT4_INITIAL_HISTORY_MANIFEST} from './history-v11-manifest.ts';
import {FORMAT4_MANIFEST_CHANGES} from './manifest.ts';
import type {SchemaManifest} from './manifest-check.ts';

function format4Manifest(kind: 'project' | 'history'): SchemaManifest {
  const patch = FORMAT4_MANIFEST_CHANGES[kind];
  const entries = new Map(FORMAT3_RELEASE_MANIFEST[kind].entries.map(entry => [entry.name, entry]));
  for (const entry of patch.entries) entries.set(entry.name, entry);
  return Object.freeze({version: patch.version, entries: Object.freeze([...entries.values()])});
}

const project4 = format4Manifest('project');
const history4 = format4Manifest('history');

export function projectManifestForVersion(version: number): SchemaManifest | undefined {
  if (version === FORMAT3_RELEASE_MANIFEST.project.version) return FORMAT3_RELEASE_MANIFEST.project;
  if (version === project4.version) return project4;
  return undefined;
}

export function historyManifestForVersion(version: number): SchemaManifest | undefined {
  if (version === FORMAT3_RELEASE_MANIFEST.history.version) return FORMAT3_RELEASE_MANIFEST.history;
  if (version === FORMAT4_INITIAL_HISTORY_MANIFEST.version) return FORMAT4_INITIAL_HISTORY_MANIFEST;
  if (version === history4.version) return history4;
  return undefined;
}
