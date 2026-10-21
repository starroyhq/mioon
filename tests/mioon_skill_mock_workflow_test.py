"""Offline regression coverage for the skill's executable Python sample."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid


SCRIPT = Path(__file__).resolve().parents[1] / 'skills/mioon/scripts/mock_workflow.py'
RECOVERABLE_EDITS = ('shot.create', 'node.create', 'version.select')
OPERATIONS = [
    'capabilities', 'project.create', 'asset.import', 'shot.create', 'node.create',
    'generation.submit', 'job.watch', 'project.get', 'version.select',
    'timeline.get', 'timeline.seed', 'timeline.get', 'timeline.render',
    'export.watch', 'export.download',
]
IDS = {name: str(uuid.UUID(int=index)) for index, name in enumerate(
    ('project', 'asset', 'shot', 'node', 'job', 'version', 'export'), start=1)}


class WorkflowFixture:
    def __init__(self, root, lost_operation=None):
        root = root.resolve()
        self.repo = root / 'repo'
        self.cli = self.repo / 'apps/cli/src/index.ts'
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text('// Fixture sentinel: never executed.\n')
        self.work = root / 'work'
        self.state = self.work / 'requests.json'
        self.lost_operation = lost_operation
        self.calls = []

    def dispatch(self, command, **options):
        # Intercept every subprocess: no actual CLI, service, provider or FFmpeg.
        assert command[:2] == ['node', str(self.cli)]
        assert options['cwd'] == self.repo
        split = command.index('--input')
        operation = '.'.join(command[2:split])
        data = json.loads(command[split + 1])
        pending = json.loads(self.state.read_text())[-1]
        assert pending == {'operation': operation, 'input': data, 'outcome': 'pending'}
        self.calls.append({'operation': operation, 'input': data, 'pending': pending})
        responses = {
            'capabilities': [{'id': 'mock', 'enabled': True, 'models': ['mock-fixture']}],
            'project.create': {'id': IDS['project']},
            'asset.import': {'id': IDS['asset']},
            'shot.create': {'id': IDS['shot'], 'revision': 1},
            'node.create': {'id': IDS['node'], 'revision': 1},
            'generation.submit': {'id': IDS['job']},
            'job.watch': {'id': IDS['job'], 'versionId': IDS['version']},
            'project.get': {'shots': [{'id': IDS['shot'], 'revision': 7}]},
            'version.select': {'id': IDS['shot'], 'revision': 8},
            'timeline.get': {'revision': 1},
            'timeline.seed': {'revision': 2},
            'timeline.render': {'id': IDS['export']},
            'export.watch': {'id': IDS['export']},
            'export.download': {'bytes': 1},
        }
        if operation == self.lost_operation:
            return subprocess.CompletedProcess(command, 1, stdout='')
        if operation == 'export.download':
            Path(command[command.index('--output') + 1]).write_bytes(b'fixture, not real media')
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps({
            'ok': True, 'data': responses[operation],
        }))

    def run(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        arguments = [str(SCRIPT), '--repo', str(self.repo), '--work-dir', str(self.work)]
        with patch.object(sys, 'argv', arguments), patch('subprocess.run', self.dispatch), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                runpy.run_path(str(SCRIPT), run_name='__main__')
            except SystemExit as error:
                return error.code, stdout.getvalue(), stderr.getvalue()
            except FileExistsError:
                return 1, stdout.getvalue(), 'work directory already exists'
        return 0, stdout.getvalue(), stderr.getvalue()


class MockWorkflowRecoveryTest(unittest.TestCase):
    def fixture(self, lost_operation=None):
        temporary = tempfile.TemporaryDirectory(prefix='mioon-skill-mock-')
        self.addCleanup(temporary.cleanup)
        return WorkflowFixture(Path(temporary.name), lost_operation)

    def assert_stable_key(self, record):
        request_id = record['input'].get('requestId')
        self.assertIsInstance(request_id, str, record['operation'])
        self.assertEqual(str(uuid.UUID(request_id)), request_id)

    def test_complete_workflow_logs_distinct_edit_keys_before_dispatch(self):
        fixture = self.fixture()
        status, stdout, stderr = fixture.run()
        self.assertEqual(status, 0, stderr)
        self.assertEqual([call['operation'] for call in fixture.calls], OPERATIONS)
        self.assertTrue(json.loads(stdout)['ok'])
        records = json.loads(fixture.state.read_text())
        for record, call in zip(records, fixture.calls):
            self.assertEqual(record['outcome'], 'ok')
            self.assertEqual(record['input'], call['pending']['input'])
            if record['operation'] in RECOVERABLE_EDITS:
                self.assert_stable_key(record)
        keys = [record['input']['requestId'] for record in records if 'requestId' in record['input']]
        self.assertEqual(len(keys), 6)
        self.assertEqual(len(set(keys)), len(keys))

    def test_each_lost_edit_response_retains_exact_input_and_stops(self):
        for operation in RECOVERABLE_EDITS:
            with self.subTest(operation=operation):
                fixture = self.fixture(operation)
                status, stdout, stderr = fixture.run()
                self.assertEqual(status, 1)
                self.assertEqual(stdout, '')
                self.assertIn('Inspect saved original request; do not blindly restart', stderr)
                self.assertEqual([call['operation'] for call in fixture.calls],
                                 OPERATIONS[:OPERATIONS.index(operation) + 1])
                records = json.loads(fixture.state.read_text())
                retained = records[-1]
                self.assertEqual(retained['operation'], operation)
                self.assertEqual(retained['outcome'], 'unreadable_response')
                self.assertEqual(retained['input'], fixture.calls[-1]['pending']['input'])
                self.assert_stable_key(retained)
                if operation == 'version.select':
                    self.assertEqual(retained['input']['expectedRevision'], 7)
                    self.assertEqual(retained['input']['versionId'], IDS['version'])

    def test_failed_work_directory_cannot_be_rerun_or_overwrite_recovery_log(self):
        fixture = self.fixture('node.create')
        self.assertEqual(fixture.run()[0], 1)
        original = fixture.state.read_bytes()
        count = len(fixture.calls)
        self.assertEqual(fixture.run()[0], 1)
        self.assertEqual(len(fixture.calls), count)
        self.assertEqual(fixture.state.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
