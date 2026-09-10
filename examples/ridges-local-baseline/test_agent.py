import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import os

spec = importlib.util.spec_from_file_location('baseline', pathlib.Path(__file__).with_name('agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class BaselineTests(unittest.TestCase):
    def test_requests_provider_enforced_json(self):
        budget = dict(limit=5, limit_remaining=4, limit_reset=None)
        reply = {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"files":["code.py"]}'}}]}
        with patch.object(agent, 'request', side_effect=[{'data': budget}, reply]) as request:
            self.assertEqual(agent.ask('fake', 'select files', {}, 1500, agent.FILE_SCHEMA), {'files': ['code.py']})
        payload = request.call_args.args[2]
        self.assertEqual(payload['response_format']['type'], 'json_schema')
        self.assertTrue(payload['response_format']['json_schema']['strict'])
        self.assertTrue(payload['provider']['require_parameters'])
        self.assertEqual(payload['provider']['only'], ['anthropic'])

    def test_requires_non_resetting_limited_key(self):
        valid = dict(limit=5, limit_remaining=5, limit_reset=None, include_byok_in_limit=True)
        agent.check_budget(valid)
        agent.check_budget({**valid, "include_byok_in_limit": False})
        for changes in ({'limit': None}, {'limit': 6}, {'limit_remaining': 0},
                        {'limit_reset': 'daily'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                agent.check_budget({**valid, **changes})

    def test_edits_only_selected_files_and_validate_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / 'code.py'
            source.write_text('value = 1\n')
            contents = {'code.py': source.read_text()}
            good = dict(path='code.py', old='value = 1', new='value = 2')
            for bad in (dict(path='../escape', old='x', new='y'),
                        dict(path='code.py', old='missing', new='y')):
                with self.assertRaises(ValueError):
                    agent.apply_edits(root, contents, [good, bad])
                self.assertEqual(source.read_text(), 'value = 1\n')
            agent.apply_edits(root, contents, [good])
            self.assertEqual(source.read_text(), 'value = 2\n')

    def test_full_candidate_returns_patch_and_restores_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'code.py').write_text('value = 1\n')
            subprocess.run(['git', '-C', str(root), 'add', 'code.py'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test',
                            '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'], check=True)
            original = pathlib.Path.cwd()
            try:
                os.chdir(root)
                with patch.dict(os.environ, {'RIDGES_INFERENCE_PROVIDER': 'openrouter',
                                             'RIDGES_INFERENCE_API_KEY': 'fake'}), patch.object(
                        agent, 'ask', side_effect=[{'files': ['code.py']}, {'edits': [
                            dict(path='code.py', old='value = 1', new='value = 2')]}]) as ask:
                    result = agent.agent_main({'problem_statement': 'Set value to 2'})
                self.assertIn('+value = 2', result)
                self.assertEqual(ask.call_count, 2)
                self.assertEqual((root / 'code.py').read_text(), 'value = 1\n')
                self.assertEqual(agent.git(root, 'diff'), '')
                self.assertIn('source_matches', ask.call_args_list[0].args[2])
            finally:
                os.chdir(original)

    def test_symbol_search_finds_existing_implementation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'unexpected.py').write_text('class ExistingThing:\n    pass\n')
            subprocess.run(['git', '-C', str(root), 'add', 'unexpected.py'], check=True)
            found = agent.source_matches(root, 'ExistingThing fails for properties')
            self.assertIn('unexpected.py:1:class ExistingThing:', found)
            self.assertEqual(agent.source_matches(root, 'MissingThing fails'), '')

    def test_rejects_symlink_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'real.py').write_text('value = 1\n')
            (root / 'link.py').symlink_to('real.py')
            with self.assertRaises(ValueError):
                agent.read_sources(root, ['link.py'], {'link.py'})

if __name__ == '__main__':
    unittest.main()
