import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAgentTaskContextReport, summarizeReportUsage} from './helpers/agent-task-context-report.ts';
import {reportAnthropicPrefixes} from './helpers/agent-task-prefix-report.ts';

const marker = {type: 'ephemeral'};
const text = (value: string, marked = false) => ({type: 'text', text: value, ...(marked ? {cache_control: marker} : {})});
function body(messages: unknown[], tools: unknown[] = [{name: 'core', input_schema: {}, cache_control: marker}]) {
  return JSON.stringify({model: 'offline-fixture', messages, system: [text('stable system', true)], tools});
}
const message = (value: string, marked = false) => ({role: 'user', content: [text(value, marked)]});

test('usage measurement preserves missing counters, reported zero and per-field coverage', () => {
  const absent = summarizeReportUsage([null, null]);
  assert.equal(absent.knownTotals, null); assert.equal(absent.cacheReadRate, null);
  assert.equal(absent.coverage.fields.inputTokens.reportedSteps, 0);
  const partial = summarizeReportUsage([{inputTokens: 0, outputTokens: 3}, {cacheReadTokens: 2}]);
  assert.deepEqual(partial.knownTotals, {inputTokens: 0, outputTokens: 3, cacheReadTokens: 2});
  assert.equal(Object.hasOwn(partial.knownTotals!, 'cacheWriteTokens'), false);
  assert.deepEqual(partial.coverage.fields.outputTokens, {reportedSteps: 1, missingSteps: 1});
  assert.equal(partial.cacheReadRate, null, 'Unpaired partial totals must not create a hit rate');
});

test('usage aggregates completed steps once and rejects inexact counters instead of inventing totals', () => {
  const result = summarizeReportUsage([{inputTokens: 100, outputTokens: 10, cacheReadTokens: 50}, {inputTokens: 200, outputTokens: 20, cacheReadTokens: 100}]);
  assert.deepEqual(result.knownTotals, {inputTokens: 300, outputTokens: 30, cacheReadTokens: 150});
  assert.equal(result.cacheReadRate, .5);
  for (const value of [-1, .5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => summarizeReportUsage([{inputTokens: value}]));
  assert.throws(() => summarizeReportUsage([{inputTokens: Number.MAX_SAFE_INTEGER}, {inputTokens: 1}]));
  assert.equal(summarizeReportUsage([{inputTokens: 0, cacheReadTokens: 0}]).cacheReadRate, null);
});

test('prefixes follow tools then system then messages and retain nested cache_control data', () => {
  const first = body([message('first', true)], [{name: 'core', input_schema: {properties: {cache_control: {const: 'application data'}}}, cache_control: marker}]);
  const report = reportAnthropicPrefixes(first);
  assert.deepEqual(report, reportAnthropicPrefixes(first), 'Identical frozen bytes produce identical prefix evidence');
  assert.deepEqual(report.breakpoints.map(point => point.section), ['tools', 'system', 'messages']);
  assert.ok(report.breakpoints[0]!.content.bytes < report.breakpoints[1]!.content.bytes);
  assert.ok(report.breakpoints[1]!.content.bytes < report.breakpoints[2]!.content.bytes);
  const changed = first.replace('application data', 'application datum');
  assert.equal(reportAnthropicPrefixes(changed, first).breakpoints[0]!.content.previous!.equal, false);
  assert.equal(report.breakpoints[0]!.content.previous, null);
});

test('moving the final directive preserves exact old content at its current corresponding boundary', () => {
  const previous = body([message('原话🙂', true)]), current = body([message('原话🙂'), message('next', true)]);
  const point = reportAnthropicPrefixes(current, previous).breakpoints.find(value => value.section === 'messages')!;
  assert.equal(point.rawWire.currentAtPreviousBoundary!.equalToPrevious, false);
  assert.equal(point.content.currentAtPreviousBoundary!.equalToPrevious, true);
  assert.equal(point.content.previousAtCurrentBoundary, null);
  assert.equal(point.lookbackEstimate.apiEligibilityKnown, false);
  const changed = reportAnthropicPrefixes(current.replace('原话🙂', '原话🙃'), previous).breakpoints.find(value => value.section === 'messages')!;
  assert.equal(changed.content.currentAtPreviousBoundary!.equalToPrevious, false);
  assert.ok(changed.content.previous!.commonPrefixBytes > Buffer.byteLength('原话'));
});

test('added tools conservatively invalidate the tool layer while retaining only a candidate core prefix', () => {
  const previous = body([message('first', true)]);
  const current = body([message('first'), message('second', true)], [{name: 'core', input_schema: {}, cache_control: marker}, {name: 'loaded', input_schema: {}, cache_control: marker}]);
  const loaded = reportAnthropicPrefixes(current, previous);
  assert.equal(loaded.toolLayerChanged, true);
  assert.equal(loaded.breakpoints[0]!.content.currentAtPreviousBoundary!.equalToPrevious, true);
  assert.equal(loaded.breakpoints[1]!.content.previous, null);
  assert.equal(reportAnthropicPrefixes(current, current).toolLayerChanged, false);
  assert.equal(reportAnthropicPrefixes(current, current).breakpoints[1]!.content.previous!.equal, true);
});

test('twenty-block lookback is explicitly an offline estimate and overview after history preserves the earlier boundary', () => {
  const previous = body([message('immutable history', true), message('old overview')]);
  const current = body([message('immutable history', true), message('changed overview')]);
  assert.equal(reportAnthropicPrefixes(current, previous).breakpoints.find(point => point.section === 'messages')!.content.previous!.equal, true);
  const old = body([message('start', true)]), many = body([message('start'), ...Array.from({length: 21}, (_, index) => message(String(index), index === 20))]);
  const point = reportAnthropicPrefixes(many, old).breakpoints.find(value => value.section === 'messages')!;
  assert.equal(point.lookbackEstimate.messageBlocksSincePreviousBoundary, 21);
  assert.equal(point.lookbackEstimate.withinTwentyMessageBlocks, false);
  assert.equal(point.lookbackEstimate.apiEligibilityKnown, false);
});

test('unmarked controls expose explicitly virtual boundaries without claiming producer directives', () => {
  const unmarked = JSON.stringify({tools: [{name: 'core', input_schema: {}}], system: 'stable instruction', messages: [message('offline')]});
  assert.equal(reportAnthropicPrefixes(unmarked).breakpointCount, 0);
  const report = reportAnthropicPrefixes(unmarked, undefined, {virtualBreakpoints: true});
  assert.equal(report.declaredBreakpointCount, 0);
  assert.deepEqual(report.breakpoints.map(point => point.section), ['tools', 'system', 'messages']);
  assert.ok(report.breakpoints.every(point => point.origin === 'virtual'));
});

test('real string shorthand remains the same content through marking and a subsequent unmarked historical message', () => {
  const unmarked = JSON.stringify({tools: [], system: 'instruction', messages: [{role: 'user', content: '用户原话🙂'}]});
  const marked = JSON.stringify({tools: [], system: [text('instruction', true)], messages: [message('用户原话🙂', true)]});
  const later = JSON.stringify({tools: [], system: [text('instruction', true)], messages: [{role: 'user', content: '用户原话🙂'}, {role: 'assistant', content: 'reply'}, message('next', true)]});
  const control = reportAnthropicPrefixes(unmarked, undefined, {virtualBreakpoints: true});
  assert.equal(control.breakpoints.find(point => point.section === 'messages')!.origin, 'virtual');
  assert.equal(control.breakpoints.find(point => point.section === 'messages')!.path, '/messages/0/content');
  const marking = reportAnthropicPrefixes(marked, unmarked, {virtualBreakpoints: true});
  assert.equal(marking.system.previous!.equal, true);
  assert.equal(marking.breakpoints.find(point => point.section === 'messages')!.content.currentAtPreviousBoundary!.equalToPrevious, true);
  assert.equal(marking.breakpoints.find(point => point.section === 'messages')!.rawWire.currentAtPreviousBoundary!.equalToPrevious, false);
  const appended = reportAnthropicPrefixes(later, marked);
  assert.equal(appended.breakpoints.find(point => point.section === 'messages')!.content.currentAtPreviousBoundary!.equalToPrevious, true);
  assert.equal(appended.breakpoints.find(point => point.section === 'messages')!.rawWire.currentAtPreviousBoundary!.equalToPrevious, false);
});

test('inclusive twenty-position estimate admits distance nineteen and excludes distance twenty', () => {
  const previous = JSON.stringify({messages: [{role: 'user', content: 'first'}]});
  for (const distance of [19, 20]) {
    const current = body([{role: 'user', content: 'first'}, ...Array.from({length: distance}, (_, index) => message(String(index), index === distance - 1))], []);
    const point = reportAnthropicPrefixes(current, previous, {virtualBreakpoints: true}).breakpoints.find(value => value.section === 'messages')!;
    assert.equal(point.lookbackEstimate.messageBlocksSincePreviousBoundary, distance);
    assert.equal(point.lookbackEstimate.withinTwentyMessageBlocks, distance === 19);
    assert.equal(point.lookbackEstimate.apiEligibilityKnown, false);
  }
});

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) test(`${protocol}: report reads each private saved usage once and leaves absent fields unknown`, async () => {
  const measured = (await collectAgentTaskContextReport({protocols: [protocol], toolRounds: 1, replyBytes: 16, deltaBytes: 8, syntheticUsage: [{inputTokens: 10, outputTokens: 2, cacheReadTokens: 4}, {outputTokens: 3}]})).protocols[0]!;
  assert.deepEqual(measured.modelSteps.map(step => step.usage), [{inputTokens: 10, outputTokens: 2, cacheReadTokens: 4}, {outputTokens: 3}]);
  assert.deepEqual(measured.tokenUsage, {inputTokens: 10, outputTokens: 5, cacheReadTokens: 4});
  assert.equal(measured.usageCoverage.fields.inputTokens.missingSteps, 1);
  assert.equal(measured.cacheReadRate, null);
});

test('official offline group loading changes one tool layer then the next request retains its marked prefixes', async () => {
  const measured = (await collectAgentTaskContextReport({protocols: ['anthropic_messages'], officialPresets: true, cachePrefixReport: true, loadToolGroups: ['canvas'], toolRounds: 2, replyBytes: 16, deltaBytes: 8, deltaIntervalMs: 0})).protocols[0]!;
  assert.equal(measured.run.status, 'completed'); assert.equal(measured.run.stepsUsed, 5);
  assert.equal(measured.requests.length, 3); assert.equal(measured.tokenUsage, null);
  assert.equal(measured.requests[1]!.cachePrefix!.toolLayerChanged, true);
  assert.equal(measured.requests[2]!.cachePrefix!.toolLayerChanged, false);
  assert.equal(measured.requests[1]!.cachePrefix!.breakpoints[0]!.content.currentAtPreviousBoundary!.equalToPrevious, true);
  assert.equal(measured.requests[2]!.cachePrefix!.breakpoints[0]!.content.previous!.equal, true);
});

test('official stress measurement reports repeated compaction and deterministic metadata without fabricated usage', {timeout: 120_000}, async () => {
  const options = {protocols: ['anthropic_messages'] as const, officialPresets: true, cachePrefixReport: true, stress30Steps: true, deltaIntervalMs: 0};
  const first = (await collectAgentTaskContextReport(options)).protocols[0]!, second = (await collectAgentTaskContextReport(options)).protocols[0]!;
  assert.equal(first.run.status, 'completed'); assert.equal(first.run.stepsUsed, 30);
  assert.equal(first.toolSteps!.length, 15); assert.equal(first.tokenUsage, null);
  // Real project.inspect results contain each fresh workspace's own project
  // identity. Do not scrub those bytes or claim distinct inputs have one hash.
  assert.deepEqual(first.requests.map(({index, bytes, toolCount}) => ({index, bytes, toolCount})), second.requests.map(({index, bytes, toolCount}) => ({index, bytes, toolCount})));
  assert.ok(first.requests.slice(1).every(request => request.cachePrefix!.breakpoints[0]!.content.previous!.equal));
  assert.equal(first.usageCoverage.reportedSteps, 0);
  assert.ok(first.modelSteps.filter((step, index) => index > 0 && step.historyBytes < first.modelSteps[index - 1]!.historyBytes).length >= 2);
  assert.ok(first.requests.every(request => request.cachePrefix!.breakpointCount > 0 && request.cachePrefix!.breakpointCount <= 4));
});
