#!/usr/bin/env python3
"""DeepWrite 控制面 MCP 服务器（stdio，零第三方依赖）。

把 dwctl 的能力暴露为 MCP 工具，供支持 MCP 的 AI 客户端（如 ZCode）直接调用。
ZCode 注册示例（settings.json 的 mcpServers）：
  "deepwrite": {
    "command": "python",
    "args": ["L:/deepwrite-main/tools/dw-mcp.py"]
  }

协议：JSON-RPC 2.0 over stdio（MCP 2.x 基线：initialize / tools/list / tools/call）。
令牌发现与 dwctl 相同：默认读 %APPDATA%\\@deepwrite\\desktop\\config\\control-plane.json。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROTOCOL_VERSION = "2024-11-05"
DEFAULT_PORT = 7630

TOOLS = [
    {
        "name": "dw_health",
        "description": "DeepWrite 应用健康检查：版本、pid、工作目录、控制面端口。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dw_config_map",
        "description": "返回 DeepWrite 各配置文件在磁盘上的路径（可直接读，写走 dw_call）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dw_logs_tail",
        "description": "读取 DeepWrite 启动/诊断日志尾部，用于排障。",
        "inputSchema": {
            "type": "object",
            "properties": {"lines": {"type": "integer", "default": 200}},
        },
    },
    {
        "name": "dw_call",
        "description": (
            "调用 DeepWrite 控制面白名单内的 Envelope 命令。"
            "例如 models.list / longAgents.list / longAgents.save / long.list / "
            "long.open / session.abort / catalog.previewLibraryPackageAtPath。"
            "完整白名单见 docs/control-plane.md。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "description": "命令类型，如 models.list"},
                "payload": {"type": "object", "default": {}},
                "sessionId": {
                    "type": "string",
                    "description": "session.* 命令必须传与会话一致的 sessionId",
                },
            },
            "required": ["type"],
        },
    },
    {
        "name": "dw_runs",
        "description": "查询进行中/已完成的智能体运行（runId 列表）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dw_run_long",
        "description": (
            "触发长篇作品的一次智能体运行（如写一章）并等待完成。"
            "返回接受回执；超时返回 runId 供 dw_runs 轮询。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "book": {"type": "string", "description": "书名（精确匹配）"},
                "message": {"type": "string", "description": "给长篇智能体的指令"},
                "root": {
                    "type": "string",
                    "enum": ["worldbuilding", "character_design", "plot_design",
                             "draft", "continuity_ledger"],
                    "default": "draft",
                },
                "timeoutSeconds": {"type": "integer", "default": 900},
            },
            "required": ["book", "message"],
        },
    },
]


sys.path.insert(0, str(Path(__file__).resolve().parent))
import dwctl  # noqa: E402 —— 复用端点解析与附带技能装配


def resolve_endpoint() -> tuple[int, str]:
    return dwctl.resolve_endpoint(
        __import__("argparse").Namespace(
            port=None, token=None, token_file=None))


def request(port: int, token: str, method: str, path: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))


def envelope(ctype: str, payload: dict, session_id: str | None = None) -> dict:
    now = int(time.time() * 1000)
    context: dict = {"correlationId": f"mcp-{now}"}
    if session_id:
        context["sessionId"] = session_id
    return {"protocolVersion": 1, "id": f"mcp-{now}", "type": ctype,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "context": context, "payload": payload}


def call_command(ctype: str, payload: dict, session_id: str | None = None):
    port, token = resolve_endpoint()
    return request(port, token, "POST", "/command",
                   envelope(ctype, payload, session_id))


def tool_dispatch(name: str, args: dict) -> str:
    if name == "dw_health":
        port, token = resolve_endpoint()
        return request(port, token, "GET", "/health")
    if name == "dw_config_map":
        port, token = resolve_endpoint()
        return request(port, token, "GET", "/config-map")
    if name == "dw_logs_tail":
        port, token = resolve_endpoint()
        return request(port, token, "GET",
                       f"/logs/tail?lines={args.get('lines', 200)}")
    if name == "dw_call":
        return call_command(args["type"], args.get("payload", {}),
                            args.get("sessionId"))
    if name == "dw_runs":
        port, token = resolve_endpoint()
        return request(port, token, "GET", "/runs")
    if name == "dw_run_long":
        port, token = resolve_endpoint()
        listed = request(port, token, "POST", "/command",
                         envelope("long.list", {}))
        books = [b for b in listed["payload"]["books"]
                 if b.get("title") == args["book"]]
        if not books:
            return {"error": f"未找到书：{args['book']}"}
        book = books[0]
        opened = request(port, token, "POST", "/command",
                         envelope("long.open", {"bookId": book["id"]}))
        summary = opened["payload"]["summary"]
        session_id = f"mcp-{int(time.time() * 1000)}"
        attached = dwctl.build_skill_attachments(port, token, book)
        accepted = call_command("session.prompt", {
            "sessionId": session_id,
            "message": args["message"],
            "writeApprovalMode": "auto-approve",
            "workspaceContext": {
                "longWorkspace": {
                    "bookId": book["id"], "title": book["title"],
                    "activeRoot": args.get("root", "draft"),
                    "activeAgentId": "long",
                    "navigation": summary["navigation"]},
                "attachedSkills": attached}},
            session_id=session_id)
        if accepted.get("status") != "accepted":
            return accepted
        run_id = accepted["payload"]["runId"]
        deadline = time.time() + args.get("timeoutSeconds", 900)
        while time.time() < deadline:
            time.sleep(5)
            runs = request(port, token, "GET", "/runs")
            if run_id in runs.get("terminalRunIds", []):
                return {"completed": True, "runId": run_id,
                        "sessionId": session_id}
        return {"completed": False, "runId": run_id, "sessionId": session_id,
                "note": "超时，用 dw_runs 继续轮询"}
    return {"error": f"未知工具：{name}"}


def handle(msg: dict) -> dict | None:
    method = msg.get("method", "")
    msg_id = msg.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "deepwrite-control-plane",
                           "version": "0.2.0"}}}
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params", {})
        try:
            result = tool_dispatch(params.get("name", ""),
                                   params.get("arguments", {}))
            text = json.dumps(result, ensure_ascii=False, indent=2)
            return {"jsonrpc": "2.0", "id": msg_id, "result": {
                "content": [{"type": "text", "text": text}]}}
        except Exception as error:  # noqa: BLE001 —— 错误必须回传给客户端
            return {"jsonrpc": "2.0", "id": msg_id, "result": {
                "content": [{"type": "text",
                             "text": f"ERROR: {error}"}], "isError": True}}
    if msg_id is not None:
        return {"jsonrpc": "2.0", "id": msg_id,
                "error": {"code": -32601, "message": f"未知方法：{method}"}}
    return None


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
