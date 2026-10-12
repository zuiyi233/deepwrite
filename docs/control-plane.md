# DeepWrite 本地控制面（AI 交互/排查/配置）

Main 进程内置一个仅监听 `127.0.0.1` 的 HTTP 控制面，让外部 AI/脚本可以读写配置、
触发无头操作、查询健康状态与启动日志。默认关闭，显式开启。

## 开启方式（二选一）

1. 配置文件：`<userData>/config/control-plane.json` 写入 `{ "enabled": true, "port": 7630 }`
2. 环境变量：启动前设 `DEEPWRITE_CONTROL_PLANE=1`（可用 `0` 强制关闭）

首次启用时自动生成 64 位十六进制 token 并写回配置文件。`<userData>` 即
`%APPDATA%\@deepwrite\desktop\`（除非用存储设置重定向）。

安全模型：仅回环监听 + Bearer token + 命令白名单（`control-plane/allowlist.ts`）；
白名单外命令一律拒绝；写操作记入启动日志；控制面不读写任何 API Key 明文
（`models.save` 的密钥仍由 ModelConfigStore 加密落盘）。Renderer 的内部命令
黑名单不适用于控制面——它本身是 Main 内部调用方，但白名单取代了那层约束。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 应用版本、pid、运行时长、当前工作目录、控制面配置路径 |
| GET | `/config-map` | 各配置文件在磁盘上的位置（见下） |
| GET | `/logs/tail?lines=200` | `diagnostics/startup.log` 尾部（自动续读 `.previous`，上限 1000 行） |
| POST | `/command` | 执行白名单内的 Envelope 命令，返回 `CommandResult` |

`POST /command` 请求体 = 完整 Envelope：

```json
{
  "protocolVersion": 1,
  "id": "dwctl-1",
  "type": "models.list",
  "timestamp": "2026-10-11T12:00:00Z",
  "context": { "correlationId": "dwctl-1" },
  "payload": {}
}
```

## 命令白名单（阶段 2）

- **读**：`models.list`、`models.listRemote`、`models.test`、`modelUsage.query`、
  `workspaceDirectory.list`、`generalSettings.list`、`workspaceAgents.list`、
  `longAgents.list`、`libraryAgents.list`、`agentTeams.list`、`catalog.openProject`
- **写**：`models.save`、`generalSettings.save`、`workspaceAgents.save/reset`、
  `longAgents.save/reset`（长篇智能体提示词注入走这里）、`libraryAgents.save/reset`、
  `agentTeams.save/setEnabled/create/rename/delete`、`catalog.createLibrary`、
  `catalog.createLibraryGroup`、`long.createBook`
- **智能体运行（阶段 2）**：`session.prompt`（触发长篇/短篇/剧本运行，payload 自包含：
  sessionId + message + workspaceContext.longWorkspace{bookId,title,activeRoot,
  activeAgentId,navigation}，envelope 的 context.sessionId 必须与 payload 一致）、
  `session.abort`、`session.user_input_response`
- **core 只读透传**：`long.list`、`long.open`、`long.getWorkspaceIndex`、
  `long.readDocument`、`long.search`
- **core 写透传（无头操作）**：`long.updateBindings`（改作品技能/素材库绑定）、
  `catalog.previewLibraryPackageAtPath`、`catalog.importLibraryPackageAtPath`

运行状态查询：`GET /runs` 返回 active 运行（runId/sessionId/correlationId/resourceId）
与 terminalRunIds——运行接受后轮询它直到 runId 进入 terminalRunIds。

`GET /events?since=<seq>` 返回控制面启动后累积的内部事件（`SystemEventEnvelope`，
环形缓冲带序号），供无头触发后观察智能体进度用；`/runs` 里出现 runId 且
`/events` 看到 `agent.user_input_requested` 时，用 `session.user_input_response`
应答（payload 携带 requestId 与逐条 answer）。

无头运行（`session.prompt`）的 workspaceContext 可携带 `attachedSkills`（标题形如
`库名 · 条目名`，供 load_skill 命中）、`writeApprovalMode: "auto-approve"` 与
`autoApproveCrossStageOperations: true`——批量稿件改写自动放行。已知边界：
**headless 无法为新章节实例化正文**（Renderer proposal 应用闭环不在无头路径内），
涉及新章节需保持 GUI 会话或接受该限制。

智能体的运行事件仍走 Main 的 `broadcastEvent` 广播到打开的界面（控制面与 index.ts
共享 activeRuns/terminalRuns/pendingUsageContexts 镜像，事件归账与 GUI 触发的运行
完全一致）。

## 配置文件地图（`GET /config-map` 返回）

读可以直接读文件；**写必须走 `/command`**（应用运行时直改文件会被内存态覆盖）：

- `%APPDATA%\@deepwrite\desktop\config\models.json` — 模型与加密密钥
- `config/workspace-directory.json`、`general-settings.json`、`appearance.json`
- `config/agent-team-profiles.json`、`library-agents.json`、
  `long-workspace-agents.json`、`workspace-agents.json`、`extras-agents/`
- `<工作目录>\catalog-registry.json`、`skills\<库名>\`、`materials\<库名>\`
- `diagnostics/startup.log` — 启动与诊断日志（JSONL）

## AI 排障流程

1. `GET /health` — 应用活着吗、工作目录在哪、版本多少
2. `GET /logs/tail?lines=200` — 启动有没有报错、子进程是否异常退出
3. `POST /command` + `system.health` — 各 Utility worker（core/agent/tool）健康
4. 定位后用白名单命令修正（如 `longAgents.save` 修提示词、`models.save` 修模型）

## dwctl 客户端（tools/dwctl.py）

```bash
python tools/dwctl.py health
python tools/dwctl.py logs-tail --lines 100
python tools/dwctl.py long-agent-save --json long-agent.json   # 注入总纲
python tools/dwctl.py import-library L:\staging\技能库导入 --domain skill
python tools/dwctl.py create-long-book --title 冒烟测试 --genre 都市
python tools/dwctl.py call --type models.list
python tools/dwctl.py bind-library --book 冒烟测试 --library 题材指南 --kind skill   # 绑定技能库
python tools/dwctl.py run-long --book 冒烟测试 --root draft \
  --message "加载技能并续写第 1 章（涉史内容）"                       # 无头运行，自动注入 attachedSkills
python tools/dwctl.py runs       # 轮询运行状态（runId → terminalRunIds）
python tools/dwctl.py events     # 订阅事件流，观察 user_input_requested
```

令牌自动从 `%APPDATA%\@deepwrite\desktop\config\control-plane.json` 读取；
`--port/--token/--token-file` 可覆盖。命令返回非 accepted 时退出码为 1。

## 测试

- 单测：`apps/desktop/src/main/control-plane/*.test.ts`（config/auth/allowlist/log-tail）
- 冒烟：`node apps/desktop/scripts/electron-control-plane-smoke.mjs`（先 `pnpm build`）
