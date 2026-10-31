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
  batch INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated DESC);
"""


def data_dir(root: Path) -> Path:
    override = os.environ.get("MMS_DATA_DIR")
    return Path(override) if override else root / ".mms"


def initial_phases() -> list[dict]:
    return [{"phase": i, "status": "idle", "name": PHASE_NAMES[i]} for i in range(PHASE_COUNT)]


def _dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False)


class SessionStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
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
        }

    def create(self, session_id: str, provider: str, model: str, problem: str) -> dict:
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
        }
        with self.lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO sessions (id, created, updated, provider, model, problem, phases, pending, messages, batch)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    now,
                    now,
                    provider,
                    model,
                    problem,
                    _dumps(record["phases"]),
                    None,
                    "[]",
                    1,
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
                    _dumps(record["phases"]),
                    _dumps(record["pending"]) if record["pending"] is not None else None,
                    _dumps(record["messages"]),
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
