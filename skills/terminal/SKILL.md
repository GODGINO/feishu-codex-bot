---
name: terminal
description: 用户本地操作指南 — 通过 Sigma Terminal 在用户 Mac 上执行命令、编辑代码、控制屏幕，并通过 ADB 操作连接的 Android 手机
---

# 用户本地操作

你可以通过 `remote-terminal` MCP 工具在用户的 Mac 上做三类事情：

1. **Code Use** — 执行命令、读写文件、编辑代码（远程 Claude Code 体验）
2. **Computer Use** — 截屏、点击、键盘、拖拽，控制 macOS GUI
3. **Phone Use** — 通过 ADB 操作连接到用户 Mac 的 Android 手机

**Sigma Terminal 是一个独立的 macOS 菜单栏应用（.app），不是 VS Code 插件，不是浏览器扩展。**

**仅当用户在当前消息中明确要求操作"我的电脑"/"本地"/"我的机器"/"我的手机"时使用** `remote-terminal` MCP。

## 首次使用：引导安装 Sigma Terminal

**第一步：调用 `system_info` 检查连接**

如果返回系统信息（os、arch 等），说明已连接，直接执行用户请求。

如果返回错误 "Extension not connected"，需要引导安装：

**第二步：发送安装指南**

根据 system_info 返回的 os 字段判断用户系统（darwin = macOS, win32 = Windows），发送对应安装指南。如果不确定，两个链接都发。

> **安装 Sigma Terminal：**
>
> **macOS 用户：**
> 1. 下载：`<SIGMA_SERVER>/download/sigma-terminal.dmg`（替换 `<SIGMA_SERVER>` 为实际部署地址）
> 2. 打开 DMG，将 Sigma Terminal 拖入「应用程序」文件夹
> 3. 首次启动前，打开「终端」执行：`sudo xattr -r -d com.apple.quarantine /Applications/Sigma\ Terminal.app`
> 4. 启动 Sigma Terminal → 菜单栏出现 Sigma 图标
>
> **Windows 用户：**
> 1. 下载：`<SIGMA_SERVER>/download/sigma-terminal-win.zip`（替换 `<SIGMA_SERVER>` 为实际部署地址）
> 2. 解压 zip 文件到任意目录（如桌面或 C:\Program Files\）
> 3. 打开解压后的 `win-unpacked` 文件夹，运行 `Sigma Terminal.exe`（如弹出 SmartScreen「Windows 已保护你的电脑」，点击「更多信息」→「仍要运行」）
> 4. 系统托盘出现 Sigma 图标
>
> 点击图标，输入会话 Key：`{SESSION_KEY}`，点 Add → Connect → 绿灯即连接成功。
>
> 连接成功后回复我，我就可以在你的电脑上执行命令、控制屏幕、操作手机了。

## 工具优先级（从高到低）

按精确度优先选择工具，**避免直接用截图 + 鼠标操作能用其他方式做的事**：

1. **shell_exec / file_*** — 命令行能搞定的事（编程、文件操作、git 等）
2. **app_launch / open** — 启动应用
3. **app_focus / window_resize** — 高层窗口控制
4. **screenshot + mouse_click + keyboard_type** — GUI 操作（仅当无 CLI 替代时使用）

> 屏幕控制（screenshot/mouse/keyboard）成本最高、可靠性最低。
> 只在必要时用：测试 macOS 原生应用、调试 UI 布局、操作没有 API 的 GUI 应用、iOS Simulator 等。

## 工具列表

### Code Use 工具

- `shell_exec` — 执行 shell 命令
- `file_read` — 读取文件（带行号），支持 offset/limit 分段
- `file_write` — 创建或覆盖文件
- `file_edit` — 精确字符串替换（old_string → new_string）
- `glob` — 按文件名模式搜索
- `grep` — 按内容正则搜索
- `system_info` — 系统信息（含权限和 ADB 状态）
- `open` — 打开 URL/文件/应用
- `notify` — 发送 macOS 通知

### Computer Use 工具（Mac GUI 控制）

- `screenshot` — 截屏，返回 base64 PNG
- `display_info` — 多显示器信息
- `mouse_move` / `mouse_click` / `mouse_drag` / `mouse_scroll` / `mouse_position` — 鼠标
- `keyboard_type` — 输入文本
- `keyboard_key` — 按键/组合键（如 `cmd+c`、`Return`）
- `app_launch` / `app_list_running` / `app_focus` / `app_quit` — 应用管理
- `window_list` / `window_resize` — 窗口管理

**Computer Use 工作流**：
1. 先 `screenshot` 看屏幕
2. 视觉理解后用 `mouse_click(x, y)` 点击
3. 操作后再次截图验证
4. 用户按 ESC 可随时中止控制

**首次使用时**：检查 `system_info` 返回的 `computerUse.accessibilityGranted` 和 `screenRecordingGranted`，如果是 false，告知用户：
> 请到「系统设置 → 隐私与安全 → 辅助功能」和「屏幕录制」中授权 Sigma Terminal。

### Phone Use 工具（Android 设备控制）

- `adb_devices` — 列出连接的设备（**总是先调用这个**）
- `adb_device_info` — 设备详细信息
- `adb_screenshot` — 设备截屏（用 exec-out，二进制安全）
- `adb_screen_size` — 屏幕分辨率
- `adb_record_screen` — 录屏
- `adb_tap` — 点击坐标
- `adb_swipe` — 滑动/拖拽
- `adb_long_press` — 长按
- `adb_text` — 输入文字
- `adb_keyevent` — 按键（home/back/menu/enter 等）
- `adb_install` — 安装 APK
- `adb_app_list` — 已安装应用列表
- `adb_app_launch` — 启动应用
- `adb_app_force_stop` — 强制停止应用

**Phone Use 工作流**：
1. 先 `adb_devices` 确认设备已连接
2. `adb_screenshot` 看当前屏幕
3. 视觉理解后用 `adb_tap` / `adb_swipe` 操作
4. 操作后再截图验证

**首次使用时**：
- 如果 `system_info` 返回 `phoneUse.adbInstalled` 为 false：
  > 请安装 ADB：`brew install android-platform-tools`
- 如果 `adb_devices` 返回空：
  > 请确认：1) USB 线已连接 2) 手机已开启「开发者选项 → USB 调试」 3) 手机上点了"信任此电脑"

## 故障排除

- "Extension not connected" → 用户未连接 Sigma Terminal，重新引导安装
- 截图返回错误 "Screenshot too small" → 设备屏幕已锁定，提醒解锁
- "adb not found" → 提醒用户安装 `brew install android-platform-tools`
- 用户按了 ESC → 收到 "Operation aborted by user" 错误，停止操作并等待新指令

## 判断规则

| 用户说的话 | 使用 |
|-----------|------|
| "帮我看看我电脑上的 xxx" | shell_exec / file_read |
| "在我机器上运行 xxx" | shell_exec |
| "帮我改一下本地的代码" | file_edit |
| "看看我屏幕现在是什么" | screenshot |
| "帮我点一下屏幕中间" | mouse_click |
| "拖一下文件到桌面" | mouse_drag |
| "帮我打开 Safari" | app_launch |
| "看看我手机连上了吗" | adb_devices |
| "看看我手机现在是什么界面" | adb_screenshot |
| "帮我点一下手机屏幕的按钮" | adb_tap |
| "在手机上滑动" | adb_swipe |
| "把这个 APK 装到我手机上" | adb_install |
| （未提及"我的电脑"/"本地"/"我的手机"）| 不使用 |
