---
name: tunnel
description: >
  远程预览隧道。当用户要求将本地服务暴露到外网、生成预览链接、
  分享开发中的页面时使用。关键词：预览/preview/外网访问/分享链接/tunnel/隧道。
---

# 远程预览隧道

通过内置反向代理将 session 内的本地服务暴露到外网，无需安装任何额外工具。

## 使用方法

### 1. 启动本地服务

在 session 内启动任意 HTTP 服务，记住端口号：

```bash
# 示例：Python HTTP 服务器
python3 -m http.server 8080 &

# 示例：Node.js dev server
npm run dev -- --port 5173 &

# 示例：Vite
npx vite --port 4173 --host 0.0.0.0 &
```

### 2. 注册隧道端口

将服务端口写入 `.tunnel-port` 文件：

```bash
echo "8080" > .tunnel-port
```

### 3. 获取预览链接

注册完成后，预览链接为：

```
{TUNNEL_BASE_URL}/tunnel/{SESSION_KEY}/
```

将此链接发送给用户即可在外网访问。

### 4. 关闭隧道

删除端口文件即可停止隧道：

```bash
rm -f .tunnel-port
```

## 注意事项

- **禁止**自行运行 `cloudflared`、`ngrok` 等隧道工具（会导致主隧道冲突）
- 每个 session 同一时间只能注册一个隧道端口
- 端口必须在 1-65535 范围内
- 确保本地服务监听在 `0.0.0.0` 或 `127.0.0.1` 上
- WebSocket 连接也会被正确代理（支持 HMR）
