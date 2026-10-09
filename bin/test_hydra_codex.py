import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('hydra_codex', ROOT / 'hydra-codex.py')
hydra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hydra)


class CodexRunnerTest(unittest.TestCase):
    def test_cli_runs_head_and_removes_rules(self):
        with tempfile.TemporaryDirectory() as base:
            project = Path(base) / 'project'
            project.mkdir()
            fake_bin = Path(base) / 'bin'
            fake_bin.mkdir()
            fake = fake_bin / 'commandcode'
            fake.write_text('''#!/usr/bin/env python3
import json
from pathlib import Path
import sys
rules = json.loads(Path('.commandcode/settings.local.json').read_text())
assert rules['managedBy'] == 'hydra'
assert 'Shell' in rules['permissions']['deny']
assert '--yolo' in sys.argv
Path('result.txt').write_text('made by head\\n')
print(json.dumps({'event': {'type': 'turn_end'}}))
print(json.dumps({'type': 'result', 'sessionId': 'mock-session', 'subtype': 'success',
                  'finalText': 'Created result.txt. HEAD DONE'}))
''')
            fake.chmod(0o755)
            env = dict(os.environ, PATH=f'{fake_bin}:{os.environ.get("PATH", "")}')
            ran = subprocess.run([sys.executable, str(ROOT / 'hydra-codex.py'), 'run',
                                  '--cwd', str(project), '--name', 'mock', '--max-turns', '4',
                                  'Create result.txt'], env=env, capture_output=True, text=True)
            self.assertEqual(ran.returncode, 0, ran.stderr + ran.stdout)
            self.assertIn('finished · 1 round(s) · 1 turns', ran.stdout)
            self.assertEqual((project / 'result.txt').read_text(), 'made by head\n')
            self.assertFalse((project / hydra.RULES).exists())

    def test_rules_guard_and_cleanup(self):
        with tempfile.TemporaryDirectory() as base:
            project = Path(base) / 'project'
            project.mkdir()
            (project / '.env').write_text('FAKE=1\n')
            outside = Path(base) / 'outside.txt'
            key = 'codex/test'
            entry = {'key': key, 'until': (hydra.time.time() + 60) * 1000,
                     'addDirs': [], 'writeDirs': [], 'shell': False}
            env = hydra.update_rules(str(project), add=entry)
            self.assertEqual(env, str(project / '.env'))
            rules = json.loads((project / hydra.RULES).read_text())
            self.assertIn('Grep', rules['permissions']['deny'])
            self.assertIn('Shell', rules['permissions']['deny'])
            self.assertIn('Edit(/.git/**)', rules['permissions']['deny'])
            self.assertEqual(rules['hydraHeads'][0]['key'], key)
            guard = ROOT / 'head-guard.py'
            event = {'tool_name': 'write_file', 'cwd': str(project),
                     'tool_input': {'file_path': str(outside)}}
            denied = subprocess.run([sys.executable, str(guard), str(project)],
                                    input=json.dumps(event), text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(denied.stdout)['hookSpecificOutput']['permissionDecision'], 'deny')
            event['tool_input']['file_path'] = str(project / 'inside.txt')
            allowed = subprocess.run([sys.executable, str(guard), str(project)],
                                     input=json.dumps(event), text=True, capture_output=True, check=True)
            self.assertEqual(allowed.stdout, '')
            hydra.update_rules(str(project), remove=key)
            self.assertFalse((project / hydra.RULES).exists())

    def test_refuses_unowned_rules(self):
        with tempfile.TemporaryDirectory() as base:
            project = Path(base) / 'project'
            (project / '.commandcode').mkdir(parents=True)
            (project / hydra.RULES).write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'your own rules'):
                hydra.update_rules(str(project), add={
                    'key': 'codex/test', 'until': (hydra.time.time() + 60) * 1000,
                    'addDirs': [], 'writeDirs': [], 'shell': False})

    def test_shared_rules_keep_other_head_and_granted_folder(self):
        with tempfile.TemporaryDirectory() as base:
            project = Path(base) / 'project'
            granted = Path(base) / 'granted'
            project.mkdir()
            granted.mkdir()
            until = (hydra.time.time() + 60) * 1000
            first = {'key': 'claude/first', 'until': until, 'addDirs': [],
                     'writeDirs': [], 'shell': False}
            second = {'key': 'codex/second', 'until': until, 'addDirs': [],
                      'writeDirs': [str(granted)], 'shell': False}
            hydra.update_rules(str(project), add=first)
            hydra.update_rules(str(project), add=second)
            rules = json.loads((project / hydra.RULES).read_text())
            self.assertEqual({e['key'] for e in rules['hydraHeads']},
                             {'claude/first', 'codex/second'})
            self.assertIn(str(granted), rules['permissions']['additionalDirectories'])
            self.assertIn(f'Edit(/{granted}/.git/**)', rules['permissions']['deny'])
            hydra.update_rules(str(project), remove='codex/second')
            remaining = json.loads((project / hydra.RULES).read_text())
            self.assertEqual([e['key'] for e in remaining['hydraHeads']], ['claude/first'])
            hydra.update_rules(str(project), remove='claude/first')
            self.assertFalse((project / hydra.RULES).exists())


if __name__ == '__main__':
    unittest.main()
