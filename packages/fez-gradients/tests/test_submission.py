import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('fez_submission', Path(__file__).parents[1] / 'container' / 'fez_submission.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SubmissionTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(NETUID='241', SUBTENSOR_NETWORK='test', GRADIENTS_TOURNAMENT_TYPE='text',
                        GRADIENTS_TRAINING_REPO='https://github.com/example/training', GRADIENTS_TRAINING_COMMIT='a' * 40)

    def test_selected_tournament_only(self):
        result = module.submission_for('text', self.env)
        self.assertEqual(result['github_repo'], self.env['GRADIENTS_TRAINING_REPO'])
        self.assertEqual(result['commit_hash'], 'a' * 40)
        self.assertIsNone(result['github_token'])
        self.assertIsNone(module.submission_for('image', self.env))

    def test_rejects_wrong_chain_and_invalid_submission(self):
        for key, value in [('NETUID', '56'), ('SUBTENSOR_NETWORK', 'finney'),
                           ('GRADIENTS_TRAINING_COMMIT', 'main'), ('GRADIENTS_TRAINING_REPO', 'https://github.com/u/r?token=x'),
                           ('GRADIENTS_TOURNAMENT_TYPE', 'all')]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    module.submission_for('text', {**self.env, key: value})
        with self.assertRaises(ValueError):
            module.submission_for('text', {})

if __name__ == '__main__':
    unittest.main()
