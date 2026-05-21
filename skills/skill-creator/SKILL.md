---
name: skill-creator
description: 创建、修改和管理 Claude Code skills。当用户想要创建新技能、自定义 bot 行为、添加新能力、自动化工作流程时使用。关键词：创建skill、添加技能、自定义能力、自动化、工作流、skill。即使用户没有明确说"skill"，只要他们想让 bot 学会新的固定流程或行为模式，就应该使用此技能。
---

# Skill Creator

创建和管理当前 session 的 Claude Code skills。Skills 是打包的能力模块，让 bot 掌握特定的行为、工作流或领域知识。

## 什么是 Skill

一个 skill 就是一个 `SKILL.md` 文件，放在 `.claude/skills/<skill-name>/SKILL.md`。它包含：

1. **YAML frontmatter**：name 和 description（决定何时触发）
2. **Markdown 正文**：详细的指令、步骤、示例

Claude Code 会在 `available_skills` 列表中看到所有 skills 的 name + description，当用户请求匹配时自动加载完整 SKILL.md 并按指令执行。

## 创建 Skill 的流程

### 1. 理解意图

先搞清楚用户想要什么：

- 这个 skill 让 bot 做什么？
- 什么时候应该触发？（什么话题、关键词、场景）
- 期望的输出格式是什么？
- 需要用到哪些工具？（Bash、WebSearch、Chrome、MCP 工具等）

### 2. 编写 SKILL.md

```markdown
---
name: my-skill
description: 简短但全面的描述——包含做什么、何时触发。描述要稍微"激进"一点，确保相关场景都能触发。
---

# Skill 标题

## 核心指令
清晰的步骤说明...

## 输出格式
期望的输出结构...

## 示例
Input: ...
Output: ...
```

**编写要点：**
- `description` 是触发机制——写清楚"做什么"和"什么时候用"
- description 要覆盖用户可能的各种说法，不只是一种表述
- 正文用祈使句（"搜索..."，"打开..."），解释 why 而非堆砌 MUST
- 保持 SKILL.md 在 500 行以内
- 包含具体示例帮助模型理解期望行为

### 3. 保存 Skill

**⚠️ Write/Edit 工具对 `.claude/skills/` 无效（系统限制），必须用 Bash 命令写入。**

使用绝对路径 + `tee` 写文件，分两步：

```bash
# 第一步：创建目录
mkdir -p /绝对路径/.claude/skills/<skill-name>/

# 第二步：写入文件
tee /绝对路径/.claude/skills/<skill-name>/SKILL.md > /dev/null << 'EOF'
---
name: my-skill
description: ...
---

# Skill 内容...
EOF
```

**注意事项：**
- **永远用绝对路径**：`cd` 后相对路径会指向错误位置，用 `$(pwd)` 或写死绝对路径
- **mkdir 和写文件分两步**：先确认目录创建成功再写文件
- **禁止使用 symlink**：必须创建真实文件，系统会自动检测并修复 symlink

如果 skill 需要辅助脚本，放在同级目录：

```
.claude/skills/<skill-name>/
├── SKILL.md
└── scripts/
    └── helper.sh
```

### 4. 测试

创建后直接在当前对话中测试——用几个典型的用户输入验证 skill 是否正确触发和执行。根据结果迭代改进。

## 管理 Skills

### 查看当前 skills

```bash
ls -la .claude/skills/
```

### 修改 skill

用 Bash 命令重写对应的 SKILL.md 文件（Write/Edit 工具不可用）。改完后下次触发即生效（无需重启）。

### 删除 skill

```bash
rm -rf .claude/skills/<skill-name>
```

## 环境变量（重要）

Skill 中涉及的 API Key、Secret、Token 等敏感信息**必须**使用环境变量，**禁止**硬编码在 SKILL.md 或脚本文件中，也**禁止**将 `.env` 文件放在 skill 文件夹内。

### 存放位置

环境变量统一存放在 session 根目录的 `session.env` 文件（**不是** skill 文件夹内）：

```bash
# session.env（位于 $SESSION_DIR/session.env）
MY_API_KEY=sk-xxxxx
PLUGIN_SECRET=yyyyy
```

用 Edit 或 Write 工具写入 `session.env`（注意追加而非覆盖已有变量）。

### 在脚本中使用

脚本直接用 `$VAR_NAME` 引用即可，Claude 进程启动时会自动加载 session.env 中的所有变量：

```bash
curl -H "Authorization: Bearer $MY_API_KEY" https://api.example.com
```

### 为什么不放在 skill 文件夹里

- Skill 可能被迁移到其他 session，迁移时**不会**复制 `.env` 文件
- 不同 session 可能需要不同的 key（不同用户、不同环境）
- `session.env` 集中管理，可在 admin 后台查看和修改

### 创建 skill 时的检查清单

1. 脚本中是否有硬编码的 key/secret？→ 改为环境变量
2. 环境变量是否写入了 `session.env`（而非 skill 目录）？
3. SKILL.md 中是否说明了需要哪些环境变量？

## 注意事项

- Skills 存在于当前 session 目录，不影响其他用户
- 创建的 skill 在 `/new` 重置会话后仍然保留（因为 session 目录不变）
- skill 内可以使用当前 session 的所有工具（Bash、Chrome、MCP 工具等）
- 避免在 skill 中硬编码路径或密钥——用环境变量（见上方）
- 如果 skill 需要调用外部 API，在 SKILL.md 中说明需要的环境变量
- **禁止使用 symlink**：所有 skill 文件必须直接写在 `.claude/skills/<name>/` 下，不要创建中间目录（如 `.agents/`）再 symlink
- **禁止写入 session 外部**：不要向 feishu-claude-bot 源码目录或其他 session 目录写入任何文件
