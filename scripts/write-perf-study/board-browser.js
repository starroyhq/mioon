async function measureBoardPan(page, {runs, trace, scenarios, modes}) {
  const css = `
[data-study-pan="pause-edge-motion"] :is(.board-sequence-dot,.board-reference-line),
[data-study-pan="small-scale-edge-detail"] :is(.board-sequence-dot,.board-reference-line) { animation-play-state: paused !important; }
[data-study-pan="small-scale-edge-detail"] :is(.board-sequence-dot,.board-reference-label-box) { visibility: hidden !important; }
[data-study-overview] :is(.board-sequence-dot,.board-reference-line) { animation: none !important; }
[data-study-overview="overview-composited"] .react-flow__viewport { will-change: transform; }
[data-study-overview="overview-composited"] .board-ui-live-toolbar { backdrop-filter: none; }
`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.name));
  const numbers = values => {
    if (!values.length) throw new Error('No samples were taken');
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = q => sorted[Math.ceil(sorted.length * q) - 1];
    const round = value => Math.round(value * 1000) / 1000;
    return {n: sorted.length, p50: round(percentile(0.5)), p95: round(percentile(0.95)),
      max: round(sorted.at(-1)), over20: sorted.filter(value => value > 20).length};
  };
  const viewport = () => page.evaluate(() => {
    const board = document.querySelector('.react-flow__viewport');
    const transform = new DOMMatrix(getComputedStyle(board).transform);
    return {x: transform.e, y: transform.f, zoom: transform.a};
  });
  const snapshot = () => page.evaluate(() => {
    const state = window.__boardWireState;
    return {
      shots: state.shots.length,
      sequenceEdges: state.data.edges.filter(edge => edge.kind === 'sequence').length,
      referenceEdges: state.data.edges.filter(edge => edge.kind === 'reference').length,
      displayedCards: document.querySelectorAll('.board-ui-card').length,
      displayedSequenceEdges: document.querySelectorAll('[data-board-edge-kind="sequence"]').length,
      displayedReferenceEdges: document.querySelectorAll('[data-board-edge-kind="reference"]').length,
      history: state.history?.position,
      timelineRevision: state.timelineRevision,
      syncRevision: state.syncRevision,
    };
  });
  const rpcCount = () => page.evaluate(async () => (await (await fetch('/study/rpc-count')).json()).rpcCount);
  let pane;
  async function load(scenario) {
    await page.goto(scenario.url);
    await page.waitForFunction(() => window.__boardWireState?.ready === true &&
      document.querySelectorAll('.board-ui-card').length >= 500, undefined, {timeout: 120_000});
    await page.waitForFunction(() => document.querySelectorAll('[data-board-edge-kind]').length > 600);
    await page.waitForTimeout(300);
    await page.addStyleTag({content: css});
    await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid=board-ui-canvas]');
      canvas.addEventListener('pointerdown', event => {
        if (event.button === 1 && !event.target.closest('.react-flow__handle,.board-film-strip') &&
            ['pause-edge-motion', 'small-scale-edge-detail'].includes(window.studyPanMode)) {
          canvas.dataset.studyPan = window.studyPanMode;
        }
      }, true);
      const restore = () => { delete canvas.dataset.studyPan; };
      window.addEventListener('pointerup', restore, true);
      window.addEventListener('pointercancel', restore, true);
      window.addEventListener('blur', restore);
    });
    pane = await page.getByTestId('board-ui-canvas').boundingBox();
    if (!pane) throw new Error('Expected fixture canvas');
    const observed = await snapshot();
    for (const name of ['shots', 'sequenceEdges', 'referenceEdges']) {
      if (observed[name] !== scenario[name]) throw new Error(`Wrong fixture ${name}`);
    }
    if (observed.displayedSequenceEdges !== observed.sequenceEdges || observed.displayedReferenceEdges !== observed.referenceEdges) {
      throw new Error('Expected every edge to be visible in the initial overview');
    }
    return observed;
  }
  async function gesture(dx, dy, steps, cadence) {
    const x = pane.x + pane.width * 0.45;
    const y = pane.y + pane.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down({button: 'middle'});
    try {
      for (let step = 1; step <= steps; step++) {
        await page.mouse.move(x + dx * step / steps, y + dy * step / steps);
        await page.waitForTimeout(cadence);
      }
    } finally {
      await page.mouse.up({button: 'middle'});
    }
  }

  async function sample(mode, traced = false) {
    await page.evaluate(value => {
      window.studyPanMode = value;
      const board = document.querySelector('.board-ui-live');
      if (value.startsWith('overview-')) board.dataset.studyOverview = value;
      else delete board.dataset.studyOverview;
    }, mode);
    if (modes.some(name => name.startsWith('overview-'))) await page.waitForTimeout(120);
    const original = await viewport();
    if ((mode === 'small-scale-edge-detail' || mode.startsWith('overview-')) && original.zoom > 0.25) {
      throw new Error('Detail trial requires overview zoom ≤ 25%');
    }
    const before = await rpcCount();
    const measurementStart = await page.evaluate(() => {
      const samples = [];
      const canvas = document.querySelector('[data-testid=board-ui-canvas]');
      let previous;
      let active = true;
      const tick = now => {
        if (!active) return;
        if (previous !== undefined) samples.push({now, interval: now - previous, gestureStyle: canvas.dataset.studyPan !== undefined});
        previous = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.boardStudyStop = () => {active = false; return samples;};
      performance.mark('board-study-start');
      return performance.now();
    });
    await gesture(-180, -90, 30, 16);
    const measurementEnd = await page.evaluate(() => {
      performance.mark('board-study-end');
      return performance.now();
    });
    await page.waitForTimeout(traced ? 20 : 300);
    const samples = await page.evaluate(() => window.boardStudyStop());
    const after = await viewport();
    if (Math.abs(after.x - original.x + 180) > 2 || Math.abs(after.y - original.y + 90) > 2 ||
        Math.abs(after.zoom - original.zoom) > 0.001) {
      throw new Error(`Gesture did not pan as scripted (${JSON.stringify({original, after})})`);
    }
    if (await rpcCount() !== before) throw new Error('Viewport pan issued an RPC');
    const restoredCss = await page.evaluate(() => document.querySelector('[data-testid=board-ui-canvas]').dataset.studyPan === undefined);
    if (!restoredCss) throw new Error('Gesture prototype failed to restore edge presentation');
    await gesture(180, 90, 8, 16);
    const reset = await viewport();
    if (Math.abs(reset.x - original.x) > 2 || Math.abs(reset.y - original.y) > 2) throw new Error('Unmatched viewport reset');
    await page.waitForTimeout(120);
    const active = samples.filter(entry => entry.now > measurementStart && entry.now <= measurementEnd);
    return {zoom: original.zoom, active: active.map(entry => entry.interval),
      gestureStyleFrames: active.filter(entry => entry.gestureStyle).length,
      withLegacyIdle: samples.map(entry => entry.interval)};
  }

  function totalUnion(events, names, begin, end) {
    const spans = events.filter(event => names.includes(event.name) && event.ph === 'X' && event.dur > 0)
      .map(event => [Math.max(begin, event.ts), Math.min(end, event.ts + event.dur)]).filter(([from, to]) => from < to)
      .sort((left, right) => left[0] - right[0]);
    let covered = 0, last = begin;
    for (const [from, to] of spans) {
      if (to <= last) continue;
      covered += to - Math.max(from, last);
      last = to;
    }
    return {events: spans.length, totalMs: Math.round(covered / 100) / 10};
  }
  async function profile(cdp, mode) {
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.start', {categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,cc,v8', transferMode: 'ReturnAsStream'});
    await sample(mode, true);
    await cdp.send('Tracing.end');
    const {stream} = await complete;
    let raw = '';
    while (true) {
      const part = await cdp.send('IO.read', {handle: stream});
      raw += part.base64Encoded ? await page.evaluate(({data, eof}) => {
        window.boardStudyTraceDecoder ??= new TextDecoder();
        return window.boardStudyTraceDecoder.decode(Uint8Array.from(atob(data), value => value.charCodeAt(0)), {stream: !eof});
      }, part) : part.data;
      if (part.eof) break;
    }
    await cdp.send('IO.close', {handle: stream});
    const {traceEvents} = JSON.parse(raw);
    const start = traceEvents.find(event => event.name === 'board-study-start' && event.cat.includes('user_timing'));
    const end = traceEvents.find(event => event.name === 'board-study-end' && event.cat.includes('user_timing'));
    if (!start || !end || start.tid !== end.tid || start.pid !== end.pid) throw new Error('Could not align trace markers');
    const main = traceEvents.filter(event => event.pid === start.pid && event.tid === start.tid);
    const group = (...names) => totalUnion(main, names, start.ts, end.ts);
    const between = main.filter(event => event.ts >= start.ts && event.ts <= end.ts &&
      event.ph === 'X' && event.dur >= 500 && event.name !== 'RunTask');
    return {
      windowMs: (end.ts - start.ts) / 1000,
      tasks: group('RunTask'), inputDispatch: group('EventDispatch'), scriptCallbacks: group('FunctionCall', 'FireAnimationFrame'),
      styleAndLayout: group('UpdateLayoutTree', 'Layout'), prePaintAndPaint: group('PrePaint', 'Paint'),
      layerizeAndCommit: group('Layerize', 'Commit'), hitTest: group('HitTest'),
      garbageCollection: group('MinorGC', 'MajorGC'),
      mainThreadEventsOverHalfMs: Object.entries(between.reduce((counts, event) => {
        counts[event.name] = (counts[event.name] ?? 0) + 1;
        return counts;
      }, {})).sort((left, right) => right[1] - left[1]).slice(0, 15),
    };
  }

  const cdp = await page.context().newCDPSession(page);
  const {product} = await cdp.send('Browser.getVersion');
  const result = {browser: product, environment: await page.evaluate(() => ({
    dpr: devicePixelRatio, viewport: [innerWidth, innerHeight], reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  })), results: {}};
  for (const [name, scenario] of Object.entries(scenarios)) {
    const observed = await load(scenario);
    const cold = await sample('baseline');
    for (let index = 0; index < 2; index++) {
      await gesture(-112, -40, 8, 16);
      await gesture(112, 40, 8, 16);
    }
    const warm = Object.fromEntries(modes.map(mode => [mode, []]));
    for (let run = 0; run < runs; run++) {
      for (const index of modes.map((_, position) => (position + run) % modes.length)) {
        const mode = modes[index];
        warm[mode].push(await sample(mode));
      }
    }
    const end = await snapshot();
    for (const field of ['shots', 'sequenceEdges', 'referenceEdges', 'history', 'timelineRevision', 'syncRevision']) {
      if (end[field] !== observed[field]) throw new Error(`Pan changed ${field}`);
    }
    result.results[name] = {
      fixture: observed, zoom: cold.zoom,
      cold: {active: numbers(cold.active), withLegacyIdle: numbers(cold.withLegacyIdle)},
      warm: Object.fromEntries(Object.entries(warm).map(([mode, samples]) => [mode, {
        rounds: samples.map(sample => ({...numbers(sample.active), gestureStyleFrames: sample.gestureStyleFrames})),
        pooled: numbers(samples.flatMap(sample => sample.active)),
        withLegacyIdle: numbers(samples.flatMap(sample => sample.withLegacyIdle)),
      }])),
      profile: trace && name === 'requested' ? {} : undefined,
    };
    if (result.results[name].profile) {
      for (const mode of modes) result.results[name].profile[mode] = await profile(cdp, mode);
    }
  }
  await cdp.detach();
  if (errors.length) throw new Error(`Browser page errors: ${errors.join(', ')}`);
  return `BOARD_STUDY_JSON:${JSON.stringify(result)}`;
}
