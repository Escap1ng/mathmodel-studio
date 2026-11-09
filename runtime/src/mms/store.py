"""M3 会话存储：用标准库 sqlite3 持久化阶段、待决卡与消息。

没有引入 LangGraph：这里需要的只有「暂停 + 跨进程恢复」两点，
显式状态机加一张表就够，依赖面更小（PLAN §8 已把自研列为可退让项）。
API Key 不进这张表，provider 只存 id 与模型名。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from .common import dump_json

PHASE_COUNT = 7
PHASE_NAMES = [
    "环境预检",
    "赛题分析与背景调研",
    "工作目录创建",
    "算法选择",
    "代码实现",
    "论文输出",
    "评分与优化",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created REAL NOT NULL,
  updated REAL NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  problem TEXT NOT NULL,
  phases TEXT NOT NULL,
  pending TEXT,
  messages TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 1,
  workspace TEXT
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated DESC);
"""


def data_dir(root: Path) -> Path:
    override = os.environ.get("MMS_DATA_DIR")
    return Path(override) if override else root / ".mms"


def session_scope(base: Path, session_id: object) -> Path:
    """会话产物的隔离目录：<base>/sessions/<sid>。

    sid 只接受十六进制：任何带 ../ 或分隔符的输入一律回落到旧全局目录，
    宁可与旧数据共用，也不让路径穿出 base。
    """
    sid = str(session_id or "").strip()
    if sid and all(ch in "0123456789abcdef" for ch in sid) and 8 <= len(sid) <= 64:
        return base / "sessions" / sid
    return base


def initial_phases() -> list[dict]:
    return [{"phase": i, "status": "idle", "name": PHASE_NAMES[i]} for i in range(PHASE_COUNT)]


class SessionStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)
            # 旧库没有 workspace 列：补一列，历史会话保持空值（回落全局工作区）。
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
            if "workspace" not in columns:
                conn.execute("ALTER TABLE sessions ADD COLUMN workspace TEXT")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        keys = row.keys()
        return {
            "id": row["id"],
            "created": row["created"],
            "updated": row["updated"],
            "provider": row["provider"],
            "model": row["model"],
            "problem": row["problem"],
            "phases": json.loads(row["phases"]),
            "pending": json.loads(row["pending"]) if row["pending"] else None,
            "messages": json.loads(row["messages"]),
            "batch": row["batch"],
            "workspace": row["workspace"] if "workspace" in keys else None,
        }

    def create(
        self, session_id: str, provider: str, model: str, problem: str, workspace: str = ""
    ) -> dict:
        now = time.time()
        record = {
            "id": session_id,
            "created": now,
            "updated": now,
            "provider": provider,
            "model": model,
            "problem": problem,
            "phases": initial_phases(),
            "pending": None,
            "messages": [],
            "batch": 1,
            "workspace": workspace,
        }
        with self.lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO sessions (id, created, updated, provider, model, problem, phases, pending, messages, batch, workspace)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    now,
                    now,
                    provider,
                    model,
                    problem,
                    dump_json(record["phases"]),
                    None,
                    "[]",
                    1,
                    workspace,
                ),
            )
        return record

    def get(self, session_id: str) -> dict | None:
        with self.lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._row(row)

    def latest(self) -> dict | None:
        with self.lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM sessions ORDER BY updated DESC LIMIT 1").fetchone()
        return self._row(row)

    def list_summaries(self, limit: int = 100) -> list[dict]:
        """左栏会话列表只需要标题、时间与待决状态，不把 messages 整包搬出来。"""
        with self.lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id, created, updated, provider, model, problem, phases, pending"
                " FROM sessions ORDER BY updated DESC LIMIT ?",
                (max(1, min(500, limit)),),
            ).fetchall()
        out: list[dict] = []
        for row in rows:
            out.append(
                {
                    "id": row["id"],
                    "created": row["created"],
                    "updatedAt": row["updated"],
                    "provider": row["provider"],
                    "model": row["model"],
                    "problem": row["problem"],
                    "phases": json.loads(row["phases"]),
                    "pending": bool(row["pending"]),
                }
            )
        return out

    def delete(self, session_id: str) -> bool:
        with self.lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return cur.rowcount > 0

    def clear(self) -> int:
        with self.lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM sessions")
        return max(0, cur.rowcount)

    def put(self, record: dict) -> None:
        record["updated"] = time.time()
        with self.lock, self._connect() as conn:
            conn.execute(
                "UPDATE sessions SET updated = ?, phases = ?, pending = ?, messages = ?, batch = ? WHERE id = ?",
                (
                    record["updated"],
                    dump_json(record["phases"]),
                    dump_json(record["pending"]) if record["pending"] is not None else None,
                    dump_json(record["messages"]),
                    record["batch"],
                    record["id"],
                ),
            )


def snapshot(record: dict | None) -> dict | None:
    if record is None:
        return None
    return {
        "id": record["id"],
        "provider": record["provider"],
        "model": record["model"],
        "problem": record["problem"],
        "updatedAt": record["updated"],
        "phases": record["phases"],
        "pending": record["pending"],
        "messages": record["messages"],
        "batch": record["batch"],
    }
