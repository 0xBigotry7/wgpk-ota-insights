# OTA daily brief automation (OpenClaw cron bf40bc1c, 10:45 Asia/Bangkok, delivered to Gary on the ota bot)

Applied on the Mac mini (save the old payload first with `openclaw cron get bf40bc1c-… > backup`):
`openclaw cron edit bf40bc1c-6571-46ee-aedb-126df6643360 --message "$(sed -n '/^每日 OTA/,$p' agent/automations/daily-brief.md)"`
(the 10:55 forward to 老姚, ff2f9d46, copies the saved note verbatim and is not changed).

Message:

每日 OTA 简报（定时任务）。按 HEARTBEAT.md「每日简报」的格式写：只读 `ota-api GET /api/agent/daily`，需要细节再查单个
接口，不要读整份 /api/agent/brief。顺序：全酒店（IDeaS）→ 趋势（pickup，差距缩小还是扩大）→ 今天要做的事（最多 3 条，
和昨天一样的不列）→ 跟进（昨天的事、闲置 ≥3 天的待办）→ 到期的学习检查点 → 今天新出现的数据缺口。最多约 12 行，
中文，Gary 和老姚都会看。今天是周一时加“谁没动”一行。先 POST /api/agent/notes 保存（topic "daily-brief-YYYY-MM-DD"），
再把简报原文作为最终回复输出。不要创建待办。
