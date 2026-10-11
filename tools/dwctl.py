#!/usr/bin/env python3
"""DeepWrite 本地控制面客户端（dwctl）。

用法示例：
  python tools/dwctl.py health
  python tools/dwctl.py config-map
  python tools/dwctl.py logs-tail --lines 100
  python tools/dwctl.py call --type models.list
  python tools/dwctl.py models-save --json models.json
  python tools/dwctl.py long-agent-save --json long-agent.json
  python tools/dwctl.py preview-library L:\\dir --domain skill
  python tools/dwctl.py import-library L:\\dir --domain skill [--only 名称,名称]
  python tools/dwctl.py create-long-book --title 冒烟测试 [--genre 都市]

令牌与端口默认从 %APPDATA%\\@deepwrite\\desktop\\config\\control-plane.json 读取；
也可用 --port / --token / --token-file 覆盖。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_PORT = 7630


def default_token_file() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        sys.exit("未找到 APPDATA 环境变量，请用 --token-file 指定令牌文件")
    return Path(appdata) / "@deepwrite" / "desktop" / "config" / "control-plane.json"


def resolve_endpoint(args: argparse.Namespace) -> tuple[int, str]:
    if args.token:
        return args.port, args.token
    token_file = Path(args.token_file) if args.token_file else default_token_file()
    try:
        config = json.loads(token_file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(
            f"令牌文件不存在：{token_file}\n"
            "DeepWrite 控制面未启用。把 config/control-plane.json 的 enabled 设为 true"
            "（或启动时设 DEEPWRITE_CONTROL_PLANE=1）后重启应用。"
        )
    if not config.get("token"):
        sys.exit(f"{token_file} 中没有令牌（控制面可能未启用）")
    return int(args.port or config.get("port", DEFAULT_PORT)), config["token"]


def request(port: int, token: str, method: str, path: str, payload=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))
    except urllib.error.URLError as e:
        sys.exit(f"连接控制面失败（{url}）：{e.reason}\n应用未启动或未启用控制面。")


def envelope_id() -> str:
    return f"dwctl-{int(time.time() * 1000)}"


def _envelope(ctype: str, payload: dict, session_id: str | None = None) -> dict:
    now = int(time.time() * 1000)
    context = {"correlationId": f"dwctl-{now}"}
    if session_id:
        context["sessionId"] = session_id
    return {"protocolVersion": 1, "id": f"dwctl-{now}", "type": ctype,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "context": context, "payload": payload}


# ---- 附带技能装配（无头运行与 GUI 对齐的关键：load_skill 靠它检索） ----

SKILL_ITEM_MAX_CHARS = 20_000
SKILL_ITEMS_MAX = 64


def _frontmatter_field(text: str, field: str) -> str:
    if not text.startswith("---"):
        return ""
    for line in text.split("\n")[1:]:
        if line.strip() == "---":
            break
        if line.startswith(f"{field}:"):
            return line.split(":", 1)[1].strip()
    return ""


def build_skill_attachments(port: int, token: str, book: dict) -> list[dict]:
    """按作品的技能库绑定装配 attachedSkills（与 GUI 的装配语义一致：
    标题=「库名 · 条目名」，load_skill 按完整标题/条目短名匹配）。"""
    _, cmap = request(port, token, "GET", "/config-map")
    registry = json.loads(Path(cmap["catalogRegistry"]).read_text(encoding="utf-8"))
    dirs: dict[str, tuple[str, str]] = {}  # id -> (dir, lib_title)
    for p in registry.get("projects", []):
        if not isinstance(p, dict) or p.get("domain") != "skill-library":
            continue
        directory = p.get("projectDirectory", "")
        if directory:
            dirs[p["id"]] = (directory, Path(directory).name)
    bound: list[tuple[str, str]] = []  # (libraryId, kind)
    for kind, ids in (book.get("linkedSkillIdsByKind") or {}).items():
        for library_id in ids or []:
            bound.append((library_id, kind))
    attachments: list[dict] = []
    for library_id, kind in bound:
        info = dirs.get(library_id)
        if not info:
            continue
        lib_dir, lib_title = info
        entries_dir = Path(lib_dir) / "entries"
        if not entries_dir.is_dir():
            continue
        for entry in sorted(entries_dir.glob("*.md")):
            if len(attachments) >= SKILL_ITEMS_MAX:
                return attachments
            try:
                raw = entry.read_text(encoding="utf-8")
            except OSError:
                continue
            name = _frontmatter_field(raw, "name") or entry.stem
            content = raw[:SKILL_ITEM_MAX_CHARS]
            attachments.append({
                "id": entry.stem,
                "title": f"{lib_title} · {name}",
                "content": content,
                "source": "attached-skill",
                "kind": kind,
            })
    return attachments


def call_command(args: argparse.Namespace, ctype: str, payload) -> dict:
    port, token = resolve_endpoint(args)
    session_id = None
    env = _envelope(ctype, payload, session_id=session_id)
    if ctype.startswith("session."):
        # session.* 的 envelope context 必须与 payload 的 sessionId/runId 一致
        if isinstance(payload, dict):
            if payload.get("sessionId"):
                env["context"]["sessionId"] = payload["sessionId"]
            if payload.get("runId"):
                env["context"]["runId"] = payload["runId"]
    status, body = request(port, token, "POST", "/command", env)
    print(json.dumps(body, ensure_ascii=False, indent=2))
    if body.get("status") != "accepted":
        sys.exit(1)
    return body


def main() -> None:
    parser = argparse.ArgumentParser(description="DeepWrite 本地控制面客户端")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--token", default=None)
    parser.add_argument("--token-file", default=None)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health")
    sub.add_parser("config-map")
    p = sub.add_parser("logs-tail"); p.add_argument("--lines", type=int, default=200)
    p = sub.add_parser("call"); p.add_argument("--type", required=True)
    p.add_argument("--payload", default="{}")
    p = sub.add_parser("models-save"); p.add_argument("--json", required=True)
    p = sub.add_parser("long-agent-save"); p.add_argument("--json", required=True)
    p = sub.add_parser("preview-library")
    p.add_argument("path"); p.add_argument("--domain", choices=["skill", "material"], default="skill")
    p = sub.add_parser("import-library")
    p.add_argument("path"); p.add_argument("--domain", choices=["skill", "material"], default="skill")
    p.add_argument("--only", default="", help="仅导入逗号分隔的库名；缺省全部导入")
    p.add_argument("--no-group", action="store_true")
    p = sub.add_parser("create-long-book")
    p.add_argument("--title", required=True)
    p.add_argument("--genre", default="都市")
    p.add_argument("--skill-ids", default="", help="逗号分隔的技能库 CatalogId")
    p.add_argument("--material-ids", default="", help="逗号分隔的素材库 CatalogId")
    p = sub.add_parser("runs")
    p = sub.add_parser("events")
    p.add_argument("--lines", type=int, default=50)
    p.add_argument("--session", default=None)
    p.add_argument("--types", default=None, help="逗号分隔的事件类型过滤")
    p = sub.add_parser("bind-library")
    p.add_argument("--book", required=True, help="书名（精确匹配）")
    p.add_argument("--library", required=True, help="技能库标题")
    p.add_argument("--kind", default="general")
    p = sub.add_parser("run-long")
    p.add_argument("--book", required=True, help="书名（精确匹配）")
    p.add_argument("--message", required=True)
    p.add_argument("--root", default="draft",
                   help="activeRoot：worldbuilding/character_design/plot_design/draft/continuity_ledger")
    p.add_argument("--timeout", type=int, default=900, help="等待运行完成的秒数")
    p.add_argument("--no-wait", action="store_true")

    args = parser.parse_args()
    if args.cmd == "health":
        port, token = resolve_endpoint(args)
        _, body = request(port, token, "GET", "/health")
        print(json.dumps(body, ensure_ascii=False, indent=2))
    elif args.cmd == "config-map":
        port, token = resolve_endpoint(args)
        _, body = request(port, token, "GET", "/config-map")
        print(json.dumps(body, ensure_ascii=False, indent=2))
    elif args.cmd == "logs-tail":
        port, token = resolve_endpoint(args)
        _, body = request(port, token, "GET", f"/logs/tail?lines={args.lines}")
        print("\n".join(body.get("lines", [])))
    elif args.cmd == "call":
        call_command(args, args.type, json.loads(args.payload))
    elif args.cmd == "models-save":
        call_command(args, "models.save", json.loads(Path(args.json).read_text("utf-8")))
    elif args.cmd == "long-agent-save":
        call_command(args, "longAgents.save", json.loads(Path(args.json).read_text("utf-8")))
    elif args.cmd == "preview-library":
        source_kind = "zip" if Path(args.path).suffix.lower() == ".zip" else "directory"
        call_command(args, "catalog.previewLibraryPackageAtPath", {
            "sourcePath": args.path, "sourceKind": source_kind, "domain": args.domain})
    elif args.cmd == "import-library":
        port, token = resolve_endpoint(args)
        source_kind = "zip" if Path(args.path).suffix.lower() == ".zip" else "directory"
        _, body = request(port, token, "POST", "/command", {
            "protocolVersion": 1, "id": envelope_id(),
            "type": "catalog.previewLibraryPackageAtPath",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "context": {"correlationId": envelope_id()},
            "payload": {"sourcePath": args.path, "sourceKind": source_kind,
                        "domain": args.domain}})
        if body.get("status") != "accepted":
            print(json.dumps(body, ensure_ascii=False, indent=2)); sys.exit(1)
        preview = body["payload"]["preview"]
        fingerprint = body["payload"]["sourceFingerprint"]
        only = {n.strip() for n in args.only.split(",") if n.strip()}
        libraries = [{
            "key": lib["key"], "include": not only or lib.get("title") in only,
            "title": lib.get("title") or lib["key"],
            **({"kind": lib["kind"]} if lib.get("kind") else {}),
        } for lib in preview["libraries"]]
        group = preview.get("group") or {}
        choices = {
            "libraries": libraries,
            "createGroup": bool(group.get("suggested")) and not args.no_group,
            **({"groupTitle": group["title"]} if group.get("title") else {}),
        }
        parent_name = {"skill": "skills", "material": "materials"}[args.domain]
        group_name = {"skill": "skill-groups", "material": "material-groups"}[args.domain]
        workspace = request(port, token, "GET", "/health")[1]["workspacePath"]
        call_command(args, "catalog.importLibraryPackageAtPath", {
            "sourcePath": args.path, "sourceKind": source_kind, "domain": args.domain,
            "expectedFingerprint": fingerprint, "choices": choices,
            "parents": {"library": os.path.join(workspace, parent_name),
                        "group": os.path.join(workspace, group_name)}})
    elif args.cmd == "create-long-book":
        payload = {"title": args.title, "genre": args.genre}
        if args.skill_ids:
            payload["linkedSkillIdsByKind"] = {"general": args.skill_ids.split(",")}
        if args.material_ids:
            payload["linkedMaterialIdsByKind"] = {"other": args.material_ids.split(",")}
        call_command(args, "long.createBook", payload)
    elif args.cmd == "runs":
        port, token = resolve_endpoint(args)
        _, body = request(port, token, "GET", "/runs")
        print(json.dumps(body, ensure_ascii=False, indent=2))
    elif args.cmd == "events":
        port, token = resolve_endpoint(args)
        qs = f"lines={args.lines}"
        if args.session:
            qs += f"&sessionId={urllib.parse.quote(args.session)}"
        if args.types:
            qs += f"&types={urllib.parse.quote(args.types)}"
        _, body = request(port, token, "GET", f"/events?{qs}")
        print(json.dumps(body, ensure_ascii=False, indent=2))
    elif args.cmd == "bind-library":
        port, token = resolve_endpoint(args)
        _, listed = request(port, token, "POST", "/command", _envelope(
            "long.list", {}))
        if listed.get("status") != "accepted":
            print(json.dumps(listed, ensure_ascii=False, indent=2)); sys.exit(1)
        book = next((b for b in listed["payload"]["books"]
                     if b.get("title") == args.book), None)
        if not book:
            sys.exit(f"未找到书：{args.book}")
        reg_path = None
        _, cmap = request(port, token, "GET", "/config-map")
        reg_path = Path(cmap["catalogRegistry"])
        registry = json.loads(reg_path.read_text(encoding="utf-8"))
        expected_tail = os.path.join("skills", args.library).lower()
        lib = next((v for v in registry.get("projects", [])
                    if isinstance(v, dict)
                    and v.get("domain") == "skill-library"
                    and v.get("projectDirectory", "").lower().endswith(expected_tail)),
                   None)
        if not lib:
            sys.exit(f"技能库注册表中未找到库：{args.library}")
        by_kind = dict(book.get("linkedSkillIdsByKind") or {})
        ids = list(by_kind.get(args.kind) or [])
        if lib["id"] not in ids:
            ids.append(lib["id"])
        by_kind[args.kind] = ids
        payload = {"bookId": book["id"],
                   "linkedMaterialIdsByKind": book.get("linkedMaterialIdsByKind") or {},
                   "linkedSkillIdsByKind": by_kind}
        if book.get("linkedResourceStageScopes") is not None:
            payload["linkedResourceStageScopes"] = book["linkedResourceStageScopes"]
        call_command(args, "long.updateBindings", payload)
    elif args.cmd == "run-long":
        port, token = resolve_endpoint(args)
        _, listed = request(port, token, "POST", "/command", _envelope("long.list", {}))
        if listed.get("status") != "accepted":
            print(json.dumps(listed, ensure_ascii=False, indent=2)); sys.exit(1)
        book = next((b for b in listed["payload"]["books"]
                     if b.get("title") == args.book), None)
        if not book:
            sys.exit(f"未找到书：{args.book}")
        _, opened = request(port, token, "POST", "/command", _envelope(
            "long.open", {"bookId": book["id"]}))
        if opened.get("status") != "accepted":
            print(json.dumps(opened, ensure_ascii=False, indent=2)); sys.exit(1)
        summary = opened["payload"]["summary"]
        session_id = f"dwctl-{int(time.time() * 1000)}"
        attached = build_skill_attachments(port, token, book)
        payload = {
            "sessionId": session_id,
            "message": args.message,
            "writeApprovalMode": "auto-approve",
            "autoApproveCrossStageOperations": True,
            "workspaceContext": {
                "longWorkspace": {
                    "bookId": book["id"], "title": book["title"],
                    "activeRoot": args.root, "activeAgentId": "long",
                    "navigation": summary["navigation"]},
                "attachedSkills": attached,
            },
        }
        status, accepted = request(port, token, "POST", "/command",
                                   _envelope("session.prompt", payload,
                                             session_id=session_id))
        print(json.dumps(accepted, ensure_ascii=False, indent=2)[:600])
        if accepted.get("status") != "accepted":
            sys.exit(1)
        run_id = accepted["payload"]["runId"]
        if args.no_wait:
            print(f"runId={run_id} sessionId={session_id}")
            return
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            time.sleep(5)
            _, runs = request(port, token, "GET", "/runs")
            if run_id in runs.get("terminalRunIds", []):
                print(f"运行已完成：runId={run_id} sessionId={session_id}")
                return
            _, ev = request(port, token, "GET",
                            f"/events?lines=10&sessionId={urllib.parse.quote(session_id)}")
            pending = [e for e in ev.get("events", [])
                       if e.get("type") == "agent.user_input_requested"]
            if pending:
                print("智能体在等待用户回答：")
                print(json.dumps(pending[-1], ensure_ascii=False, indent=2)[:1500])
                print(f"用 call --type session.user_input_response 回答；"
                      f"runId={run_id} sessionId={session_id}")
                sys.exit(3)
        print(f"等待超时（{args.timeout}s），运行可能仍在进行：runId={run_id}")
        sys.exit(2)


if __name__ == "__main__":
    main()
