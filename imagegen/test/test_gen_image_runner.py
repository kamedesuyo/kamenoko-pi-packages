import ast
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'gen-image-runner.py'
tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name in ('claim_warm_job', 'assert_llm_stopped', 'configure_gpu', 'emit_progress')], type_ignores=[])
namespace = {'os': os, 'time': time, 'json': json}
exec(compile(functions, str(SOURCE), 'exec'), namespace)


class ImageRunnerLifecycleTest(unittest.TestCase):
    def test_powershell_forwards_complete_events_across_partial_writes(self):
        script = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-ImageProgress' }, $true)
. ([scriptblock]::Create($function.Extent.Text))
$path = [IO.Path]::GetTempFileName()
$stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
$progressReader = New-Object IO.StreamReader($stream)
$progressBuffer = @{ pending = '' }
try {
    [IO.File]::AppendAllText($path, '{"type":"progress","phase":"sampling",')
    Read-ImageProgress
    [IO.File]::AppendAllText($path, '"step":1}' + "`n" + '{"type":"progress","phase":"sampling","step":2}' + "`n")
    Read-ImageProgress
    Read-ImageProgress
    $progressReader.Dispose()
    Read-ImageProgress 3>$null
    if (-not $progressBuffer.failed) { throw 'Read failures must leave generation running' }
} finally {
    $progressReader.Dispose()
    Remove-Item -LiteralPath $path
}
'''
        with tempfile.TemporaryDirectory() as directory:
            check = Path(directory, 'forward.ps1')
            check.write_text(script, encoding='utf-8-sig')
            result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(check),
                                     str(SOURCE.with_name('gen-image.ps1'))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line.removeprefix('IMAGE_EVENT ')) for line in result.stdout.splitlines()
                  if line.startswith('IMAGE_EVENT ')]
        self.assertEqual([event['step'] for event in events], [1, 2])

    def test_progress_stream_keeps_each_frame_and_is_optional(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, 'progress.jsonl')
            with patch.dict(namespace, job={'progress_file': str(target)}):
                namespace['emit_progress']('sampling', index=1, step=1, preview='png-frame-1')
                namespace['emit_progress']('sampling', index=1, step=2, preview='png-frame-2')
                namespace['emit_progress']('decoding', index=1)
            events = [json.loads(line) for line in target.read_text().splitlines()]
            self.assertEqual([e.get('preview') for e in events], ['png-frame-1', 'png-frame-2', None])
            self.assertTrue(all(e['type'] == 'progress' for e in events))
            with patch.dict(namespace, job={}):
                namespace['emit_progress']('sampling', preview='not-requested')
            self.assertEqual(len(target.read_text().splitlines()), 3)

    def test_preview_io_failure_does_not_stop_generation(self):
        with patch.dict(namespace, job={'progress_file': 'Z:\\does-not-exist\\preview.jsonl'}):
            namespace['emit_progress']('sampling', step=1)

    def test_dedicated_gpu_uses_uuid_even_when_gpu_order_changes(self):
        listing = 'GPU-spare, NVIDIA GeForce RTX 4060\nGPU-llm, NVIDIA GeForce RTX 5060 Ti\n'
        with patch.dict(os.environ), patch.dict(namespace, assert_llm_stopped=lambda **kwargs: None), \
                patch('subprocess.check_output', return_value=listing):
            result = namespace['configure_gpu']({'gpu_mode': 'rtx4060', 'gpu_uuid': 'GPU-spare'})
            self.assertEqual(result['visible_devices'], 'GPU-spare')
            self.assertEqual(os.environ['CUDA_VISIBLE_DEVICES'], 'GPU-spare')
            with self.assertRaisesRegex(RuntimeError, 'UUID'):
                namespace['configure_gpu']({'gpu_mode': 'rtx4060', 'gpu_uuid': 'GPU-llm'})

    def test_shared_gpu_still_blocks_strata(self):
        ports = []
        def probe(**kwargs):
            port = kwargs.get('port', 8080)
            ports.append(port)
            if port == 8090:
                raise RuntimeError('LLM running')
        with patch.dict(namespace, assert_llm_stopped=probe):
            with self.assertRaisesRegex(RuntimeError, 'LLM'):
                namespace['configure_gpu']({})
        self.assertEqual(ports, [8080, 8090])

    def test_dedicated_gpu_does_not_bypass_legacy_llm_guard(self):
        def running(**kwargs):
            raise RuntimeError('LLM running')
        with patch.dict(namespace, assert_llm_stopped=running):
            with self.assertRaisesRegex(RuntimeError, 'LLM'):
                namespace['configure_gpu']({'gpu_mode': 'rtx4060', 'gpu_uuid': 'GPU-spare'})

    def test_dedicated_gpu_cannot_reuse_a_shared_warm_worker(self):
        with patch.dict(namespace, assert_llm_stopped=lambda **kwargs: None):
            with self.assertRaisesRegex(RuntimeError, 'プロセス'):
                namespace['configure_gpu']({'gpu_mode': 'rtx4060'}, warm=True)

    def test_expired_wait_does_not_replay_old_job(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory, 'warm.claimed')
            old.write_text('old image job')
            Path(directory, 'go').write_text('old start signal')
            result = namespace['claim_warm_job'](directory, 0)
            self.assertIsNone(result)
            self.assertEqual(old.read_text(), 'old image job')
            self.assertFalse(Path(directory, 'warm.ready').exists())

    def test_only_a_newly_claimed_job_is_returned_once(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory, 'warm.claimed')
            old.write_text('old job')
            pending = Path(directory, 'warm.job')
            pending.write_text('new job')
            result = namespace['claim_warm_job'](directory, 1)
            self.assertEqual(Path(result).read_text(), 'new job')
            self.assertFalse(pending.exists())
            self.assertEqual(old.read_text(), 'old job')
            self.assertIsNone(namespace['claim_warm_job'](directory, 0))

    def test_running_llm_blocks_image_generation(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            server.listen()
            with self.assertRaisesRegex(RuntimeError, 'LLM'):
                namespace['assert_llm_stopped'](port=server.getsockname()[1])

    def test_closed_llm_allows_image_generation(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            port = server.getsockname()[1]
        namespace['assert_llm_stopped'](port=port)


if __name__ == '__main__':
    unittest.main()
