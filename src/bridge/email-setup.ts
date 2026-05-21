import type { MessageSender } from '../feishu/message-sender.js';
import { AccountStore, EMAIL_PRESETS, type EmailAccount } from '../email/account-store.js';
import type { SessionManager } from '../claude/session-manager.js';
import type { IdleMonitor } from '../email/idle-monitor.js';
import type { Logger } from '../utils/logger.js';

type SetupStep = 'idle' | 'await_email' | 'await_provider' | 'await_password' | 'await_label' | 'await_custom_imap' | 'await_custom_smtp';

interface SetupState {
  step: SetupStep;
  provider?: string;
  email?: string;
  password?: string;
  label?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

const PROVIDER_GUIDES: Record<string, { name: string; instructions: string }> = {
  gmail: {
    name: 'Gmail',
    instructions: `1️⃣ 开启 Gmail IMAP：
   Gmail 设置 → 转发和 POP/IMAP → 启用 IMAP

2️⃣ 生成应用专用密码：
   https://myaccount.google.com/apppasswords
   选择"邮件" → 生成 16 位密码`,
  },
  outlook: {
    name: 'Outlook / Hotmail',
    instructions: `Outlook 通常已启用 IMAP。

生成应用密码：
   https://account.live.com/proofs/manage/additional
   安全 → 高级安全选项 → 应用密码`,
  },
  qq: {
    name: 'QQ 邮箱',
    instructions: `1️⃣ 登录 QQ 邮箱网页版
2️⃣ 设置 → 账户 → POP3/IMAP/SMTP → 开启 IMAP/SMTP
3️⃣ 按提示用手机发短信获取授权码（即应用密码）`,
  },
  '163': {
    name: '163 邮箱',
    instructions: `1️⃣ 登录 163 邮箱网页版
2️⃣ 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP
3️⃣ 按提示设置客户端授权密码`,
  },
  exmail: {
    name: '企业微信邮箱',
    instructions: `1️⃣ 登录企业微信邮箱
2️⃣ 设置 → 客户端设置 → 开启 IMAP
3️⃣ 生成客户端专用密码`,
  },
  feishu: {
    name: '飞书企业邮箱',
    instructions: `1️⃣ 打开飞书客户端 → 设置 → 邮箱
2️⃣ 找到「第三方邮箱客户端登录」→ 点击「立即设置」
3️⃣ 生成密码，复制保存好`,
  },
};

/**
 * Manages interactive email account setup via Feishu chat.
 */
export class EmailSetup {
  private states = new Map<string, SetupState>();
  private idleMonitor: IdleMonitor | null = null;

  constructor(
    private sender: MessageSender,
    private sessionMgr: SessionManager,
    private logger: Logger,
  ) {}

  setIdleMonitor(monitor: IdleMonitor): void {
    this.idleMonitor = monitor;
  }

  /**
   * Check if there's an active setup for this session.
   */
  isActive(sessionKey: string): boolean {
    const state = this.states.get(sessionKey);
    return !!state && state.step !== 'idle';
  }

  /**
   * Start the email setup flow.
   * Returns true if started, false if already in progress.
   *
   * @param hint - Provider hint (e.g. "gmail", "飞书")
   * @param email - Pre-filled email address from natural language detection
   */
  async start(sessionKey: string, chatId: string, messageId: string, hint?: string, email?: string): Promise<boolean> {
    if (this.isActive(sessionKey)) {
      await this.sender.sendText(chatId, '⚠️ 邮箱配置正在进行中。发送 "取消" 可取消当前配置。', messageId);
      return false;
    }

    // Try to detect provider from hint
    const provider = this.detectProvider(hint || '');

    // If email address is provided, skip directly to password step
    if (email) {
      const detectedProvider = provider || this.detectProviderFromEmail(email);
      if (detectedProvider && EMAIL_PRESETS[detectedProvider]) {
        const guide = PROVIDER_GUIDES[detectedProvider];
        this.states.set(sessionKey, { step: 'await_password', provider: detectedProvider, email });
        await this.sender.sendReply(chatId, [
          `📧 收到邮箱 ${email}，识别为${guide?.name || detectedProvider}。`,
          '',
          ...(guide ? [guide.instructions, ''] : []),
          '请发送应用专用密码（授权码）：',
        ].join('\n'), messageId);
      } else {
        // Unknown provider, ask user to select
        this.states.set(sessionKey, { step: 'await_provider', email });
        await this.sender.sendReply(chatId, [
          `📧 收到邮箱 ${email}`,
          '',
          '请问这是哪种邮箱？回复对应数字：',
          '1. 飞书企业邮箱',
          '2. Gmail',
          '3. Outlook / Hotmail',
          '4. QQ 邮箱',
          '5. 163 邮箱',
          '6. 企业微信邮箱',
          '7. 其他（需手动配置服务器）',
        ].join('\n'), messageId);
      }
      return true;
    }

    if (provider && PROVIDER_GUIDES[provider]) {
      const guide = PROVIDER_GUIDES[provider];
      this.states.set(sessionKey, { step: 'await_email', provider });

      await this.sender.sendReply(chatId, [
        `📧 开始配置 ${guide.name}！`,
        '',
        guide.instructions,
        '',
        '准备好后，请发送你的邮箱地址：',
      ].join('\n'), messageId);
    } else if (provider === 'custom') {
      this.states.set(sessionKey, { step: 'await_custom_imap' });
      await this.sender.sendReply(chatId, [
        '📧 自定义邮箱配置',
        '',
        '请发送 IMAP 服务器信息，格式：',
        '`imap.example.com:993`',
      ].join('\n'), messageId);
    } else {
      // No provider hint — ask for email address directly
      this.states.set(sessionKey, { step: 'await_email' });
      await this.sender.sendReply(chatId, [
        '📧 绑定邮箱',
        '',
        '请直接发送你的邮箱地址（如 name@company.com），我会自动识别邮箱类型。',
      ].join('\n'), messageId);
    }

    return true;
  }

  /**
   * Detect provider from email domain.
   */
  private detectProviderFromEmail(email: string): string | undefined {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return undefined;
    if (domain.includes('gmail')) return 'gmail';
    if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live.com')) return 'outlook';
    if (domain.includes('qq.com')) return 'qq';
    if (domain.includes('163.com')) return '163';
    if (domain.includes('exmail')) return 'exmail';
    // Feishu enterprise emails use imap.feishu.cn but have custom domains
    // Check if EMAIL_PRESETS has feishu and the domain might be a feishu-hosted custom domain
    if (domain.includes('feishu') || domain.includes('lark')) return 'feishu';
    return undefined;
  }

  /**
   * Handle a message during active setup.
   * Returns true if the message was consumed by the setup flow.
   */
  async handleMessage(sessionKey: string, chatId: string, messageId: string, text: string): Promise<boolean> {
    const state = this.states.get(sessionKey);
    if (!state || state.step === 'idle') return false;

    const input = text.trim();

    // Cancel at any point
    if (input.toLowerCase() === 'cancel' || input === '取消') {
      this.states.delete(sessionKey);
      await this.sender.sendText(chatId, '❌ 邮箱配置已取消', messageId);
      return true;
    }

    switch (state.step) {
      case 'await_email':
        return this.handleEmailInput(sessionKey, chatId, messageId, input, state);

      case 'await_provider':
        return this.handleProviderSelect(sessionKey, chatId, messageId, input, state);

      case 'await_password':
        return this.handlePasswordInput(sessionKey, chatId, messageId, input, state);

      case 'await_label':
        return this.handleLabelInput(sessionKey, chatId, messageId, input, state);

      case 'await_custom_imap':
        return this.handleCustomImapInput(sessionKey, chatId, messageId, input, state);

      case 'await_custom_smtp':
        return this.handleCustomSmtpInput(sessionKey, chatId, messageId, input, state);

      default:
        return false;
    }
  }

  private async handleEmailInput(
    sessionKey: string, chatId: string, messageId: string, input: string, state: SetupState,
  ): Promise<boolean> {
    // Check if user is selecting a provider
    const providerKey = input.toLowerCase();
    if (PROVIDER_GUIDES[providerKey]) {
      state.provider = providerKey;
      const guide = PROVIDER_GUIDES[providerKey];
      await this.sender.sendReply(chatId, [
        `📧 配置 ${guide.name}`,
        '',
        guide.instructions,
        '',
        '准备好后，请发送你的邮箱地址：',
      ].join('\n'), messageId);
      return true;
    }

    if (providerKey === 'other' || providerKey === '其他') {
      state.step = 'await_custom_imap';
      await this.sender.sendReply(chatId, [
        '📧 自定义邮箱配置',
        '',
        '请发送 IMAP 服务器信息，格式：',
        '`imap.example.com:993`',
      ].join('\n'), messageId);
      return true;
    }

    // Validate email
    if (!input.includes('@')) {
      await this.sender.sendText(chatId, '⚠️ 请输入有效的邮箱地址（如 user@gmail.com）', messageId);
      return true;
    }

    state.email = input;

    // Auto-detect provider from email domain
    if (!state.provider) {
      const domain = input.split('@')[1]?.toLowerCase();
      if (domain?.includes('gmail')) state.provider = 'gmail';
      else if (domain?.includes('outlook') || domain?.includes('hotmail') || domain?.includes('live.com')) state.provider = 'outlook';
      else if (domain?.includes('qq.com')) state.provider = 'qq';
      else if (domain?.includes('163.com')) state.provider = '163';
      else if (domain?.includes('exmail')) state.provider = 'exmail';
    }

    // If provider unknown, ask user to select
    if (!state.provider || !EMAIL_PRESETS[state.provider]) {
      state.step = 'await_provider';
      await this.sender.sendReply(chatId, [
        `收到邮箱: ${input}`,
        '',
        '请问这是哪种邮箱？回复对应数字：',
        '1. 飞书企业邮箱',
        '2. Gmail',
        '3. Outlook / Hotmail',
        '4. QQ 邮箱',
        '5. 163 邮箱',
        '6. 企业微信邮箱',
        '7. 其他（需手动配置服务器）',
      ].join('\n'), messageId);
      return true;
    }

    state.step = 'await_password';
    await this.sender.sendText(chatId, `收到！请发送应用专用密码（授权码）：`, messageId);
    return true;
  }

  private async handleProviderSelect(
    sessionKey: string, chatId: string, messageId: string, input: string, state: SetupState,
  ): Promise<boolean> {
    const PROVIDER_MAP: Record<string, string> = {
      '1': 'feishu', '飞书': 'feishu', 'feishu': 'feishu', 'lark': 'feishu', '飞书企业邮箱': 'feishu',
      '2': 'gmail', 'gmail': 'gmail',
      '3': 'outlook', 'outlook': 'outlook', 'hotmail': 'outlook',
      '4': 'qq', 'qq': 'qq', 'qq邮箱': 'qq',
      '5': '163', '163': '163', '网易': '163',
      '6': 'exmail', 'exmail': 'exmail', '企业微信': 'exmail',
      '7': 'other', '其他': 'other', 'other': 'other',
    };

    const key = input.toLowerCase().trim();
    const provider = PROVIDER_MAP[key];

    if (!provider) {
      await this.sender.sendText(chatId, '请回复 1-7 的数字选择邮箱类型', messageId);
      return true;
    }

    if (provider === 'other') {
      state.step = 'await_custom_imap';
      await this.sender.sendReply(chatId, [
        '请发送 IMAP 服务器信息，格式：',
        '`imap.example.com:993`',
      ].join('\n'), messageId);
      return true;
    }

    state.provider = provider;
    const guide = PROVIDER_GUIDES[provider];
    state.step = 'await_password';
    await this.sender.sendReply(chatId, [
      ...(guide ? [guide.instructions, ''] : []),
      '请发送应用专用密码（授权码）：',
    ].join('\n'), messageId);
    return true;
  }

  private async handlePasswordInput(
    sessionKey: string, chatId: string, messageId: string, input: string, state: SetupState,
  ): Promise<boolean> {
    state.password = input.replace(/\s/g, ''); // Strip spaces from app passwords

    await this.sender.sendText(chatId, '🔄 正在测试连接...', messageId);

    // Build account and test
    const account = this.buildAccount(state);
    if (!account) {
      await this.sender.sendText(chatId, '❌ 配置信息不完整，请重新开始', messageId);
      this.states.delete(sessionKey);
      return true;
    }

    const result = await AccountStore.test(account);

    if (!result.imap && !result.smtp) {
      await this.sender.sendReply(chatId, [
        '❌ 连接失败：',
        `- IMAP: ${result.imapError || '未知错误'}`,
        `- SMTP: ${result.smtpError || '未知错误'}`,
        '',
        '请检查密码是否正确，或发送 "cancel" 取消重来。',
        '重新发送密码即可重试：',
      ].join('\n'), messageId);
      return true;
    }

    const statusLines = [];
    if (result.imap) statusLines.push('✅ IMAP 连接成功');
    else statusLines.push(`⚠️ IMAP 失败: ${result.imapError}`);
    if (result.smtp) statusLines.push('✅ SMTP 连接成功');
    else statusLines.push(`⚠️ SMTP 失败: ${result.smtpError}`);

    state.step = 'await_label';
    await this.sender.sendReply(chatId, [
      ...statusLines,
      '',
      `给这个邮箱取个名字？（如"工作邮箱"、"个人Gmail"）`,
      `或直接回复 ok 使用默认名 "${account.id}"`,
    ].join('\n'), messageId);
    return true;
  }

  private async handleLabelInput(
    sessionKey: string, chatId: string, messageId: string, input: string, state: SetupState,
  ): Promise<boolean> {
    const account = this.buildAccount(state);
    if (!account) {
      await this.sender.sendText(chatId, '❌ 配置信息不完整', messageId);
      this.states.delete(sessionKey);
      return true;
    }

    if (input.toLowerCase() !== 'ok') {
      account.label = input;
    }

    // Save account
    const session = this.sessionMgr.get(sessionKey);
    if (!session) {
      await this.sender.sendText(chatId, '❌ 会话不存在', messageId);
      this.states.delete(sessionKey);
      return true;
    }

    AccountStore.add(session.sessionDir, account);
    AccountStore.savePushTarget(session.sessionDir, chatId);
    this.states.delete(sessionKey);

    // Force MCP manager to re-deploy (will generate email-cli.sh and skill)
    this.sessionMgr.getOrCreate(sessionKey);

    // Notify IDLE monitor to start watching this account
    if (this.idleMonitor && account.pushEnabled) {
      this.idleMonitor.startAccount(sessionKey, chatId, account).catch(err => {
        this.logger.warn({ err, accountId: account.id }, 'Failed to start IDLE monitor for new account');
      });
    }

    await this.sender.sendReply(chatId, [
      `🎉 邮箱配置完成！`,
      '',
      `- 账号ID: \`${account.id}\``,
      `- 名称: ${account.label}`,
      `- 地址: ${account.imap.user}`,
      '',
      `现在可以对我说"查看邮件"、"搜索来自XX的邮件"、"发邮件给XX"等。`,
    ].join('\n'), messageId);

    this.logger.info({ sessionKey, accountId: account.id }, 'Email account added');
    return true;
  }

  private async handleCustomImapInput(
    sessionKey: string, chatId: string, messageId: string, input: string, state: SetupState,
  ): Promise<boolean> {
    const match = input.match(/^([^:]+):(\d+)$/);
    if (!match) {
      await this.sender.sendText(chatId, '⚠️ 格式不对，请使用 `host:port` 格式，如 `imap.example.com:993`', messageId);
      return true;
    }

    state.imapHost = match[1];
    state.imapPort = parseInt(match[2]);
    state.step = 'await_custom_smtp';

    await this.sender.sendReply(chatId, [
      `IMAP: ${state.imapHost}:${state.imapPort} ✓`,
      '',
      '请发送 SMTP 服务器信息：',
      '`smtp.example.com:587`',
    ].join('\n'), messageId);
    return true;
  }

  private async handleCustomSmtpInput(
    sessionKey: string, chatId: string, messageId: string, input: string, state: SetupState,
  ): Promise<boolean> {
    const match = input.match(/^([^:]+):(\d+)$/);
    if (!match) {
      await this.sender.sendText(chatId, '⚠️ 格式不对，请使用 `host:port` 格式，如 `smtp.example.com:587`', messageId);
      return true;
    }

    state.smtpHost = match[1];
    state.smtpPort = parseInt(match[2]);
    state.provider = 'custom';

    if (!state.email) {
      state.step = 'await_email';
      await this.sender.sendText(chatId, 'SMTP 已记录。请发送你的邮箱地址：', messageId);
    } else {
      state.step = 'await_password';
      await this.sender.sendText(chatId, 'SMTP 已记录。请发送应用密码（授权码）：', messageId);
    }
    return true;
  }

  private buildAccount(state: SetupState): EmailAccount | null {
    if (!state.email || !state.password) return null;

    let imapHost: string, imapPort: number, imapTls: boolean;
    let smtpHost: string, smtpPort: number, smtpTls: boolean;

    if (state.provider && EMAIL_PRESETS[state.provider]) {
      const preset = EMAIL_PRESETS[state.provider];
      imapHost = preset.imap.host;
      imapPort = preset.imap.port;
      imapTls = preset.imap.tls;
      smtpHost = preset.smtp.host;
      smtpPort = preset.smtp.port;
      smtpTls = preset.smtp.tls;
    } else if (state.imapHost && state.smtpHost) {
      imapHost = state.imapHost;
      imapPort = state.imapPort || 993;
      imapTls = imapPort === 993;
      smtpHost = state.smtpHost;
      smtpPort = state.smtpPort || 587;
      smtpTls = smtpPort === 465;
    } else {
      return null;
    }

    // Generate account ID from email
    const id = state.provider && state.provider !== 'custom'
      ? state.provider
      : state.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');

    return {
      id,
      label: state.label || `${state.provider || 'email'} (${state.email})`,
      imap: { host: imapHost, port: imapPort, user: state.email, pass: state.password, tls: imapTls },
      smtp: { host: smtpHost, port: smtpPort, user: state.email, pass: state.password, tls: smtpTls },
      pushEnabled: true,
    };
  }

  private detectProvider(hint: string): string | undefined {
    const h = hint.toLowerCase();
    if (h.includes('gmail') || h.includes('谷歌')) return 'gmail';
    if (h.includes('outlook') || h.includes('hotmail')) return 'outlook';
    if (h.includes('qq邮箱') || h.includes('qq 邮箱') || h.includes('qq mail')) return 'qq';
    if (h.includes('163') || h.includes('网易')) return '163';
    if (h.includes('企业微信') || h.includes('exmail')) return 'exmail';
    if (h.includes('飞书') || h.includes('feishu') || h.includes('lark')) return 'feishu';
    if (h.includes('其他') || h.includes('other') || h.includes('自定义') || h.includes('custom')) return 'custom';
    return undefined;
  }

  /**
   * Cancel any active setup for a session.
   */
  cancel(sessionKey: string): void {
    this.states.delete(sessionKey);
  }
}
