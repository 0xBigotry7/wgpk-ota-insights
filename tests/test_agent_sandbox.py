"""The ota agent's code sandbox (Seatbelt profile + runner). Behaviour is checked on the Mac mini; here the
profile's guarantees are pinned so a careless edit cannot silently widen them."""
from pathlib import Path

SB = (Path(__file__).resolve().parent.parent / "agent" / "sandbox" / "ota.sb").read_text()
RUN = (Path(__file__).resolve().parent.parent / "agent" / "sandbox" / "ota-run").read_text()


def test_profile_denies_by_default_and_has_no_network():
    assert "(deny default)" in SB and "(deny network*)" in SB
    assert "(allow network" not in SB


def test_home_and_temp_are_unreadable_except_the_workspace():
    assert '(deny file-read* (subpath "/Users") (subpath "/Volumes"))' in SB
    assert '(subpath "/private/tmp")' in SB and '(subpath "/private/var/folders")' in SB
    assert '(allow file-read* (subpath (param "WORKSPACE")))' in SB


def test_writes_only_to_workdir():
    writes = SB.split("(allow file-write*", 1)[1].split(")\n(", 1)[0]
    assert '(param "WORKDIR")' in writes and "WORKSPACE" not in writes and "/Users" not in writes


def test_runner_clears_the_environment_and_uses_the_profile():
    assert "/usr/bin/env -i" in RUN and "/usr/bin/sandbox-exec -f" in RUN
    assert 'cd "$WORKDIR"' in RUN


def test_mach_lookup_is_an_explicit_allowlist_and_no_iokit_or_shm():
    assert SB.count("(allow mach-lookup") == 1 and "mach-lookup)" not in SB      # never a bare allow
    block = SB.split("(allow mach-lookup", 1)[1].split("))", 1)[0]
    assert set(block.split('"')[1::2]) <= {"com.apple.system.opendirectoryd.libinfo", "com.apple.system.logger",
                                           "com.apple.logd", "com.apple.system.notification_center"}
    assert "iokit-open" not in SB and "ipc-posix-shm" not in SB


def test_launchd_gui_keychain_clipboard_and_schedulers_cannot_be_run():
    for tool in ("/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript", "/usr/bin/security", "/usr/bin/crontab",
                 "/usr/bin/at", "/usr/bin/pbpaste", "/usr/bin/sudo", "/usr/bin/ssh", "/usr/bin/sandbox-exec"):
        assert f'(literal "{tool}")' in SB.split("(deny process-exec", 1)[1].split("))", 1)[0], tool
    assert '(deny process-exec (subpath (param "WORKSPACE")))' in SB      # no running copies from work/


def test_all_users_and_volumes_unreadable_except_workspace():
    assert '(deny file-read* (subpath "/Users") (subpath "/Volumes"))' in SB
    deny_at = SB.index('(deny file-read* (subpath "/Users")')
    assert SB.index('(allow file-read* (subpath (param "WORKSPACE")))') > deny_at   # later rule re-allows only it
