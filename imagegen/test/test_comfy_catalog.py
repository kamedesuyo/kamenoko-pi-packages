import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('catalog', Path(__file__).parents[1] / 'comfy-catalog-server.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogIsolationTest(unittest.TestCase):
    def test_discovery_can_read_live_schemas_and_models(self):
        for path in ('/catalog_info', '/object_info', '/object_info/LoraLoader', '/models/loras', '/system_stats'):
            with self.subTest(path=path):
                self.assertTrue(catalog.catalog_path_allowed('GET', path))

    def test_generation_and_memory_mutations_are_rejected(self):
        for method in ('POST', 'PUT', 'DELETE', 'PATCH'):
            for path in ('/prompt', '/free', '/interrupt', '/upload/image', '/object_info'):
                with self.subTest(method=method, path=path):
                    self.assertFalse(catalog.catalog_path_allowed(method, path))

    def test_unrelated_get_routes_are_not_exposed(self):
        for path in ('/ws', '/view', '/internal/files', '/manager/reboot', '/object_info_fake'):
            with self.subTest(path=path):
                self.assertFalse(catalog.catalog_path_allowed('GET', path))


if __name__ == '__main__':
    unittest.main()
