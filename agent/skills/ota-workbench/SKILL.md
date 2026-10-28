---
name: ota-workbench
description: Write and run your own Python or shell code for OTA analysis (pace tables, pickup, comparisons, charts as files) inside your workspace's work/ folder, in a sandbox without network. Use when the cockpit API gives you data you need to compute on.
---

# Your workbench

You may write code, but only for your OTA job and only in `work/` of your workspace.

1. Fetch data with the cockpit skill and save it as a file in `work/`, e.g. with your write tool:
   `/Users/wyndham/agents/ota/skills/ota-cockpit/ota-api GET '/api/agent/metrics?platform=booking&metric_prefix=pace_'` → save the output to `work/pace.json`.
2. Write your script to `work/` (write/edit tools; they only reach your workspace).
3. Run it with the sandbox runner, the only way to run code:

       /Users/wyndham/wgpk-ota-insights/app/agent/sandbox/ota-run python3 analyse.py
       /Users/wyndham/wgpk-ota-insights/app/agent/sandbox/ota-run /bin/sh -c 'ls -la'

   It starts in `work/`. Python 3.9 standard library only (json, csv, statistics, datetime, math…); no pip, no
   network, no access to anything outside your workspace. Files you create stay in `work/`.

Rules: never try to reach other folders, other agents, the review system, browsers or the network from code.
Results that matter go back through the cockpit (a note or a to-do via ota-api), not only into files.
