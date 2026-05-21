/**
 * Server entry point — for cloud deployment (no Mac-specific subsystems).
 *
 * Differences from src/index.ts (local entry):
 * - No Chrome idle checker (cloud server has no per-session Chrome)
 * - No Cloudflare Tunnel startup (bot.sh's responsibility; on cloud the server has a public IP)
 *
 * Everything else (Feishu client, bridge, scheduler, email, admin, relay, WeChat) is identical.
 * This file is kept structurally parallel to index.ts so future drift is easy to audit via diff.
 */
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
import { CronRunner } from './scheduler/cron-runner.js';
import { AlertRunner } from './scheduler/alert-runner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { IdleMonitor } from './email/idle-monitor.js';
import { EmailProcessor, formatPushNotification } from './email/email-processor.js';
import { startAdminServer } from './admin/server.js';
import { WechatBridge } from './wechat/wechat-bridge.js';

function ensureSingleInstance(pidPath: string, logger: ReturnType<typeof createLogger>): void {
  try {
    const oldPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        logger.info({ oldPid }, 'Killed previous bot process via PID file');
      } catch { /* already gone */ }
    }
  } catch { /* no PID file */ }

  killOrphanProcesses(logger);
  fs.writeFileSync(pidPath, String(process.pid));
}

function killOrphanProcesses(logger: ReturnType<typeof createLogger>): void {
  for (const pattern of ['node dist/index.server.js', 'tsx src/index.server.ts']) {
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

  setInterval(() => {
    killOrphanProcesses(logger);
  }, 60_000);

  logger.info('Starting Feishu Claude Bot (server mode)...');

  const { client, wsClient } = createFeishuClients(
    config.feishu.appId,
    config.feishu.appSecret,
    logger,
  );

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

  const botStartTime = Date.now();
  const { dispatcher, onMessage, onCardAction } = createEventHandler(botOpenId, logger, botStartTime);
  const sender = new MessageSender(client, logger);
  const typing = new TypingIndicator(client, logger);
  const runner = new ClaudeRunner(config, logger, config.sessionsDir);
  const sessionMgr = new SessionManager(config.sessionsDir, logger);

  const { MemberManager } = await import('./members/member-manager.js');
  const memberMgr = new MemberManager(path.dirname(config.sessionsDir), logger);
  memberMgr.migrateFromAuthors(config.sessionsDir);

  memberMgr.syncFromChats(config.sessionsDir, client).catch(() => {});
  setInterval(() => memberMgr.syncFromChats(config.sessionsDir, client).catch(() => {}), 6 * 60 * 60 * 1000);

  const bridge = new MessageBridge(sender, typing, runner, sessionMgr, config, logger);
  bridge.setMemberManager(memberMgr);

  const wechatBridge = new WechatBridge(sender, sessionMgr, config.sessionsDir, logger);
  bridge.setWechatBridge(wechatBridge);
  wechatBridge.start();
  logger.info('WeChat bridge initialized');

  onMessage(async (msg) => {
    await bridge.handleMessage(msg);
  });

  onCardAction(async ({ sessionKey, chatId, actionId, label, operatorId, cardId, messageId, formValue }) => {
    const userName = await sender.resolveUserName(operatorId) || operatorId;
    logger.info({ sessionKey, chatId, actionId, label, operatorId, userName, cardId, messageId, hasFormValue: !!formValue }, 'Processing card action');
    await bridge.executeButtonAction(sessionKey, chatId, actionId, label, userName, operatorId, cardId, messageId, formValue);
  });

  const scheduler = new CronRunner(runner, sessionMgr, sender, logger);
  scheduler.setMessageBridge(bridge);
  scheduler.start();

  // Start alert scheduler (condition-triggered jobs, sister to cron)
  const alertRunner = new AlertRunner(runner, sessionMgr, sender, logger);
  alertRunner.setMessageBridge(bridge);
  alertRunner.start();

  const emailProcessor = new EmailProcessor(runner, config.sessionsDir, logger);
  const idleMonitor = new IdleMonitor(
    config.sessionsDir,
    async (sessionKey, chatId, account, emails) => {
      try {
        const session = sessionMgr.getOrCreate(sessionKey);
        const processed = await emailProcessor.process(emails, account, session.sessionDir);
        const toNotify = processed.filter(e => !e.isSpam);
        if (toNotify.length > 0) {
          const text = formatPushNotification(toNotify);
          await sender.sendReply(chatId, text);
        }
        const spamCount = processed.filter(e => e.isSpam).length;
        if (spamCount > 0) {
          logger.debug({ sessionKey, accountId: account.id, spamCount }, 'Filtered spam emails');
        }
      } catch (err) {
        logger.error({ err, sessionKey, accountId: account.id }, 'Failed to process new emails');
      }
    },
    logger,
  );
  bridge.setIdleMonitor(idleMonitor);
  idleMonitor.start();

  // NOTE: ChromeIdleChecker intentionally omitted — server has no per-session Chrome.

  const { relayServer, adminChat } = startAdminServer(config.sessionsDir, config.adminPort, logger, client, config.adminPasswords, memberMgr);
  bridge.setAdminChat(adminChat);

  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Feishu WebSocket connected. Bot is ready!');

  const shutdown = () => {
    logger.info('Shutting down...');
    relayServer.destroy();
    adminChat.destroy();
    wechatBridge.stopAll();
    idleMonitor.stopAll();
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
