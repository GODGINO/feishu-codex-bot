import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { createFeishuClients } from './feishu/client.js';
import { createEventHandler } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { TypingIndicator } from './feishu/typing.js';
import { ClaudeRunner } from './claude/runner.js';
import { SessionManager } from './claude/session-manager.js';
import { MessageBridge } from './bridge/message-bridge.js';
import { FORM_SUBMIT_ACTION } from './feishu/card-builder.js';
import { CronRunner } from './scheduler/cron-runner.js';
import { AlertRunner } from './scheduler/alert-runner.js';
import { ChromeIdleChecker } from './local-only/chrome/idle-checker.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { IdleMonitor } from './email/idle-monitor.js';
import { EmailProcessor } from './email/email-processor.js';
import { startAdminServer } from './admin/server.js';
import { WechatBridge } from './wechat/wechat-bridge.js';

/**
 * Ensure only one bot instance runs at a time.
 * 1. Kill previous PID from PID file
 * 2. pgrep to kill ALL orphan bot processes (any start method)
 * 3. Write current PID
 * 4. Start a background watchdog that periodically checks for rogue duplicates
 */
function ensureSingleInstance(pidPath: string, logger: ReturnType<typeof createLogger>): void {
  // Kill previous PID file holder
  try {
    const oldPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        logger.info({ oldPid }, 'Killed previous bot process via PID file');
      } catch { /* already gone */ }
    }
  } catch { /* no PID file */ }

  // Kill ALL orphan bot processes regardless of how they were started
  killOrphanProcesses(logger);

  // Claim PID
  fs.writeFileSync(pidPath, String(process.pid));
}

function killOrphanProcesses(logger: ReturnType<typeof createLogger>): void {
  for (const pattern of ['node dist/index.js', 'tsx src/index.ts', 'tsx watch src/index.ts']) {
    try {
      const output = execSync(`pgrep -f "${pattern}"`, { encoding: 'utf-8' }).trim();
      const pids = output.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => p && p !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
          logger.info({ pid, pattern }, 'Killed orphan bot process');
        } catch { /* already gone */ }
      }
    } catch { /* pgrep exits 1 when no matches */ }
  }
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const PID_FILE = path.join(path.dirname(config.sessionsDir), '.bot.pid');
  ensureSingleInstance(PID_FILE, logger);

  // Watchdog: periodically check for rogue duplicate processes (every 60s)
  setInterval(() => {
    killOrphanProcesses(logger);
  }, 60_000);

  logger.info('Starting Feishu Claude Bot...');

  // Create Feishu clients
  const { client, wsClient } = createFeishuClients(
    config.feishu.appId,
    config.feishu.appSecret,
    logger,
  );

  // Get bot's own open_id for @mention detection in groups
  let botOpenId = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      const respData = resp as any;
      botOpenId = respData?.data?.bot?.open_id || respData?.bot?.open_id || '';
      if (botOpenId) {
        logger.info({ botOpenId }, 'Bot info retrieved');
        break;
      }
      logger.warn({ attempt }, 'Bot info response missing open_id, retrying...');
    } catch (err) {
      logger.warn({ err, attempt }, 'Failed to get bot info, retrying...');
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  if (!botOpenId) {
    logger.error('Could not get botOpenId after 3 attempts — @mention detection will be disabled in groups');
  }

  // Create core components (botStartTime filters out stale events from before startup)
  const botStartTime = Date.now();
  const { dispatcher, onMessage, onCardAction, onRecall } = createEventHandler(botOpenId, logger, botStartTime);
  const sender = new MessageSender(client, logger);
  const typing = new TypingIndicator(client, logger);
  const runner = new ClaudeRunner(config, logger, config.sessionsDir);
  const sessionMgr = new SessionManager(config.sessionsDir, logger);

  // Initialize member profiles
  const { MemberManager } = await import('./members/member-manager.js');
  const memberMgr = new MemberManager(path.dirname(config.sessionsDir), logger);
  memberMgr.migrateFromAuthors(config.sessionsDir);

  // Sync members from all group chats (startup + every 6 hours)
  memberMgr.syncFromChats(config.sessionsDir, client).catch(() => {});
  setInterval(() => memberMgr.syncFromChats(config.sessionsDir, client).catch(() => {}), 6 * 60 * 60 * 1000);

  // Create message bridge (orchestrates everything)
  const bridge = new MessageBridge(sender, typing, runner, sessionMgr, config, logger);
  bridge.setMemberManager(memberMgr);

  // Initialize WeChat bridge (addon layer for DM sessions)
  const wechatBridge = new WechatBridge(sender, sessionMgr, config.sessionsDir, logger);
  bridge.setWechatBridge(wechatBridge);
  wechatBridge.start(); // scan for existing bindings, resume polling
  logger.info('WeChat bridge initialized');

  // Route all messages through the bridge
  onMessage(async (msg) => {
    await bridge.handleMessage(msg);
  });

  // Drop queued messages when the user recalls them in Feishu
  onRecall(({ messageId, chatId }) => {
    bridge.handleRecall(messageId, chatId);
  });

  // Handle card button clicks — actionId prefixed with '/' routes to command handler,
  // otherwise the click is sent as natural language to Claude.
  //
  // Toast: form submits get a floating success popup ("✓ 已提交" by default, or
  // whatever the model declared via <<TOAST:type|content>>). We compute the toast
  // BEFORE dispatching the actual business work — otherwise Claude's processing
  // would block Feishu's callback HTTP response and the user wouldn't see the
  // toast for many seconds. The work is dispatched as a fire-and-forget promise.
  onCardAction(async ({ sessionKey, chatId, actionId, label, operatorId, cardId, messageId, formValue }) => {
    const userName = await sender.resolveUserName(operatorId) || operatorId;
    logger.info({ sessionKey, chatId, actionId, label, operatorId, userName, cardId, messageId, hasFormValue: !!formValue }, 'Processing card action');

    const isFormSubmit = actionId === FORM_SUBMIT_ACTION;
    const toast = isFormSubmit ? bridge.getFormSubmitToast(cardId) : undefined;

    // Fire-and-forget: don't block toast response on Claude work
    bridge.executeButtonAction(sessionKey, chatId, actionId, label, userName, operatorId, cardId, messageId, formValue)
      .catch((err) => logger.error({ err, sessionKey, actionId }, 'executeButtonAction failed'));

    return toast ? { toast } : undefined;
  });

  // Start cron scheduler for skills
  const scheduler = new CronRunner(runner, sessionMgr, sender, logger);
  scheduler.setMessageBridge(bridge);
  scheduler.start();

  // Start alert scheduler (condition-triggered jobs, sister to cron)
  const alertRunner = new AlertRunner(runner, sessionMgr, sender, logger);
  alertRunner.setMessageBridge(bridge);
  alertRunner.start();

  // Start email IDLE monitor (push notifications for new emails).
  // Spam classification + send is routed through bridge.enqueueEmailProcess
  // so it shares the per-session FIFO queue with the user's own Claude
  // tasks (no concurrent Claude runs on the same sessionKey).
  const emailProcessor = new EmailProcessor(runner, config.sessionsDir, logger);
  bridge.setEmailProcessor(emailProcessor);
  const idleMonitor = new IdleMonitor(
    config.sessionsDir,
    async (sessionKey, chatId, account, emails) => {
      const session = sessionMgr.getOrCreate(sessionKey);
      bridge.enqueueEmailProcess(sessionKey, chatId, emails, account, session.sessionDir);
    },
    logger,
  );
  bridge.setIdleMonitor(idleMonitor);
  idleMonitor.start();

  // Start Chrome idle checker (auto-kill after 30min idle)
  const chromeChecker = new ChromeIdleChecker(
    sessionMgr,
    sessionMgr.getMcpManager().getPortAllocations(),
    logger,
  );
  chromeChecker.start();

  // Start admin dashboard + relay server + admin chat
  const { relayServer, adminChat } = startAdminServer(config.sessionsDir, config.adminPort, logger, client, config.adminPasswords, memberMgr);
  bridge.setAdminChat(adminChat);

  // Start WebSocket connection
  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Feishu WebSocket connected. Bot is ready!');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    relayServer.destroy();
    adminChat.destroy();
    wechatBridge.stopAll();
    idleMonitor.stopAll();
    chromeChecker.stop();
    scheduler.stop();
    runner.killAll();
    sessionMgr.destroy();
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
