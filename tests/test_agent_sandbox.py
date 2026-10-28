"""The ota agent's code sandbox (Seatbelt profile + runner). Behaviour is checked on the Mac mini; here the
profile's guarantees are pinned so a careless edit cannot silently widen them."""
from pathlib import Path

SB = (Path(__file__).resolve().parent.parent / "agent" / "sandbox" / "ota.sb").read_text()
RUN = (Path(__file__).resolve().parent.parent / "agent" / "sandbox" / "ota-run").read_text()


def test_profile_denies_by_default_and_has_no_network():
    assert "(deny default)" in SB and "(deny network*)" in SB
    assert "(allow network" not in SB


def test_home_and_temp_are_unreadable_except_the_workspace():
    assert '(deny file-read* (subpath "/Users/wyndham"))' in SB
    assert '(subpath "/private/tmp")' in SB and '(subpath "/private/var/folders")' in SB
    assert '(allow file-read* (subpath (param "WORKSPACE")))' in SB


def test_writes_only_to_workdir():
    writes = SB.split("(allow file-write*", 1)[1].split(")\n(", 1)[0]
    assert '(param "WORKDIR")' in writes and "WORKSPACE" not in writes and "/Users" not in writes


def test_runner_clears_the_environment_and_uses_the_profile():
    assert "/usr/bin/env -i" in RUN and "/usr/bin/sandbox-exec -f" in RUN
    assert 'cd "$WORKDIR"' in RUN
