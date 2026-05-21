# 视频/播客

YouTube、B站、小宇宙播客的字幕和转录。

## YouTube (yt-dlp)

### 获取视频元数据

```bash
yt-dlp --dump-json "URL"
```

### 下载字幕

```bash
# 下载字幕 (不下载视频)
yt-dlp --write-sub --write-auto-sub --sub-lang "zh-Hans,zh,en" --skip-download -o "/tmp/%(id)s" "URL"

# 然后读取 .vtt 文件
cat /tmp/VIDEO_ID.*.vtt
```

### 获取评论

```bash
# 提取评论（best-effort，不保证完整）
yt-dlp --write-comments --skip-download --write-info-json \
  --extractor-args "youtube:max_comments=20" \
  -o "/tmp/%(id)s" "URL"
# 评论在 .info.json 的 comments 字段中
```

### 搜索视频

```bash
yt-dlp --dump-json "ytsearch5:query"
```

> **字幕注意**: 手动上传的字幕提取可靠；自动生成字幕可能存在行间重复，需后处理。
> **评论注意**: `--write-comments` 基于网页抓取（非 YouTube Data API），部分评论可能丢失。

## B站 / Bilibili (yt-dlp + bili-cli)

### 视频元数据 (yt-dlp)

```bash
yt-dlp --dump-json "https://www.bilibili.com/video/BVxxx"
```

### 字幕 (yt-dlp)

```bash
yt-dlp --write-sub --write-auto-sub --sub-lang "zh-Hans,zh,en" --convert-subs vtt --skip-download -o "/tmp/%(id)s" "URL"
```

### 搜索/热门/排行 (bili-cli)

```bash
# 搜索视频
bili search "query" --type video -n 5

# 热门视频
bili hot -n 10

# 排行榜
bili rank -n 10
```

> **412 风控**: 海外 IP 必须提供 Cookie（`--cookies-from-browser chrome` 或 `--cookies /path/to/cookies.txt`），国内 IP 一般不受影响。
> **安装 bili-cli**: `pipx install bilibili-cli`，然后 `bili login` 扫码登录。

### 视频转写（自动字幕优先 / 无字幕走 ASR）

B 站绝大多数视频没有官方字幕，需要走音频转写路径。一键脚本会先查官方字幕，没有再下音频用 Groq Whisper 转写。两条路径输出**完全相同**的格式，下游总结时无需区分。

```bash
bash .claude/skills/agent-reach/scripts/bili-transcribe.sh "https://www.bilibili.com/video/BVxxx"
# stdout: /tmp/{BV}.md 路径，含 [hh:mm:ss] 文本 + 元数据头
```

#### 前置（每个 session 一次）

```bash
# 1. 系统依赖（机器级，一次）
brew install ffmpeg
pip3 install --user bilix

# 2. 注册并拿到自己的 Groq Key（免费）
#    https://console.groq.com/keys

# 3. 写入本 session 的 .env（key 不入库，每个 session 独立）
SCRIPT_DIR=$(pwd)/.claude/skills/agent-reach/scripts
mkdir -p "$SCRIPT_DIR"
echo "GROQ_API_KEY=gsk_xxx" > "$SCRIPT_DIR/.env"
chmod 600 "$SCRIPT_DIR/.env"
```

> **重要**：`.env` 文件**永远不要提交到 git**（项目根 `.gitignore` 已覆盖 `.env`）。每个 session 的 key 各自管理，不共享。

#### 退出码

| code | 含义 |
|------|------|
| 0 | 成功 |
| 1 | URL 不是合法 B 站链接 |
| 2 | GROQ_API_KEY 未设 |
| 3 | Groq 转写失败 |
| 4 | 视频时长 > 3600s |
| 5 | ffmpeg / bilix 未安装 |
| 6 | 网络 / B 站 API 错误 |

#### 限制

- **时长上限 3600s**：>1 小时直接拒绝（避免 Groq 25MB 单文件上限和成本失控）
- **中文 CER**：Whisper-large-v3 约 8-12%，专有名词偏低
- **B 站 412 风控**：bilix 已封装 WBI 签名，**不要**用 yt-dlp 下流

## 小宇宙播客 / Xiaoyuzhou Podcast

### 转录单集播客

```bash
# 输出 Markdown 文件到 /tmp/
~/.agent-reach/tools/xiaoyuzhou/transcribe.sh "https://www.xiaoyuzhoufm.com/episode/EPISODE_ID"
```

### 前置要求

1. **ffmpeg**: `brew install ffmpeg`
2. **Groq API Key** (免费): https://console.groq.com/keys
3. **配置 Key**: `agent-reach configure groq-key YOUR_KEY`
4. **首次运行**: `agent-reach install --env=auto` 安装工具

### 检查状态

```bash
agent-reach doctor
```

> 输出 Markdown 文件默认保存到 `/tmp/`。

## 抖音视频解析

```bash
# 解析视频信息
mcporter call 'douyin.parse_douyin_video_info(share_link: "https://v.douyin.com/xxx/")'

# 获取无水印下载链接
mcporter call 'douyin.get_douyin_download_link(share_link: "https://v.douyin.com/xxx/")'
```

> 详见 [social.md](social.md#抖音--douyin)

## 选择指南

| 场景 | 推荐工具 |
|-----|---------|
| YouTube 字幕 | yt-dlp |
| B站字幕 | yt-dlp |
| 播客转录 | 小宇宙 transcribe.sh |
| 抖音视频解析 | douyin MCP |
