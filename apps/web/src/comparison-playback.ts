export interface ComparisonPlayer {
  readonly isConnected: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly duration: number;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}
export interface ComparisonPlaybackPair {
  readonly key: string;
  readonly players: readonly [ComparisonPlayer, ComparisonPlayer];
}
interface Options {
  isCurrent(pair: ComparisonPlaybackPair): boolean;
  beforePlay(): void;
  onChange(state: { pending: boolean; playing: boolean }): void;
  onError(pair: ComparisonPlaybackPair): void;
}
/** Shared playback is explicitly started by its own controls. A paused/cancelled
 * pair remains pending until both play promises settle, so a late promise cannot
 * stop a newer session on the same decoder. No alternate source is admitted. */
export function createComparisonPlayback(options: Options) {
  let active: ComparisonPlaybackPair | null = null;
  let pending: ComparisonPlaybackPair | null = null;
  const pausePair = (pair: ComparisonPlaybackPair) => pair.players.forEach(player => player.pause());
  const publish = () => options.onChange({ pending: pending !== null, playing: active !== null });
  function stop() {
    const pair = active;
    active = null;
    if (pair) pausePair(pair);
    publish();
  }
  function admitted(pair: ComparisonPlaybackPair) {
    return active === pair && options.isCurrent(pair) && pair.players.every(player => player.isConnected);
  }
  function guard(player: ComparisonPlayer) {
    if (active && !admitted(active)) stop();
    if (!active || !active.players.includes(player)) {
      player.pause();
      return false;
    }
    return true;
  }
  async function play(pair: ComparisonPlaybackPair) {
    if (pending || active || !options.isCurrent(pair) || pair.players.some(player => !player.isConnected)) return;
    options.beforePlay();
    if (!options.isCurrent(pair)) { pausePair(pair); return; }
    active = pair; pending = pair; publish();
    // Promise.resolve().then also captures synchronous browser play failures.
    const outcomes = await Promise.allSettled(pair.players.map(player => Promise.resolve().then(() => {
      if (!admitted(pair)) return;
      return player.play();
    }).catch(error => {
      // Stop the peer immediately; waiting for the other promise may otherwise
      // leave one decoder playing after the first has already failed.
      if (active === pair) {
        active = null; pausePair(pair);
        if (options.isCurrent(pair)) options.onError(pair);
        publish();
      }
      throw error;
    })));
    if (pending === pair) pending = null;
    const failed = outcomes.some(outcome => outcome.status === 'rejected');
    const owned = active === pair;
    if (!admitted(pair) || failed) {
      if (active === pair) active = null;
      pausePair(pair);
      if (failed && owned && options.isCurrent(pair)) options.onError(pair);
    }
    publish();
  }
  function seek(pair: ComparisonPlaybackPair, seconds: number) {
    if (pending || !options.isCurrent(pair) || !Number.isFinite(seconds)) return false;
    const duration = Math.min(...pair.players.map(player => player.duration));
    if (!Number.isFinite(duration) || duration <= 0) return false;
    try { pair.players.forEach(player => { player.currentTime = Math.max(0, Math.min(duration, seconds)); }); return true; }
    catch { stop(); if (options.isCurrent(pair)) options.onError(pair); return false; }
  }
  return { play, stop, guard, seek, isPending: () => pending !== null };
}
