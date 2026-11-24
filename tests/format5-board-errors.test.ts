import test from 'node:test';
import assert from 'node:assert/strict';
import {format5BoardFailureMessageKey} from '../apps/web/src/edit-ui/session.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';

const referenceReasons = [
  'PREVIS_OUTPUT_REQUIRED', 'ASSET_NOT_READY', 'ASSET_UNVERIFIED', 'PREVIS_OUTPUT_UNVERIFIED',
  'ASSET_TYPE_MISMATCH', 'ROLE_NOT_ALLOWED', 'NODE_MISSING', 'SHOT_MISSING', 'EDGE_MISSING',
  'TIMELINE_ROOT_MISSING', 'NODE_ARCHIVED', 'SHOT_ARCHIVED', 'EDGE_ARCHIVED', 'NODE_INVALID',
  'SHOT_INVALID', 'EDGE_INVALID', 'PREVIS_INVALID', 'REFERENCE_INVALID', 'EDGE_ID_CONFLICT',
  'EDGE_ALLOCATION_REQUIRED', 'EDGE_TARGET_MISMATCH', 'SOURCE_TYPE_INVALID', 'SUBJECT_BINDING_REQUIRED',
  'LAST_FRAME_REQUIRES_FIRST', 'FIRST_FRAME_BLOCKED_BY_LAST', 'LAST_FRAME_DETACH_FIRST',
  'ORDER_SET_MISMATCH', 'SUBJECT_MISSING', 'SUBJECT_VERSION_MISSING',
];
const chainCodes = ['NODE_ALREADY_LINKED', 'MULTIPLE_PREDECESSORS', 'MULTIPLE_SUCCESSORS', 'FILM_MUST_START',
  'INVALID_SEQUENCE_TYPES', 'TEXT_IS_ANNOTATION', 'CYCLE', 'MISSING_NODE', 'DUPLICATE_EDGE', 'FORMAT5_CAPACITY'];

test('every known reference reason and sequence connection code has localized user-facing copy', () => {
  for (const reason of referenceReasons) {
    const key = format5BoardFailureMessageKey('SEQUENCE_EDIT_REFERENCE_INVALID', reason);
    assert.notEqual(key, 'editUi.error.GENERIC', reason);
    for (const locale of LOCALES) assert.ok(translate(locale, key as never).length > 0, `${reason}:${locale}`);
  }
  for (const code of chainCodes) {
    const key = format5BoardFailureMessageKey(code);
    assert.notEqual(key, 'editUi.error.GENERIC', code);
    for (const locale of LOCALES) assert.ok(translate(locale, key as never).length > 0, `${code}:${locale}`);
  }
  assert.equal(format5BoardFailureMessageKey('SEQUENCE_EDIT_REFERENCE_INVALID'),
    'boardUi.error.referenceFailed');
  assert.equal(format5BoardFailureMessageKey('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'),
    'boardUi.error.subjectBindingFailed');
});
