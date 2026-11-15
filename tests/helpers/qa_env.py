"""Allow only operating-system and media tool settings in Python QA subprocesses."""

import os


def test_env(**overrides):
    names = (
        'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot',
        'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
        'MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH',
    )
    env = {name: os.environ[name] for name in names if name in os.environ}
    env.update(overrides)
    return env
