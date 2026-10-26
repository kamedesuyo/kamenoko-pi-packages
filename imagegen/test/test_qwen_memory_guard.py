import ast
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch


SOURCE = Path(__file__).resolve().parents[1] / 'gen-image-qwen21-runner.py'
tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name in ('memory_reserve_gib', 'start_memory_guard')], type_ignores=[])
namespace = {'os': os, 'sys': sys, 'time': time, 'importlib': importlib, '__file__': str(SOURCE)}
exec(compile(functions, str(SOURCE), 'exec'), namespace)


class QwenMemoryGuardTest(unittest.TestCase):
    def test_config_and_overrides_preserve_neutral_default(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory)/'config.json'
            with patch.dict(os.environ, {'IMAGEGEN_CONFIG': str(config)}, clear=True):
                self.assertEqual(namespace['memory_reserve_gib']({}), 3)
                config.write_text(json.dumps({'qwen': {'min_free_ram_gib': 1}}), encoding='utf-8')
                self.assertEqual(namespace['memory_reserve_gib']({}), 1)
                with patch.dict(os.environ, {'IMAGEGEN_MIN_FREE_RAM_GIB': '2'}):
                    self.assertEqual(namespace['memory_reserve_gib']({}), 2)
                    self.assertEqual(namespace['memory_reserve_gib']({'min_free_ram_gib': 1.5}), 1.5)

    def test_invalid_values_cannot_silently_disable_guard(self):
        for value in (0, -1, True, float('nan'), float('inf'), 'invalid'):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                namespace['memory_reserve_gib']({'min_free_ram_gib': value})

    def run_guard(self, samples, reserve=1):
        targets = []
        available = Mock(side_effect=samples)
        def thread_factory(*, target, daemon):
            targets.append(target)
            class Thread:
                def start(self):
                    pass
            return Thread()
        with patch('threading.Thread', side_effect=thread_factory), patch('builtins.print'), \
                patch('time.sleep'), patch('os._exit', side_effect=SystemExit) as terminate, \
                patch.dict(namespace, available_memory=available):
            namespace['start_memory_guard']({'strata_managed': True, 'min_free_ram_gib': reserve})
            with self.assertRaises(SystemExit):
                targets[0]()
            terminate.assert_called_once_with(75)
            self.assertEqual(available.call_count, len(samples))

    def test_ram_between_one_and_three_gib_continues_until_new_floor(self):
        gib = 1024**3
        self.run_guard([(2*gib, 8*gib), (1.2*gib, 8*gib), (1*gib, 8*gib), (.9*gib, 8*gib), (.8*gib, 8*gib)])

    def test_commit_floor_remains_three_gib(self):
        gib = 1024**3
        self.run_guard([(8*gib, 2.9*gib), (8*gib, 2.8*gib)])

    def test_a_recovered_sample_resets_low_streak(self):
        gib = 1024**3
        self.run_guard([(.9*gib, 8*gib), (1.2*gib, 8*gib), (.9*gib, 8*gib), (.8*gib, 8*gib)])


if __name__ == '__main__':
    unittest.main()
