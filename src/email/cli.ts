#!/usr/bin/env node
/**
 * Email CLI tool for Claude to invoke via Bash.
 * Reads email-accounts.json from the current working directory.
 *
 * Usage:
 *   node email-cli.js <command> [options]
 *
 * Commands:
 *   accounts                       - List configured email accounts
 *   folders --account=<id>         - List folders
 *   list --account=<id> [--folder=INBOX] [--limit=20] [--page=1]
 *   read --account=<id> --uid=<uid> [--folder=INBOX]
 *   search --account=<id> [--from=...] [--to=...] [--subject=...] [--since=...] [--before=...] [--unseen]
 *   send --account=<id> --to=<addr> --subject=<subj> --body=<body> [--cc=...] [--bcc=...]
 *   reply --account=<id> --uid=<uid> --body=<body> [--folder=INBOX]
 *   forward --account=<id> --uid=<uid> --to=<addr> [--folder=INBOX] [--comment=...]
 *   move --account=<id> --uid=<uid> --from=<folder> --to-folder=<folder>
 *   delete --account=<id> --uid=<uid> [--folder=INBOX]
 *   mark-read --account=<id> --uid=<uid> [--folder=INBOX]
 *   mark-unread --account=<id> --uid=<uid> [--folder=INBOX]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AccountStore, EMAIL_PRESETS } from './account-store.js';
import * as imap from './imap-client.js';
import * as smtp from './smtp-client.js';

function parseArgs(args: string[]): { command: string; opts: Record<string, string | boolean> } {
  const command = args[0] || 'help';
  const opts: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        opts[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        opts[arg.slice(2)] = true;
      }
    }
  }

  return { command, opts };
}

function getAccount(opts: Record<string, string | boolean>) {
  const accountId = opts.account as string;
  if (!accountId) {
    console.error('Error: --account=<id> is required');
    process.exit(1);
  }
  const account = AccountStore.get(process.cwd(), accountId);
  if (!account) {
    const accounts = AccountStore.load(process.cwd());
    const ids = accounts.map(a => a.id).join(', ');
    console.error(`Error: Account "${accountId}" not found. Available: ${ids || '(none)'}`);
    process.exit(1);
  }
  return account;
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));

  try {
    switch (command) {
      case 'accounts': {
        const accounts = AccountStore.load(process.cwd());
        if (accounts.length === 0) {
          console.log('No email accounts configured.');
        } else {
          console.log('Configured email accounts:\n');
          for (const a of accounts) {
            console.log(`  ${a.id}: ${a.label} (${a.imap.user}) [push: ${a.pushEnabled ? 'on' : 'off'}]`);
          }
        }
        break;
      }

      case 'folders': {
        const account = getAccount(opts);
        const folders = await imap.listFolders(account);
        console.log(`Folders for ${account.id}:\n`);
        for (const f of folders) {
          console.log(`  ${f.path}`);
        }
        break;
      }

      case 'list': {
        const account = getAccount(opts);
        const folder = (opts.folder as string) || 'INBOX';
        const limit = parseInt(opts.limit as string) || 20;
        const page = parseInt(opts.page as string) || 1;
        const result = await imap.listMessages(account, folder, limit, page);
        console.log(`${folder} — ${result.total} messages total (page ${page}, showing ${result.messages.length}):\n`);
        for (const m of result.messages) {
          const flag = m.seen ? ' ' : '*';
          const att = m.hasAttachments ? ' [附件]' : '';
          console.log(`  ${flag} UID:${m.uid} | ${m.date?.slice(0, 16)} | ${m.from}`);
          console.log(`    ${m.subject}${att}`);
        }
        break;
      }

      case 'read': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        if (!uid) { console.error('Error: --uid=<number> required'); process.exit(1); }
        const folder = (opts.folder as string) || 'INBOX';
        const msg = await imap.getMessage(account, folder, uid);
        if (!msg) {
          console.error(`Message UID ${uid} not found in ${folder}`);
          process.exit(1);
        }
        console.log(`From: ${msg.from}`);
        console.log(`To: ${msg.to}`);
        if (msg.cc) console.log(`Cc: ${msg.cc}`);
        console.log(`Date: ${msg.date}`);
        console.log(`Subject: ${msg.subject}`);
        if (msg.attachments.length > 0) {
          console.log(`Attachments: ${msg.attachments.map(a => `${a.filename} (${a.contentType}, ${Math.round(a.size / 1024)}KB)`).join(', ')}`);
        }
        console.log(`\n${msg.body}`);
        break;
      }

      case 'search': {
        const account = getAccount(opts);
        const limit = parseInt(opts.limit as string) || 20;
        const messages = await imap.searchMessages(account, {
          folder: opts.folder as string,
          from: opts.from as string,
          to: opts.to as string,
          subject: opts.subject as string,
          body: opts.body as string,
          since: opts.since as string,
          before: opts.before as string,
          unseen: opts.unseen === true,
        }, limit);
        console.log(`Search results (${messages.length}):\n`);
        for (const m of messages) {
          const flag = m.seen ? ' ' : '*';
          console.log(`  ${flag} UID:${m.uid} | ${m.date?.slice(0, 16)} | ${m.from}`);
          console.log(`    ${m.subject}`);
        }
        break;
      }

      case 'send': {
        const account = getAccount(opts);
        const to = opts.to as string;
        const subject = opts.subject as string;
        const body = opts.body as string;
        if (!to || !subject || !body) {
          console.error('Error: --to, --subject, --body are all required');
          process.exit(1);
        }
        await smtp.sendEmail(account, {
          to,
          subject,
          body,
          cc: opts.cc as string,
          bcc: opts.bcc as string,
        });
        console.log(`Email sent to ${to}`);
        break;
      }

      case 'reply': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        const body = opts.body as string;
        if (!uid || !body) { console.error('Error: --uid and --body required'); process.exit(1); }
        const folder = (opts.folder as string) || 'INBOX';
        await smtp.replyEmail(account, uid, folder, body);
        console.log(`Reply sent for UID ${uid}`);
        break;
      }

      case 'forward': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        const to = opts.to as string;
        if (!uid || !to) { console.error('Error: --uid and --to required'); process.exit(1); }
        const folder = (opts.folder as string) || 'INBOX';
        await smtp.forwardEmail(account, uid, folder, to, opts.comment as string);
        console.log(`Forwarded UID ${uid} to ${to}`);
        break;
      }

      case 'move': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        const from = opts.from as string;
        const toFolder = opts['to-folder'] as string;
        if (!uid || !from || !toFolder) { console.error('Error: --uid, --from, --to-folder required'); process.exit(1); }
        await imap.moveMessage(account, uid, from, toFolder);
        console.log(`Moved UID ${uid} from ${from} to ${toFolder}`);
        break;
      }

      case 'delete': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        if (!uid) { console.error('Error: --uid required'); process.exit(1); }
        const folder = (opts.folder as string) || 'INBOX';
        await imap.deleteMessage(account, uid, folder);
        console.log(`Deleted UID ${uid} from ${folder}`);
        break;
      }

      case 'mark-read': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        if (!uid) { console.error('Error: --uid required'); process.exit(1); }
        const folder = (opts.folder as string) || 'INBOX';
        await imap.markRead(account, uid, folder);
        console.log(`Marked UID ${uid} as read`);
        break;
      }

      case 'mark-unread': {
        const account = getAccount(opts);
        const uid = parseInt(opts.uid as string);
        if (!uid) { console.error('Error: --uid required'); process.exit(1); }
        const folder = (opts.folder as string) || 'INBOX';
        await imap.markUnread(account, uid, folder);
        console.log(`Marked UID ${uid} as unread`);
        break;
      }

      case 'add-account': {
        // Add a new email account with automatic connection testing
        // Required: --email, --password, --provider (or --imap-host, --imap-port, --smtp-host, --smtp-port)
        // Optional: --label, --id
        const email = opts.email as string;
        const password = opts.password as string;
        const provider = opts.provider as string;
        if (!email || !password) {
          console.error('Error: --email and --password are required');
          process.exit(1);
        }

        let imapHost: string, imapPort: number, imapTls: boolean;
        let smtpHost: string, smtpPort: number, smtpTls: boolean;

        if (provider && EMAIL_PRESETS[provider]) {
          const preset = EMAIL_PRESETS[provider];
          imapHost = preset.imap.host;
          imapPort = preset.imap.port;
          imapTls = preset.imap.tls;
          smtpHost = preset.smtp.host;
          smtpPort = preset.smtp.port;
          smtpTls = preset.smtp.tls;
        } else if (opts['imap-host'] && opts['smtp-host']) {
          imapHost = opts['imap-host'] as string;
          imapPort = parseInt(opts['imap-port'] as string) || 993;
          imapTls = imapPort === 993;
          smtpHost = opts['smtp-host'] as string;
          smtpPort = parseInt(opts['smtp-port'] as string) || 465;
          smtpTls = smtpPort === 465;
        } else {
          console.error('Error: --provider=<name> or --imap-host/--smtp-host are required');
          console.error('Available providers: ' + Object.keys(EMAIL_PRESETS).join(', '));
          process.exit(1);
        }

        const accountId = (opts.id as string) || (provider && provider !== 'custom'
          ? provider
          : email.split('@')[0].replace(/[^a-zA-Z0-9]/g, ''));
        const label = (opts.label as string) || `${provider || 'email'} (${email})`;

        const newAccount = {
          id: accountId,
          label,
          imap: { host: imapHost, port: imapPort, user: email, pass: password, tls: imapTls },
          smtp: { host: smtpHost, port: smtpPort, user: email, pass: password, tls: smtpTls },
          pushEnabled: true,
        };

        // Test connections
        console.log('Testing IMAP connection...');
        const testResult = await AccountStore.test(newAccount);

        if (!testResult.imap && !testResult.smtp) {
          console.error(`Connection failed:`);
          console.error(`  IMAP: ${testResult.imapError || 'unknown error'}`);
          console.error(`  SMTP: ${testResult.smtpError || 'unknown error'}`);
          process.exit(1);
        }

        console.log(`IMAP: ${testResult.imap ? 'OK' : 'FAILED - ' + testResult.imapError}`);
        console.log(`SMTP: ${testResult.smtp ? 'OK' : 'FAILED - ' + testResult.smtpError}`);

        // Save account
        AccountStore.add(process.cwd(), newAccount);

        // Save push target from chat-id file if it exists (for IDLE monitor)
        try {
          const chatIdFile = path.join(process.cwd(), 'chat-id');
          const chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
          if (chatId) AccountStore.savePushTarget(process.cwd(), chatId);
        } catch { /* ignore - push target will be resolved via chat-id file fallback */ }

        // Write signal file for main process to detect
        const signalFile = path.join(process.cwd(), '.email-changed');
        fs.writeFileSync(signalFile, String(Date.now()));

        console.log(`\nAccount saved: ${accountId} (${email})`);
        break;
      }

      case 'test-account': {
        // Test connection for a specific provider/email without saving
        const testEmail = opts.email as string;
        const testPass = opts.password as string;
        const testProvider = opts.provider as string;
        if (!testEmail || !testPass || !testProvider) {
          console.error('Error: --email, --password, and --provider are required');
          process.exit(1);
        }
        if (!EMAIL_PRESETS[testProvider]) {
          console.error(`Unknown provider: ${testProvider}. Available: ${Object.keys(EMAIL_PRESETS).join(', ')}`);
          process.exit(1);
        }
        const preset = EMAIL_PRESETS[testProvider];
        const testAcc = {
          id: 'test',
          label: 'test',
          imap: { ...preset.imap, user: testEmail, pass: testPass },
          smtp: { ...preset.smtp, user: testEmail, pass: testPass },
          pushEnabled: false,
        };
        const result = await AccountStore.test(testAcc);
        console.log(`IMAP: ${result.imap ? 'OK' : 'FAILED - ' + result.imapError}`);
        console.log(`SMTP: ${result.smtp ? 'OK' : 'FAILED - ' + result.smtpError}`);
        if (!result.imap || !result.smtp) process.exit(1);
        break;
      }

      case 'remove-account': {
        const removeId = opts.id as string;
        if (!removeId) { console.error('Error: --id required'); process.exit(1); }
        const removed = AccountStore.remove(process.cwd(), removeId);
        if (removed) {
          const signalFile = path.join(process.cwd(), '.email-changed');
          fs.writeFileSync(signalFile, String(Date.now()));
          console.log(`Account ${removeId} removed`);
        } else {
          console.error(`Account ${removeId} not found`);
          process.exit(1);
        }
        break;
      }

      default:
        console.log(`Email CLI - Available commands:
  accounts                       List configured accounts
  add-account                    Add account (--email, --password, --provider OR --imap-host/--smtp-host, --label, --id)
  test-account                   Test connection (--email, --password, --provider)
  remove-account                 Remove account (--id)
  folders --account=<id>         List mailbox folders
  list --account=<id>            List messages (--folder, --limit, --page)
  read --account=<id> --uid=N    Read a message
  search --account=<id>          Search (--from, --to, --subject, --since, --before, --unseen)
  send --account=<id>            Send (--to, --subject, --body, --cc, --bcc)
  reply --account=<id>           Reply (--uid, --body)
  forward --account=<id>         Forward (--uid, --to, --comment)
  move --account=<id>            Move (--uid, --from, --to-folder)
  delete --account=<id>          Delete (--uid, --folder)
  mark-read --account=<id>       Mark as read (--uid, --folder)
  mark-unread --account=<id>     Mark as unread (--uid, --folder)

Available providers: ${Object.keys(EMAIL_PRESETS).join(', ')}`);
        break;
    }
  } catch (err: any) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
}

main();
