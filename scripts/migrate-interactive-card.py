#!/usr/bin/env python3
"""
Migrate existing sessions from the legacy `card-buttons` skill + `## 交互按钮`
CLAUDE.md section to the new unified `interactive-card` skill +
`## 交互卡片` section.

What it does per session under sessions/*/:

1. Remove .claude/skills/card-buttons/ (deploySharedSkills will re-sync the new
   redirect-style version + add interactive-card on the next bot startup).
2. Patch CLAUDE.md:
     - If a `## 交互按钮` heading exists, replace that whole section (up to the
       next `## ` heading or EOF) with the new `## 交互卡片` block.
     - Otherwise append the new block at end-of-file (covers sessions that
       never had the legacy section, e.g. sessions older than the original
       BUTTON rollout).

Idempotent: running multiple times leaves the file in the same final state
because step 2 keys off `## 交互按钮` and falls through to append only when no
existing section is found, and step 1 just deletes if present.

Run AFTER bot restart so the new skills/ source is on disk first
(though the script doesn't actually read skills/ — it's fine to run anytime).
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SESSIONS_DIR = PROJECT_ROOT / "sessions"

NEW_SECTION = """## 交互卡片

回复末尾可加交互元素让用户操作。**两种范式互斥**：一个回复只能用一种。

### 模式 A：单维度决策（互斥 N 选 1，立即执行）
用按钮 `<<BUTTON:文案|action_id|样式?>>`（样式 primary/danger 可选，≤4 个）
点击后所有按钮立即禁用，被点的按钮文字会加 `@用户名`。
适用：部署/取消、方案 A/B、是/否、立即执行的单步操作。
示例：`修改完成。<<BUTTON:推送|push|primary>> <<BUTTON:取消|cancel>>`

### 模式 B：多维度决策（独立字段，全部选完再提交）
用选择器 `<<SELECT:placeholder|name|key1=文案1|key2=文案2|...>>`
系统自动追加“提交”按钮。用户全选完点提交后，所有 select 被收敛为只读行，提交按钮文字加 `@用户名`。
适用：建 cron（周期+时间+脚本）、配置邮箱（provider+标签+用途）等多字段表单。
示例：`建定时任务，请配置：<<SELECT:周期|cycle|daily=每天|weekly=每周|monthly=每月>> <<SELECT:时间|time|morning=早 8:00|evening=晚 8:00>>`

### 严禁
- 同一回复混用 BUTTON 和 SELECT（系统会强制丢弃 SELECT）
- 无意义按钮（“OK”“确认”“继续”等）
- SELECT 选项 >7 个（改用文字让用户输入）
- 单维度强行用 SELECT
"""

LEGACY_HEADING_RE = re.compile(
    r"(?:^|\n)##\s*交互按钮[^\n]*\n.*?(?=\n##\s|\Z)",
    re.DOTALL,
)
NEW_HEADING_RE = re.compile(r"(?:^|\n)##\s*交互卡片[^\n]*\n.*?(?=\n##\s|\Z)", re.DOTALL)


def patch_claude_md(path: Path) -> str:
    """Return one of: 'replaced', 'appended', 'already', 'missing'."""
    if not path.exists():
        return "missing"
    text = path.read_text(encoding="utf-8")

    # Already migrated — has the new section, no legacy section.
    has_new = bool(NEW_HEADING_RE.search(text))
    has_legacy = bool(LEGACY_HEADING_RE.search(text))

    if has_legacy:
        # Replace the legacy block (preserve a single leading newline before the new section).
        new_text = LEGACY_HEADING_RE.sub("\n" + NEW_SECTION.rstrip(), text, count=1)
        # If the file now has both new and legacy (shouldn't), fall through.
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
            return "replaced"

    if has_new:
        return "already"

    # No legacy, no new — append at EOF.
    sep = "" if text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
    path.write_text(text + sep + NEW_SECTION, encoding="utf-8")
    return "appended"


def remove_old_skill_dir(session_dir: Path) -> bool:
    skill_dir = session_dir / ".claude" / "skills" / "card-buttons"
    if skill_dir.exists() and skill_dir.is_dir():
        shutil.rmtree(skill_dir)
        return True
    return False


def main() -> None:
    if not SESSIONS_DIR.is_dir():
        print(f"[!] sessions dir not found: {SESSIONS_DIR}")
        return

    sessions = [p for p in SESSIONS_DIR.iterdir() if p.is_dir()]
    print(f"Scanning {len(sessions)} session(s) under {SESSIONS_DIR}\n")

    stats = {
        "sessions": 0,
        "claude_md_replaced": 0,
        "claude_md_appended": 0,
        "claude_md_already": 0,
        "claude_md_missing": 0,
        "old_skill_removed": 0,
    }

    for session in sorted(sessions):
        stats["sessions"] += 1
        claude_md = session / "CLAUDE.md"
        status = patch_claude_md(claude_md)
        stats[f"claude_md_{status}"] += 1

        removed = remove_old_skill_dir(session)
        if removed:
            stats["old_skill_removed"] += 1

        marker = {
            "replaced": "R",
            "appended": "A",
            "already": "=",
            "missing": "?",
        }[status]
        skill_marker = "X" if removed else "."
        print(f"  [{marker}{skill_marker}] {session.name}")

    print("\n=== Summary ===")
    print(f"  sessions scanned         : {stats['sessions']}")
    print(f"  CLAUDE.md replaced       : {stats['claude_md_replaced']}")
    print(f"  CLAUDE.md appended       : {stats['claude_md_appended']}")
    print(f"  CLAUDE.md already done   : {stats['claude_md_already']}")
    print(f"  CLAUDE.md missing        : {stats['claude_md_missing']}")
    print(f"  old card-buttons removed : {stats['old_skill_removed']}")
    print("\nLegend: [R] replaced  [A] appended  [=] already migrated  [?] no CLAUDE.md  trailing X = old skill dir removed")


if __name__ == "__main__":
    main()
