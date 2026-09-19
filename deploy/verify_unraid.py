"""Run inside the new container: python /home/nanobot/src/deploy/verify_unraid.py."""

import asyncio
import shlex

from nanobot.agent.tools.shell import ExecTool
from nanobot.config.loader import load_config


async def main():
    config = load_config()
    cfg = config.tools.exec
    tool = ExecTool(
        working_dir=str(config.workspace_path),
        allowed_env_keys=cfg.allowed_env_keys,
        path_prepend=cfg.path_prepend,
        path_append=cfg.path_append,
    )
    # Exercise the same filtered environment as an AI tool call, not docker exec.
    check = """
import os, shutil, sys
assert sys.prefix == '/app/.venv', sys.prefix
assert os.access(sys.prefix, os.W_OK)
for name in ('python', 'python3', 'rg', 'ffmpeg'):
    assert shutil.which(name), name
assert '/home/nanobot/.nanobot/workspace/bin' in os.environ['PATH'].split(':')
print('UNRAID_SKILL_RUNTIME_OK')
"""
    for python in ('python', 'python3'):
        result = await tool.execute(
            command=f'{python} -c {shlex.quote(check)}', login=False, timeout=60,
        )
        # Use synchronous run mode so the verification doesn't leave background jobs.
        if 'UNRAID_SKILL_RUNTIME_OK' not in str(result):
            raise RuntimeError(f'{python} skill runtime check failed: {result}')
    print('Shared Python and workspace tool PATH: OK')


if __name__ == '__main__':
    asyncio.run(main())
