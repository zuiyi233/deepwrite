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

## 命令白名单（阶段 1）

- **读**：`models.list`、`models.listRemote`、`models.test`、`modelUsage.query`、
  `workspaceDirectory.list`、`generalSettings.list`、`workspaceAgents.list`、
  `longAgents.list`、`libraryAgents.list`、`agentTeams.list`、`catalog.openProject`
- **写**：`models.save`、`generalSettings.save`、`workspaceAgents.save/reset`、
  `longAgents.save/reset`（长篇智能体提示词注入走这里）、`libraryAgents.save/reset`、
  `agentTeams.save/setEnabled/create/rename/delete`、`catalog.createLibrary`、
  `catalog.createLibraryGroup`、`long.createBook`
- **core 只读透传**：`long.getWorkspaceIndex`、`long.readDocument`、`long.search`
- **core 写透传（无头导库）**：`catalog.previewLibraryPackageAtPath`、
  `catalog.importLibraryPackageAtPath`

白名单之外（包括 `agent.prompt` 等会话运行命令）一律返回
`control_plane.command_not_allowed`。阶段 2 计划覆盖智能体运行触发。

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
```

令牌自动从 `%APPDATA%\@deepwrite\desktop\config\control-plane.json` 读取；
`--port/--token/--token-file` 可覆盖。命令返回非 accepted 时退出码为 1。

## 测试

- 单测：`apps/desktop/src/main/control-plane/*.test.ts`（config/auth/allowlist/log-tail）
- 冒烟：`node apps/desktop/scripts/electron-control-plane-smoke.mjs`（先 `pnpm build`）
