"""The workspace bootstrap runs before the gateway and failures stop startup."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('bootstrap_exit', [None, 0, 7])
@pytest.mark.parametrize('start_root', [False, True])
def test_workspace_bootstrap(tmp_path, bootstrap_exit, start_root):
    bash = ('C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))
    if not bash or not Path(bash).exists():
        pytest.skip('bash unavailable')
    root = Path(__file__).resolve().parents[1]
    binaries = tmp_path / 'bin'
    binaries.mkdir()
    commands = {
        'id': 'if [ "$1" = -g ]; then echo 100; elif [ "$2" = nanobot ]; then echo 99; else echo "$FAKE_UID"; fi',
        'chown': 'echo "CHOWN:$2"',
        'setpriv': (
            '[ "$1" = --reuid=99 ] && [ "$2" = --regid=100 ] || exit 9\n'
            'shift 3\nexport FAKE_UID=99\nexec "$@"'
        ),
        'nanobot': 'echo "GATEWAY_STARTED:$FAKE_UID"',
    }
    for name, body in commands.items():
        path = binaries / name
        path.write_text('#!/bin/sh\n' + body + '\n', encoding='utf-8', newline='\n')
        path.chmod(0o755)
    scripts = tmp_path / '.nanobot/workspace/scripts'
    scripts.mkdir(parents=True)
    if bootstrap_exit is not None:
        (scripts / 'bootstrap.sh').write_text(
            f'echo BOOTSTRAP_STARTED\nexit {bootstrap_exit}\n', encoding='utf-8', newline='\n',
        )
    # Set HOME inside bash so Git Bash does not replace it during initialization.
    result = subprocess.run(
        [bash, '-c', 'cd "$1"; export HOME="$PWD" PATH="$PWD/bin:$PATH"; sh "$2" gateway',
         'test', tmp_path.as_posix(), (root / 'entrypoint.sh').as_posix()],
        env={**os.environ, 'RENDER': 'false', 'FAKE_UID': '0' if start_root else '99'},
        capture_output=True, text=True,
    )
    assert (result.returncode == 0) == (bootstrap_exit in (None, 0)), result.stderr
    assert ('GATEWAY_STARTED' in result.stdout) == (bootstrap_exit in (None, 0))
    if bootstrap_exit == 0:
        assert result.stdout.index('BOOTSTRAP_STARTED') < result.stdout.index('GATEWAY_STARTED')
    if bootstrap_exit in (None, 0):
        assert 'GATEWAY_STARTED:99' in result.stdout
    if start_root:
        assert 'CHOWN:99:100' in result.stdout
