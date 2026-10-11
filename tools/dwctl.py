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


def call_command(args: argparse.Namespace, ctype: str, payload) -> dict:
    port, token = resolve_endpoint(args)
    status, body = request(port, token, "POST", "/command", {
        "protocolVersion": 1,
        "id": envelope_id(),
        "type": ctype,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "context": {"correlationId": envelope_id()},
        "payload": payload,
    })
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


if __name__ == "__main__":
    main()
