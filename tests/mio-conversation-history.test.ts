import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationDay,conversationMatches,conversationTime} from '../apps/web/src/agent-conversations.ts';
import {LOCALES} from '../packages/i18n/src/index.ts';

test('conversation groups use local calendar days across year boundaries rather than elapsed hours',()=>{
  const now=new Date(2026,0,1,0,2),today=new Date(2026,0,1,0,1),yesterday=new Date(2025,11,31,23,59),earlier=new Date(2025,11,30,23,59);
  assert.equal(conversationDay(today.toISOString(),now),'today');
  assert.equal(conversationDay(yesterday.toISOString(),now),'yesterday');
  assert.equal(conversationDay(earlier.toISOString(),now),'earlier');
  assert.equal(conversationDay('invalid',now),'earlier');
});
test('search filters only supplied titles with literal case-insensitive text in all four languages',()=>{
  for(const locale of LOCALES){
    assert.ok(conversationMatches('Mio A/B comparison · 日本語の字幕',' a/b ',locale));
    assert.ok(conversationMatches('Mio A/B comparison · 日本語の字幕','日本語',locale));
    assert.equal(conversationMatches('Another conversation','A/B',locale),false);
    assert.equal(conversationMatches('Mio literal title','.*',locale),false);
    assert.ok(conversationMatches('Any title','',locale));
  }
});
test('history times remain localized and malformed dates never render NaN or throw',()=>{
  for(const locale of LOCALES){for(const day of ['today','yesterday','earlier'] as const){
    const value=conversationTime('2026-10-22T12:34:00.000Z',locale,day);
    assert.ok(value.length>0);assert.doesNotMatch(value,/NaN|Invalid/u);
    assert.equal(conversationTime('invalid',locale,day),'');
  }}
});
