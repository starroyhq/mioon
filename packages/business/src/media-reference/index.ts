/** Media references (task card L1): an asset points at the user's file where
 * it is kept. This layer stores its path, fingerprints and checks it, relinks
 * missing files and lists the project directory for Mio. It never opens the
 * project file, its journal or a super-journal: closing any descriptor of
 * them in this process would drop SQLite's locks. Wiring it into the services
 * belongs to S1, S2 and S6. */
export {mediaReferenceError} from './errors.ts';
export type {MediaReferenceErrorCode} from './errors.ts';
export {
  formatAbsolutePath, insideAnyDirectory, isInsideDirectory, outsideDirectoryGroups, parseAbsolutePath, referencePathFor, relinkBases,
  relinkTarget, resolveReferencePath, volumeNameOf,
} from './paths.ts';
export type {AbsolutePathParts, PathApi, ReferencePath, RelinkBases} from './paths.ts';
export {detectMediaType, isProtectedName, MEDIA_HEADER_BYTES, MEDIA_KINDS, mediaTypeOfName} from './media-type.ts';
export type {MediaKind, MediaType} from './media-type.ts';
export {NODE_MEDIA_FILE_SYSTEM} from './file-system.ts';
export type {MediaDirectoryEntry, MediaFileHandle, MediaFileSystem} from './file-system.ts';
export {
  isNotDownloaded, mediaMtimeMs, NOT_DOWNLOADED_MIN_BYTES, SAMPLE_RANGE_BYTES, SAMPLE_RANGE_COUNT, SAMPLE_WHOLE_FILE_BYTES, sampleRanges,
} from './fingerprint.ts';
export {admitMedia, checkMediaStatus, computeFullSha256, referenceForFile} from './access.ts';
export type {MediaAccess, MediaFile, MediaStatusReason, MediaStatusResult} from './access.ts';
export {MAX_RELINK_ASSETS, outsideProjectLocations, relinkMedia} from './relink.ts';
export type {MediaAsset, RelinkedMedia, RelinkResult} from './relink.ts';
export {
  CLOUD_SYNC_PROVIDERS, cloudSyncProviderOf, inspectLocation, locationFactsOf, mountFor, parseLinuxMountInfo, parseMacMounts, projectFileLocationVerdict,
} from './location.ts';
export type {CloudSyncProvider, LocationFacts, MountEntry, ProjectFileLocationVerdict} from './location.ts';
export {DEFAULT_LIST_LIMIT, listProjectMedia, MAX_LIST_SCAN, probeMediaDuration} from './listing.ts';
export type {ProbeDuration, ProjectMediaEntry, ProjectMediaListing} from './listing.ts';
