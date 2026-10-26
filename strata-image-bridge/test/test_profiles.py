import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

runtime = os.environ.get('STRATA_RUNTIME')
if runtime:
    sys.path.insert(0, runtime)
    from serve import images
    from serve.local_comfy import prepare_command


@unittest.skipUnless(runtime, 'Set STRATA_RUNTIME to the runtime-package under test')
class ProfileBridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cfg = {'exe': sys.executable, 'out_dir': self.temp.name,
                    'local_comfy': {'runner': 'profile-runner.py', 'profiles_config': 'config.json'}}

    def test_no_specific_model_files_required_and_response_identifies_selection(self):
        gen = images.ImageGen(self.cfg)
        self.assertEqual(gen.model, 'local-image-profiles')
        self.assertTrue(gen.status()['profiles'])
        job = {'prompt':'test','seed':1,'response_format':'b64_json','width':1024,'height':1024,
               'profile_payload':{'profile':'mine'}}
        response = gen.response([b'png'], job, {}, 'http://localhost')
        self.assertEqual(response['model'], 'mine')
        self.assertEqual(response['strata']['profile'], 'mine')

    def test_profile_defaults_and_request_are_resolved_before_execution(self):
        prepared = {'request':{'prompt':'text','size':'768x1024','steps':17,'seed':2},
                    'payload':{'adapter':'workflow','profile':'mine'}}
        with patch('serve.local_comfy.prepare_profile', return_value=prepared) as resolve:
            job = images.parse_request({'prompt':'text','profile':'mine'},self.cfg)
        resolve.assert_called_once()
        self.assertEqual((job['width'],job['height'],job['steps']), (768,1024,17))
        self.assertEqual(job['profile_payload'],prepared['payload'])
        cmd = prepare_command(self.cfg,job,str(Path(self.temp.name)/'img_%d.png'))
        payload = json.loads(Path(cmd[-1]).read_text(encoding='utf-8'))
        self.assertEqual(payload['profile'],'mine')
        self.assertTrue(payload['strata_managed'])
        self.assertEqual(payload['seeds'],[2])

    def test_unregistered_profile_errors_in_parse_and_legacy_does_not_ignore_selection(self):
        with patch('serve.local_comfy.prepare_profile', side_effect=ValueError('unknown profile')):
            with self.assertRaisesRegex(ValueError,'unknown profile'):
                images.parse_request({'prompt':'test','profile':'missing'},self.cfg)
        with self.assertRaisesRegex(ValueError,'no profile registry'):
            images.parse_request({'prompt':'test','profile':'mine'}, {})

    def test_legacy_request_without_profile_keeps_existing_contract(self):
        job = images.parse_request({'prompt':'text','seed':0}, {})
        self.assertNotIn('profile_payload',job)
        self.assertEqual(job['seed'],0)
