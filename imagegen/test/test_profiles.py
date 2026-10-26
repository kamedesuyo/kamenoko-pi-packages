import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from imagegen_profiles import prepare, bind, list_profiles


class ProfilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'weights.bin').touch()
        self.graph = {'1': {'class_type': 'TestSampler', 'inputs': {'text': '', 'width': 512, 'height': 512, 'seed': 0, 'model': ''}},
                      '2': {'class_type': 'SaveImage', 'inputs': {'images': ['1', 0]}}}
        (self.root / 'graph.json').write_text(json.dumps(self.graph))
        self.profile = {'adapter': 'workflow', 'workflow': 'graph.json', 'outputNode': '2',
                        'bindings': {k: [['1', v]] for k, v in [('prompt','text'),('width','width'),('height','height'),('seed','seed'),('model.weights','model')]},
                        'models': {'weights': {'path': 'weights.bin', 'folder': 'diffusion_models'}}}
        self.config = {'comfy': {'dir': '.'}, 'defaultProfile': 'mine', 'profiles': {'mine': self.profile}}
        self.path = self.root / 'config.json'

    def prepare(self, request):
        self.path.write_text(json.dumps(self.config))
        return prepare(request, self.path)

    def test_no_qwen_or_sdxl_config_needed(self):
        result = self.prepare({'prompt': 'snow field'})
        self.assertEqual(result['request']['profile'], 'mine')
        self.assertEqual(result['payload']['model_values']['model.weights'], 'weights.bin')
        self.assertEqual(list_profiles(self.config)['profiles'][0]['id'], 'mine')

    def test_unknown_profile_or_client_path_cannot_override_registry(self):
        for req in ({'profile':'missing'}, {'workflow':'untrusted.json'}, {'runner':'other.py'}):
            with self.subTest(req=req), self.assertRaises(ValueError):
                self.prepare({'prompt':'test', **req})

    def test_missing_model_and_binding_fail_before_execution(self):
        self.profile['bindings']['seed'] = [['missing', 'seed']]
        with self.assertRaisesRegex(ValueError, 'binding'):
            self.prepare({'prompt': 'test'})
        self.profile['bindings']['seed'] = [['1','seed']]
        self.profile['models']['weights']['path'] = 'missing.bin'
        with self.assertRaisesRegex(ValueError, 'ファイル'):
            self.prepare({'prompt': 'test'})

    def test_prompt_is_data_and_seed_is_rebound_per_image(self):
        result = self.prepare({'prompt':'"日本語" $(echo no)', 'seed':41})
        before = copy.deepcopy(result['payload']['workflow'])
        values = {**result['request'], **result['payload']['model_values'], 'width':768, 'height':1024}
        for seed in (41,42):
            graph = bind(copy.deepcopy(before), self.profile['bindings'], {**values,'seed':seed})
            self.assertEqual(graph['1']['inputs']['text'], '"日本語" $(echo no)')
            self.assertEqual(graph['1']['inputs']['seed'], seed)
        self.assertEqual(result['payload']['workflow'], before)

    def test_unbound_controls_and_references_are_not_silently_ignored(self):
        for req in ({'steps':4}, {'references':[{}]}):
            with self.subTest(req=req), self.assertRaises(ValueError):
                self.prepare({'prompt':'test', **req})


if __name__ == '__main__':
    unittest.main()
