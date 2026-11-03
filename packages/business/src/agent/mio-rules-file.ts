import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  renameSync, unlinkSync, writeSync, type BigIntStats} from 'node:fs';
import path from 'node:path';
import {rulesTextProblem} from '../../../contracts/src/mio-rules.ts';

export const RULES_FILE_NAME = 'AGENTS.md' as const;
export const RULES_FILE_MAX_BYTES = 8192;

/** Decimal strings keep inode and nanosecond evidence lossless in durable JSON. */
export interface RulesFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}
export type RulesFileErrorCode = 'invalid_directory' | 'unsafe_file' | 'changed' | 'too_large'
  | 'invalid_utf8' | 'invalid_text' | 'io' | 'aborted' | 'invalid_publication' | 'artifact_exists'
  | 'before_conflict' | 'target_exists' | 'hardlink_unavailable' | 'checkpoint_failed';
export type RulesFileRead =
  | {readonly status: 'safe'; readonly text: string; readonly hash: string;
    readonly identity: RulesFileIdentity; readonly directoryIdentity: RulesFileIdentity}
  | {readonly status: 'missing'; readonly directoryIdentity: RulesFileIdentity}
  | {readonly status: 'error'; readonly code: RulesFileErrorCode};
export type RulesReadPhase = 'directory_checked' | 'file_checked' | 'file_opened' | 'file_read';
export interface RulesFileReadOptions {
  readonly signal?: AbortSignal;
  /** Synchronous fault injection only. No file contents are passed to hooks. */
  readonly onPhase?: (phase: RulesReadPhase) => void;
}

function identity(info: BigIntStats): RulesFileIdentity {
  return {dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs)};
}
function sameNode(a: RulesFileIdentity, b: RulesFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameVersion(a: RulesFileIdentity, b: RulesFileIdentity): boolean {
  return sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function stat(file: string): BigIntStats | undefined {
  return lstatSync(file, {bigint: true, throwIfNoEntry: false});
}
function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
class RulesFailure extends Error {
  readonly code: RulesFileErrorCode;
  constructor(code: RulesFileErrorCode) {super(code); this.code = code;}
}
function checkSignal(signal?: AbortSignal): void {if (signal?.aborted) throw new RulesFailure('aborted');}
function directory(projectDir: string): RulesFileIdentity {
  if (!path.isAbsolute(projectDir) || path.resolve(projectDir) !== projectDir) throw new RulesFailure('invalid_directory');
  const root = path.parse(projectDir).root;
  let cursor = root;
  for (const component of projectDir.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const part = stat(cursor);
    if (!part?.isDirectory() || part.isSymbolicLink()) throw new RulesFailure('invalid_directory');
  }
  const info = stat(projectDir);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new RulesFailure('invalid_directory');
  return identity(info);
}
function checkDirectory(projectDir: string, expected: RulesFileIdentity, exact = false): void {
  const current = directory(projectDir);
  if (!(exact ? sameVersion(current, expected) : sameNode(current, expected))) throw new RulesFailure('changed');
}
function readRegular(file: string, options: RulesFileReadOptions, validateText = true, maxBytes = RULES_FILE_MAX_BYTES): {text: string; hash: string; identity: RulesFileIdentity} | null {
  checkSignal(options.signal);
  const before = stat(file);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) throw new RulesFailure('unsafe_file');
  const expected = identity(before);
  options.onPhase?.('file_checked'); checkSignal(options.signal);
  // NONBLOCK also makes a regular-file -> FIFO race fail without hanging on open.
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, {bigint: true});
    if (!opened.isFile() || !sameVersion(expected, identity(opened))) throw new RulesFailure('changed');
    options.onPhase?.('file_opened'); checkSignal(options.signal);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      checkSignal(options.signal);
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      checkSignal(options.signal);
      if (count === 0) break;
      length += count;
    }
    options.onPhase?.('file_read'); checkSignal(options.signal);
    const after = fstatSync(fd, {bigint: true}), atPath = stat(file);
    if (!after.isFile() || !atPath?.isFile() || !sameVersion(expected, identity(after))
      || !sameVersion(expected, identity(atPath))) throw new RulesFailure('changed');
    if (length > maxBytes || after.size > BigInt(maxBytes)) throw new RulesFailure('too_large');
    if (after.size !== BigInt(length)) throw new RulesFailure('changed');
    const actual = bytes.subarray(0, length);
    // Filesystems may coalesce timestamps for a same-inode, equal-size rewrite.
    // Metadata alone cannot prove that the bytes read still belong to this view.
    const verified = Buffer.alloc(maxBytes + 1);
    let verifiedLength = 0;
    while (verifiedLength < verified.length) {
      checkSignal(options.signal);
      const count = readSync(fd, verified, verifiedLength, verified.length - verifiedLength, verifiedLength);
      checkSignal(options.signal);
      if (count === 0) break;
      verifiedLength += count;
    }
    const verifiedInfo = fstatSync(fd, {bigint: true}), verifiedPath = stat(file);
    if (!verifiedInfo.isFile() || !verifiedPath?.isFile() || !sameVersion(expected, identity(verifiedInfo))
      || !sameVersion(expected, identity(verifiedPath)) || verifiedInfo.size !== BigInt(verifiedLength)
      || length !== verifiedLength || !actual.equals(verified.subarray(0, verifiedLength))) throw new RulesFailure('changed');
    let text = '';
    if (validateText) {
      try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(actual);}
      catch {throw new RulesFailure('invalid_utf8');}
      if (rulesTextProblem(text)) throw new RulesFailure('invalid_text');
    }
    return {text, hash: createHash('sha256').update(actual).digest('hex'), identity: identity(verifiedInfo)};
  } finally {closeSync(fd);}
}

/** Reads only projectDir/AGENTS.md; neither parent discovery nor arbitrary paths exist. */
export function readRulesFile(projectDir: string, options: RulesFileReadOptions = {}): RulesFileRead {
  try {
    checkSignal(options.signal);
    const owner = directory(projectDir);
    options.onPhase?.('directory_checked'); checkSignal(options.signal);
    const file = readRegular(path.join(projectDir, RULES_FILE_NAME), options);
    checkDirectory(projectDir, owner, true);
    return file ? {status: 'safe', ...file, directoryIdentity: owner} : {status: 'missing', directoryIdentity: owner};
  } catch (error) {
    return {status: 'error', code: error instanceof RulesFailure ? error.code
      : codeOf(error) === 'ELOOP' ? 'unsafe_file' : 'io'};
  }
}

export type RulesPublicationPhase = 'before_candidate' | 'candidate_created' | 'before_capture' | 'original_captured'
  | 'before_publish' | 'published' | 'before_restore' | 'restored' | 'before_cleanup' | 'completed';
export type RulesFileEffect = 'candidate_opened' | 'candidate_synced' | 'original_renamed' | 'target_linked'
  | 'backup_restored' | 'backup_removed' | 'candidate_removed';
export interface RulesPublicationEvidence {
  readonly version: 1;
  readonly fixedRelativeName: typeof RULES_FILE_NAME;
  readonly phase: RulesPublicationPhase;
  readonly directoryIdentity: RulesFileIdentity;
  readonly candidateName: string;
  readonly backupName: string;
  readonly expectedExists: boolean;
  readonly beforeHash: string | null;
  readonly afterHash: string;
  readonly candidateIdentity: RulesFileIdentity | null;
  readonly capturedIdentity: RulesFileIdentity | null;
  readonly capturedHash: string | null;
  readonly publishedIdentity: RulesFileIdentity | null;
}
export interface RulesPublicationInput {
  readonly expectedExists: boolean;
  readonly expectedHash: string | null;
  readonly text: string;
  /** Predetermined UUID names must be stored with the intent before this call. */
  readonly candidateName: string;
  readonly backupName: string;
  readonly signal?: AbortSignal;
  /** Keep inode evidence until the upper layer has completed B1/history reconciliation. */
  readonly deferCleanup?: boolean;
  /** Must durably persist evidence and return synchronously before the next effect. */
  readonly checkpoint: (evidence: RulesPublicationEvidence) => void;
  /** Runs after the checkpoint; useful for crashes and races at each effect boundary. */
  readonly onPhase?: (phase: RulesPublicationPhase, evidence: RulesPublicationEvidence) => void;
  /** Fault hook immediately after a filesystem effect, before its completion checkpoint. */
  readonly afterEffect?: (effect: RulesFileEffect, evidence: RulesPublicationEvidence) => void;
}
export type RulesPublicationResult =
  | {readonly status: 'published'; readonly evidence: RulesPublicationEvidence}
  | {readonly status: 'conflict' | 'error' | 'unknown'; readonly code: RulesFileErrorCode;
    readonly evidence: RulesPublicationEvidence | null};

const artifactPattern = /^\.mioon-rules-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.candidate$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
function validInput(input: RulesPublicationInput): Buffer {
  const match = artifactPattern.exec(input.candidateName);
  if (!match || input.backupName !== `.mioon-rules-${match[1]}.backup`
    || (input.expectedExists ? !input.expectedHash || !hashPattern.test(input.expectedHash) : input.expectedHash !== null)
    || typeof input.text !== 'string' || input.checkpoint.constructor.name === 'AsyncFunction') throw new RulesFailure('invalid_publication');
  const bytes = Buffer.from(input.text, 'utf8');
  if (bytes.length > RULES_FILE_MAX_BYTES) throw new RulesFailure('too_large');
  // Buffer would silently replace unpaired UTF-16 surrogates. Never publish different text.
  if (new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes) !== input.text) throw new RulesFailure('invalid_text');
  if (rulesTextProblem(input.text)) throw new RulesFailure('invalid_text');
  return bytes;
}
function assertOwned(file: string, expected: RulesFileIdentity): RulesFileIdentity {
  const current = stat(file);
  if (!current?.isFile() || !sameVersion(expected, identity(current))) throw new RulesFailure('changed');
  return identity(current);
}

/**
 * D8 publication is intentionally not an external CAS. Every durable checkpoint
 * leaves enough ownership evidence for the upper layer to suspend and reconcile.
 * Failure or cancellation never guesses success from an equal content hash.
 */
export function publishRulesFile(projectDir: string, input: RulesPublicationInput): RulesPublicationResult {
  let evidence: RulesPublicationEvidence | null = null;
  let effectStarted = false;
  let publicationAttempted = false;
  let phase: RulesPublicationPhase = 'before_candidate';
  const checkpoint = (next: RulesPublicationPhase): void => {
    checkSignal(input.signal);
    phase = next;
    evidence = {...evidence!, phase};
    let result: unknown;
    try {result = input.checkpoint(evidence);}
    catch {throw new RulesFailure('checkpoint_failed');}
    if (result && typeof result === 'object' && 'then' in result) throw new RulesFailure('checkpoint_failed');
    input.onPhase?.(next, evidence);
    checkSignal(input.signal);
    checkDirectory(projectDir, evidence.directoryIdentity);
  };
  try {
    checkSignal(input.signal);
    const bytes = validInput(input), owner = directory(projectDir);
    const target = path.join(projectDir, RULES_FILE_NAME), candidate = path.join(projectDir, input.candidateName), backup = path.join(projectDir, input.backupName);
    evidence = {version: 1, fixedRelativeName: RULES_FILE_NAME, phase, directoryIdentity: owner,
      candidateName: input.candidateName, backupName: input.backupName, expectedExists: input.expectedExists,
      beforeHash: input.expectedHash, afterHash: createHash('sha256').update(bytes).digest('hex'),
      candidateIdentity: null, capturedIdentity: null, capturedHash: null, publishedIdentity: null};
    if (stat(candidate) || stat(backup)) throw new RulesFailure('artifact_exists');
    checkpoint('before_candidate');
    const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    effectStarted = true;
    try {
      input.afterEffect?.('candidate_opened', evidence); checkSignal(input.signal);
      let written = 0;
      while (written < bytes.length) {checkSignal(input.signal); written += writeSync(fd, bytes, written, bytes.length - written);}
      fsyncSync(fd);
      input.afterEffect?.('candidate_synced', evidence); checkSignal(input.signal);
      const created = fstatSync(fd, {bigint: true});
      if (!created.isFile() || created.size !== BigInt(bytes.length)) throw new RulesFailure('changed');
      evidence = {...evidence, candidateIdentity: identity(created)};
    } finally {closeSync(fd);}
    assertOwned(candidate, evidence.candidateIdentity!);
    checkpoint('candidate_created');
    if (input.expectedExists) {
      checkpoint('before_capture');
      if (stat(backup)) throw new RulesFailure('artifact_exists');
      const current = stat(target);
      if (!current) throw new RulesFailure('before_conflict');
      if (!current.isFile() || current.isSymbolicLink()) throw new RulesFailure('unsafe_file');
      renameSync(target, backup);
      input.afterEffect?.('original_renamed', evidence); checkSignal(input.signal);
      const captureStart = stat(backup);
      if (!captureStart?.isFile()) throw new RulesFailure('unsafe_file');
      let captured: {hash: string | null; identity: RulesFileIdentity} | null;
      try {captured = readRegular(backup, {signal: input.signal}, false);}
      catch (error) {
        // An external oversized replacement cannot equal an approved bounded file.
        // Restore its original bytes without reading an unbounded amount of data.
        if (!(error instanceof RulesFailure) || error.code !== 'too_large') throw error;
        assertOwned(backup, identity(captureStart));
        captured = {hash: null, identity: identity(captureStart)};
      }
      if (!captured) throw new RulesFailure('changed');
      evidence = {...evidence, capturedIdentity: captured.identity, capturedHash: captured.hash};
      checkpoint('original_captured');
      if (captured.hash !== input.expectedHash) {
        checkpoint('before_restore');
        assertOwned(backup, captured.identity);
        try {linkSync(backup, target);}
        catch (error) {
          if (codeOf(error) === 'EEXIST') return {status: 'conflict', code: 'target_exists', evidence};
          if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(codeOf(error) ?? '')) throw new RulesFailure('hardlink_unavailable');
          throw error;
        }
        input.afterEffect?.('backup_restored', evidence); checkSignal(input.signal);
        const restored = stat(target);
        if (!restored?.isFile() || !sameNode(identity(restored), captured.identity)) throw new RulesFailure('changed');
        // link changes ctime, so record the updated identity before removing our link.
        evidence = {...evidence, capturedIdentity: identity(restored)};
        checkpoint('restored');
        assertOwned(backup, identity(restored));
        unlinkSync(backup);
        input.afterEffect?.('backup_removed', evidence); checkSignal(input.signal);
        return {status: 'conflict', code: 'before_conflict', evidence};
      }
    }
    checkpoint('before_publish');
    const candidateRead = readRegular(candidate, {signal: input.signal});
    if (!candidateRead || !sameVersion(candidateRead.identity, evidence.candidateIdentity!) || candidateRead.hash !== evidence.afterHash) throw new RulesFailure('changed');
    if (evidence.capturedIdentity) assertOwned(backup, evidence.capturedIdentity);
    publicationAttempted = true;
    try {linkSync(candidate, target);}
    catch (error) {
      if (codeOf(error) === 'EEXIST') return {status: 'conflict', code: 'target_exists', evidence};
      if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(codeOf(error) ?? '')) throw new RulesFailure('hardlink_unavailable');
      throw error;
    }
    input.afterEffect?.('target_linked', evidence); checkSignal(input.signal);
    const published = readRegular(target, {signal: input.signal});
    const linkedCandidate = stat(candidate);
    if (!published || !linkedCandidate?.isFile() || !sameNode(published.identity, evidence.candidateIdentity!)
      || !sameVersion(published.identity, identity(linkedCandidate)) || published.hash !== evidence.afterHash) throw new RulesFailure('changed');
    evidence = {...evidence, candidateIdentity: identity(linkedCandidate), publishedIdentity: published.identity};
    checkpoint('published');
    if (input.deferCleanup) {
      assertOwned(target, evidence.publishedIdentity!); assertOwned(candidate, evidence.candidateIdentity!);
      return {status: 'published', evidence};
    }
    return finishRulesFileCleanup(projectDir, evidence, input);
  } catch (error) {
    const code = error instanceof RulesFailure ? error.code : 'io';
    if (['artifact_exists', 'before_conflict', 'target_exists'].includes(code)) return {status: 'conflict', code, evidence};
    return {status: effectStarted || publicationAttempted ? 'unknown' : 'error', code, evidence};
  }
}

/** Safe recovery inspection is restricted to the two predetermined artifact forms. */
export function inspectRulesArtifact(projectDir: string, name: string, options: RulesFileReadOptions & {readonly maxBytes?: number} = {}): RulesFileRead {
  if (!/^\.mioon-rules-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:candidate|backup)$/u.test(name)) {
    return {status: 'error', code: 'invalid_publication'};
  }
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > RULES_FILE_MAX_BYTES)) {
    return {status: 'error', code: 'invalid_publication'};
  }
  try {
    checkSignal(options.signal);
    const owner = directory(projectDir);
    options.onPhase?.('directory_checked'); checkSignal(options.signal);
    const file = readRegular(path.join(projectDir, name), options, true, options.maxBytes);
    checkDirectory(projectDir, owner, true);
    return file ? {status: 'safe', ...file, directoryIdentity: owner} : {status: 'missing', directoryIdentity: owner};
  } catch (error) {
    return {status: 'error', code: error instanceof RulesFailure ? error.code : codeOf(error) === 'ELOOP' ? 'unsafe_file' : 'io'};
  }
}

export type RulesCleanupOptions = Pick<RulesPublicationInput, 'signal' | 'checkpoint' | 'onPhase' | 'afterEffect'>;
/** Only call after durable B1/history completion. A failed cleanup retains uncertainty. */
export function finishRulesFileCleanup(projectDir: string, original: RulesPublicationEvidence, options: RulesCleanupOptions): RulesPublicationResult {
  let evidence = original;
  const checkpoint = (phase: RulesPublicationPhase): void => {
    checkSignal(options.signal);
    evidence = {...evidence, phase};
    let result: unknown;
    try {result = options.checkpoint(evidence);} catch {throw new RulesFailure('checkpoint_failed');}
    if (result && typeof result === 'object' && 'then' in result) throw new RulesFailure('checkpoint_failed');
    options.onPhase?.(phase, evidence); checkSignal(options.signal);
    checkDirectory(projectDir, evidence.directoryIdentity);
  };
  try {
    checkSignal(options.signal);
    // Revalidate names even when recovery evidence came from a durable JSON record.
    validInput({expectedExists: evidence.expectedExists, expectedHash: evidence.beforeHash, text: '',
      candidateName: evidence.candidateName, backupName: evidence.backupName, checkpoint: options.checkpoint});
    if (evidence.version !== 1 || evidence.fixedRelativeName !== RULES_FILE_NAME
      || !evidence.publishedIdentity || !evidence.candidateIdentity || !hashPattern.test(evidence.afterHash)) throw new RulesFailure('invalid_publication');
    checkDirectory(projectDir, evidence.directoryIdentity);
    checkpoint('before_cleanup');
    const target = path.join(projectDir, RULES_FILE_NAME), candidate = path.join(projectDir, evidence.candidateName), backup = path.join(projectDir, evidence.backupName);
    const current = readRegular(target, {signal: options.signal}), staged = readRegular(candidate, {signal: options.signal});
    if (!current || current.hash !== evidence.afterHash || !sameNode(current.identity, evidence.publishedIdentity)
      || !staged || staged.hash !== evidence.afterHash || !sameNode(staged.identity, evidence.candidateIdentity)
      || !sameNode(current.identity, staged.identity)) throw new RulesFailure('changed');
    if (evidence.capturedIdentity) {
      const saved = readRegular(backup, {signal: options.signal}, false);
      if (!saved || saved.hash !== evidence.capturedHash || !sameNode(saved.identity, evidence.capturedIdentity)) throw new RulesFailure('changed');
      assertOwned(backup, saved.identity); unlinkSync(backup);
      options.afterEffect?.('backup_removed', evidence); checkSignal(options.signal);
    }
    checkSignal(options.signal); checkDirectory(projectDir, evidence.directoryIdentity);
    assertOwned(target, current.identity); assertOwned(candidate, staged.identity);
    unlinkSync(candidate);
    options.afterEffect?.('candidate_removed', evidence); checkSignal(options.signal);
    const final = readRegular(target, {signal: options.signal});
    if (!final || !sameNode(final.identity, evidence.publishedIdentity) || final.hash !== evidence.afterHash) throw new RulesFailure('changed');
    evidence = {...evidence, publishedIdentity: final.identity};
    checkpoint('completed');
    return {status: 'published', evidence};
  } catch (error) {return {status: 'unknown', code: error instanceof RulesFailure ? error.code : 'io', evidence};}
}
