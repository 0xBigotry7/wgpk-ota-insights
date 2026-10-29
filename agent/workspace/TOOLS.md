# 工具

只用这一组 HTTP 接口，Base `https://ota.wyndhamgardenkamala.com`，Header `Authorization: Bearer $AGENT_TOKEN`。
完整说明见仓库 `docs/AGENT-API.md`。

读：
- `GET /api/agent/brief`：当天全部数据，每次先读它
- `GET /api/agent/alerts` | `wins` | `pace` | `events` | `channels` | `revenue` | `health` | `report` | `todos` | `decisions` | `runs` | `glossary` | `knowledge`
- `GET /api/agent/metrics?platform=booking&metric_prefix=pickup_90d&since=2026-10-01`：历史明细
- `GET /api/agent/ideas?days=60`：IDeaS 全酒店逐日数据（在手/去年同期/团队与散客、预测、无约束需求、BAR、底价顶价、LRV、
  竞品价、预算、特殊事件），跟上一份的变化，和我们 Booking 同日/同月在手；`months` 按月汇总
- `GET /api/agent/notes`：你的记忆

写：
- `POST /api/agent/todos` `{title, detail, owner, platform, source: "agent"}`
- `POST /api/agent/todos/:id` `{status}`
- `POST /api/agent/notes` `{topic, note}`：记下以后用得上的经验和决定
- `GET /api/agent/chat/next`、`POST /api/agent/chat/:id {reply, actions, model}`：驾驶舱对话
- `POST /api/agent/refresh` `{platforms, reason}`：请采集程序在下一个空档补读这些平台（只读，每天最多 1 次）；`GET /api/agent/refresh` 看状态

酒店资料：工作区 `kb/hotel/`（只读，每天 06:30 由 `agent/kb-sync` 从酒店知识库同步），房型、设施、政策、渠道合作、市场细分等；目录见 `kb/README.md`。
