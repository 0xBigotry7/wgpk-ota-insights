"""Paths and limits. Everything can be overridden from the launchd plist environment."""
from __future__ import annotations

import os
from pathlib import Path

HOME = Path(os.environ.get("WGPK_OTA_HOME", Path.home() / "wgpk-ota-insights"))
DATA = HOME / "data"
DB = DATA / "ota.sqlite"

# The review operator's run lock. Holding it means the review operator cannot start a run, and the
# operator holding it means we never touch its Chrome. See README "Isolation".
OPERATOR_LOCK = Path(os.environ.get("WGPK_OPERATOR_LOCK",
                                    "/Users/wyndham/wgpk-review-operator/operator.lock"))

# The review operator's already signed-in Chrome. We attach over CDP and never launch or quit it.
CDP_PORT = int(os.environ.get("WGPK_CDP_PORT", "9333"))

# Review windows (Asia/Bangkok, local Mac time). We refuse to start within AVOID_MARGIN_MIN of any of
# them, so a collection can never make the review operator skip a scheduled slot.
AVOID_SLOTS = [s.strip() for s in os.environ.get("WGPK_OTA_AVOID", "09:15,14:45").split(",") if s.strip()]
AVOID_MARGIN_MIN = int(os.environ.get("WGPK_OTA_AVOID_MARGIN_MIN", "60"))

# Hard ceiling for one whole collection (all platforms), and per page.
RUN_DEADLINE_S = int(os.environ.get("WGPK_OTA_DEADLINE_S", "600"))
PAGE_TIMEOUT_MS = 45000
SETTLE_MS = 6000          # let a dashboard finish rendering before reading it
PAUSE_BETWEEN_PAGES_MS = 4000
