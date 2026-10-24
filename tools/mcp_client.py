# -*- coding: utf-8 -*-
"""
麦当劳中国 MCP —— 零依赖调用封装（Streamable HTTP / JSON-RPC 2.0）

端点：https://mcp.mcd.cn
认证：Authorization: Bearer <MCD_MCP_TOKEN>
协议版本：2025-06-18

前置：到 https://open.mcd.cn 用手机号登录激活，拿到 MCP Token，
      填进同目录 .env 的 MCD_MCP_TOKEN=（或设同名环境变量）。

用法：
    # 1) 先握手 + 列出全部可用工具（强烈建议第一步跑这个）
    python mcd_mcp.py --tools

    # 2) 调某个工具
    python mcd_mcp.py query-nearby-stores '{"address":"中山大学南校园"}'
    python mcd_mcp.py query-meals '{"storeCode":"xxxx"}'

    # 3) 作为模块
    from mcd_mcp import Mcd
    m = Mcd()
    tools = m.list_tools()      # 拿真实工具清单（含入参 schema）
    r = m.call("query-nearby-stores", {"address": "..."})
"""

import os
import sys
import json
import uuid
import urllib.request
import urllib.error

ENDPOINT = "https://mcp.mcd.cn"
PROTOCOL_VERSION = "2025-06-18"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def _read_env_file(path):
    data = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return data


def load_token():
    env = _read_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    tok = os.environ.get("MCD_MCP_TOKEN") or env.get("MCD_MCP_TOKEN", "")
    if not tok or not tok.isascii() or len(tok) < 8:
        raise SystemExit(
            "缺少麦当劳 MCP Token。请在 tools/.env 中填写：\n"
            "  MCD_MCP_TOKEN=你的Token\n"
            "获取方式：https://open.mcd.cn 手机号登录激活后领取"
        )
    return tok


class Mcd:
    """麦当劳 MCP 客户端"""

    def __init__(self, token=None, endpoint=ENDPOINT):
        self.token = token or load_token()
        self.endpoint = endpoint
        self.session_id = None

    def _post(self, method, params=None, is_notify=False):
        body = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not is_notify:
            body["id"] = str(uuid.uuid4())

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self.token}",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id

        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                sid = r.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
                raw = r.read().decode("utf-8", errors="replace")
                return self._parse(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise SystemExit(f"HTTP {e.code} 调用失败（{method}）：\n{raw[:800]}")
        except Exception as e:
            raise SystemExit(f"调用失败（{method}）：{type(e).__name__} {e}")

    @staticmethod
    def _parse(raw):
        """兼容 application/json 与 text/event-stream 两种返回"""
        raw = raw.strip()
        if not raw:
            return {"result": None}
        if raw.startswith("event:") or "\nevent:" in raw or raw.startswith("data:"):
            for line in raw.split("\n"):
                if line.startswith("data:"):
                    try:
                        return json.loads(line[5:].strip())
                    except Exception:
                        pass
        try:
            return json.loads(raw)
        except Exception:
            return {"raw": raw[:800]}

    def initialize(self):
        r = self._post(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "workbuddy-hackathon", "version": "1.0"},
            },
        )
        self._post("notifications/initialized", is_notify=True)
        return r

    def list_tools(self):
        """返回真实工具清单（含入参 schema）—— 能力范围的权威来源"""
        if not self.session_id:
            self.initialize()
        r = self._post("tools/list", {})
        if "error" in r:
            raise SystemExit(f"tools/list 失败：{r['error']}")
        return r.get("result", {}).get("tools", [])

    def call(self, name, arguments=None):
        """调用指定工具"""
        if not self.session_id:
            self.initialize()
        r = self._post("tools/call", {"name": name, "arguments": arguments or {}})
        if "error" in r:
            raise SystemExit(f"调用 {name} 失败：{r['error']}")
        return r.get("result", {})


# ---------------------------------------------------------------- CLI

def _dump_tools(tools):
    print(f"✅ 握手成功，共 {len(tools)} 个工具\n")
    for i, t in enumerate(tools, 1):
        name = t.get("name", "")
        desc = (t.get("description") or "").replace("\n", " ")
        print(f"[{i:02d}] {name}")
        print(f"     {desc[:150]}")
        schema = t.get("inputSchema") or {}
        props = schema.get("properties") or {}
        if props:
            required = set(schema.get("required") or [])
            parts = []
            for k, v in props.items():
                mark = "*" if k in required else " "
                parts.append(f"{mark}{k}:{v.get('type','?')}")
            print(f"     入参: {', '.join(parts)}")
        print()


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return

    m = Mcd()

    if args[0] == "--tools":
        _dump_tools(m.list_tools())
        return

    name = args[0]
    raw_args = args[1] if len(args) > 1 else "{}"
    try:
        arguments = json.loads(raw_args)
    except Exception as e:
        raise SystemExit(f"参数不是合法 JSON：{e}\n示例：python mcd_mcp.py {name} '{{\"key\":\"value\"}}'")
    print(json.dumps(m.call(name, arguments), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
