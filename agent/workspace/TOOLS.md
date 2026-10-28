# 工具

只用这一组 HTTP 接口，Base `https://ota.wyndhamgardenkamala.com`，Header `Authorization: Bearer $AGENT_TOKEN`。
完整说明见仓库 `docs/AGENT-API.md`。

读：
- `GET /api/agent/brief`：当天全部数据，每次先读它
- `GET /api/agent/alerts` | `wins` | `pace` | `events` | `channels` | `revenue` | `health` | `report` | `todos` | `decisions` | `runs` | `glossary` | `knowledge`
- `GET /api/agent/metrics?platform=booking&metric_prefix=pickup_90d&since=2026-10-01`：历史明细
- `GET /api/agent/notes`：你的记忆

写：
- `POST /api/agent/todos` `{title, detail, owner, platform, source: "agent"}`
- `POST /api/agent/todos/:id` `{status}`
- `POST /api/agent/notes` `{topic, note}`：记下以后用得上的经验和决定
- `GET /api/agent/chat/next`、`POST /api/agent/chat/:id {reply, actions, model}`：驾驶舱对话

酒店知识库：`~/agents/shared`（只读），房型、政策、SOP、竞品等。
