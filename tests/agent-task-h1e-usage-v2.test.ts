import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskUsageCollector,taskModelUsage} from '../packages/business/src/agent/task-usage-v2.ts';

test('private usage keeps only reported nonnegative safe integer counters, including explicit zero',()=>{
  assert.deepEqual(taskModelUsage({inputTokens:20,outputTokens:0,cacheReadTokens:7,cacheWriteTokens:0,providerSecret:'discard'}),{inputTokens:20,outputTokens:0,cacheReadTokens:7,cacheWriteTokens:0});
  for(const value of [undefined,null,[],false,'12',{}, {inputTokens:-1,outputTokens:Infinity,cacheReadTokens:0.5,cacheWriteTokens:Number.MAX_SAFE_INTEGER+1}])assert.equal(taskModelUsage(value),undefined);
  assert.deepEqual(taskModelUsage({inputTokens:NaN,outputTokens:3,cacheReadTokens:'9',cacheWriteTokens:null}),{outputTokens:3});
});

test('Chat Completions input already includes cache reads and cumulative usage is never added twice',()=>{
  const collector=createTaskUsageCollector('chat_completions');
  collector.observe({prompt_tokens:100,completion_tokens:2,prompt_tokens_details:{cached_tokens:80}});
  collector.observe({prompt_tokens:100,completion_tokens:5,prompt_tokens_details:{cached_tokens:80}});
  collector.observe({completion_tokens:5});
  assert.deepEqual(collector.usage(),{inputTokens:100,outputTokens:5,cacheReadTokens:80});
  collector.observe({prompt_tokens:99,completion_tokens:-1,prompt_tokens_details:{cached_tokens:79}});
  assert.deepEqual(collector.usage(),{inputTokens:100,outputTokens:5,cacheReadTokens:80});
});

test('Chat Completions accepts DeepSeek reported hits without calling cache misses writes',()=>{
  const collector=createTaskUsageCollector('chat_completions');
  collector.observe({prompt_tokens:100,completion_tokens:8,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40});
  assert.deepEqual(collector.usage(),{inputTokens:100,outputTokens:8,cacheReadTokens:60});
  const preferred=createTaskUsageCollector('chat_completions');preferred.observe({prompt_tokens_details:{cached_tokens:0},prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40});
  assert.deepEqual(preferred.usage(),{cacheReadTokens:0});
});

test('Responses retains independently reported cache writes and reads as input breakdowns',()=>{
  const collector=createTaskUsageCollector('responses');
  collector.observe({input_tokens:150,output_tokens:10,input_tokens_details:{cached_tokens:80,cache_write_tokens:40},total_tokens:160});
  assert.deepEqual(collector.usage(),{inputTokens:150,outputTokens:10,cacheReadTokens:80,cacheWriteTokens:40});
  collector.observe({input_tokens:150,output_tokens:12,input_tokens_details:{cached_tokens:80,cache_write_tokens:40}});
  assert.deepEqual(collector.usage(),{inputTokens:150,outputTokens:12,cacheReadTokens:80,cacheWriteTokens:40});
});

test('Anthropic totals three separate input components across start and cumulative delta observations',()=>{
  const collector=createTaskUsageCollector('anthropic_messages');
  collector.observe({input_tokens:20,cache_creation_input_tokens:30,output_tokens:1});
  assert.deepEqual(collector.usage(),{outputTokens:1,cacheWriteTokens:30});
  collector.observe({cache_read_input_tokens:50,output_tokens:4});
  assert.deepEqual(collector.usage(),{inputTokens:100,outputTokens:4,cacheReadTokens:50,cacheWriteTokens:30});
  collector.observe({input_tokens:25,cache_creation_input_tokens:30,cache_read_input_tokens:50,output_tokens:6});
  collector.observe({output_tokens:6});
  assert.deepEqual(collector.usage(),{inputTokens:105,outputTokens:6,cacheReadTokens:50,cacheWriteTokens:30});
  collector.observe({input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0});
  assert.deepEqual(collector.usage(),{inputTokens:105,outputTokens:6,cacheReadTokens:50,cacheWriteTokens:30});
});

test('Anthropic never substitutes missing or malformed cache counters with zero',()=>{
  const collector=createTaskUsageCollector('anthropic_messages');
  collector.observe({input_tokens:25,output_tokens:3});
  assert.deepEqual(collector.usage(),{outputTokens:3});
  collector.observe({cache_creation_input_tokens:0,cache_read_input_tokens:'0'});
  assert.deepEqual(collector.usage(),{outputTokens:3,cacheWriteTokens:0});
  collector.observe({cache_read_input_tokens:0});
  assert.deepEqual(collector.usage(),{inputTokens:25,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0});
});

test('an overflowing Anthropic sum is unknown while independently valid measurements remain known',()=>{
  const collector=createTaskUsageCollector('anthropic_messages');
  collector.observe({input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:2});
  assert.equal(collector.usage()?.inputTokens,1);
  collector.observe({input_tokens:Number.MAX_SAFE_INTEGER,cache_creation_input_tokens:1});
  assert.deepEqual(collector.usage(),{outputTokens:2,cacheReadTokens:0,cacheWriteTokens:1});
});

for(const protocol of ['chat_completions','responses','anthropic_messages'] as const)test(`${protocol}: absent usage stays unknown and unrelated provider fields cannot fabricate a counter`,()=>{
  const collector=createTaskUsageCollector(protocol);
  for(const raw of [undefined,null,[],false,'usage',{}, {total_tokens:100}, {input_tokens:'10',prompt_tokens:-10,output_tokens:Infinity,completion_tokens:1.2}, {cache_read_input_tokens:-1,prompt_tokens_details:[],input_tokens_details:{cached_tokens:null}}])collector.observe(raw);
  assert.equal(collector.usage(),undefined);
});

test('collector input and returned usage are independent frozen measurements',()=>{
  const collector=createTaskUsageCollector('responses'),raw=Object.freeze({input_tokens:10,output_tokens:0,input_tokens_details:Object.freeze({cached_tokens:0,cache_write_tokens:0})});
  collector.observe(raw);const first=collector.usage();assert.ok(first);first.inputTokens=999;delete first.cacheWriteTokens;
  assert.deepEqual(collector.usage(),{inputTokens:10,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0});
  assert.deepEqual(raw,{input_tokens:10,output_tokens:0,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}});
});
