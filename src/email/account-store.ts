import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import * as nodemailer from 'nodemailer';

const ACCOUNTS_FILE = 'email-accounts.json';
const PUSH_TARGET_FILE = 'push-target.json';
const ALGORITHM = 'aes-256-gcm';

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface EmailAccount {
  id: string;
  label: string;
  imap: ImapConfig;
  smtp: SmtpConfig;
  pushEnabled: boolean;
}

interface EncryptedData {
  iv: string;
  tag: string;
  data: string;
}

interface StoredFile {
  encrypted: EncryptedData;
}

function getEncryptionKey(): Buffer {
  const key = process.env.EMAIL_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('EMAIL_ENCRYPTION_KEY environment variable is required');
  }
  // Derive a 32-byte key from the passphrase
  return crypto.scryptSync(key, 'feishu-email-salt', 32);
}

function encrypt(plaintext: string): EncryptedData {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted,
  };
}

function decrypt(enc: EncryptedData): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(enc.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  let decrypted = decipher.update(enc.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class AccountStore {
  static getFilePath(sessionDir: string): string {
    return path.join(sessionDir, ACCOUNTS_FILE);
  }

  static load(sessionDir: string): EmailAccount[] {
    const filePath = this.getFilePath(sessionDir);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const stored: StoredFile = JSON.parse(raw);
      const decrypted = decrypt(stored.encrypted);
      return JSON.parse(decrypted) as EmailAccount[];
    } catch {
      return [];
    }
  }

  static save(sessionDir: string, accounts: EmailAccount[]): void {
    const filePath = this.getFilePath(sessionDir);
    const encrypted = encrypt(JSON.stringify(accounts));
    const stored: StoredFile = { encrypted };
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  static add(sessionDir: string, account: EmailAccount): void {
    const accounts = this.load(sessionDir);
    // Replace if same id exists
    const idx = accounts.findIndex(a => a.id === account.id);
    if (idx >= 0) {
      accounts[idx] = account;
    } else {
      accounts.push(account);
    }
    this.save(sessionDir, accounts);
  }

  static remove(sessionDir: string, accountId: string): boolean {
    const accounts = this.load(sessionDir);
    const filtered = accounts.filter(a => a.id !== accountId);
    if (filtered.length === accounts.length) return false;
    this.save(sessionDir, filtered);
    return true;
  }

  static get(sessionDir: string, accountId: string): EmailAccount | undefined {
    return this.load(sessionDir).find(a => a.id === accountId);
  }

  /**
   * Save the Feishu chatId for push notifications.
   */
  static savePushTarget(sessionDir: string, chatId: string): void {
    const filePath = path.join(sessionDir, PUSH_TARGET_FILE);
    fs.writeFileSync(filePath, JSON.stringify({ chatId }));
  }

  /**
   * Load the Feishu chatId for push notifications.
   */
  static loadPushTarget(sessionDir: string): string | null {
    const filePath = path.join(sessionDir, PUSH_TARGET_FILE);
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data.chatId || null;
    } catch {
      return null;
    }
  }

  /**
   * Test IMAP and SMTP connections for an account.
   */
  static async test(account: EmailAccount): Promise<{ imap: boolean; smtp: boolean; imapError?: string; smtpError?: string }> {
    let imapOk = false;
    let smtpOk = false;
    let imapError: string | undefined;
    let smtpError: string | undefined;

    // Test IMAP
    try {
      const client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.tls,
        auth: { user: account.imap.user, pass: account.imap.pass },
        logger: false,
      });
      await client.connect();
      await client.logout();
      imapOk = true;
    } catch (err: any) {
      imapError = err.message || String(err);
    }

    // Test SMTP
    try {
      const transport = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.tls,
        auth: { user: account.smtp.user, pass: account.smtp.pass },
      });
      await transport.verify();
      transport.close();
      smtpOk = true;
    } catch (err: any) {
      smtpError = err.message || String(err);
    }

    return { imap: imapOk, smtp: smtpOk, imapError, smtpError };
  }
}

/**
 * Well-known email provider presets.
 */
export const EMAIL_PRESETS: Record<string, { imap: Omit<ImapConfig, 'user' | 'pass'>; smtp: Omit<SmtpConfig, 'user' | 'pass'> }> = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 587, tls: false },
  },
  outlook: {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: false },
  },
  hotmail: {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: false },
  },
  qq: {
    imap: { host: 'imap.qq.com', port: 993, tls: true },
    smtp: { host: 'smtp.qq.com', port: 587, tls: false },
  },
  '163': {
    imap: { host: 'imap.163.com', port: 993, tls: true },
    smtp: { host: 'smtp.163.com', port: 465, tls: true },
  },
  exmail: {
    imap: { host: 'imap.exmail.qq.com', port: 993, tls: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, tls: true },
  },
  feishu: {
    imap: { host: 'imap.feishu.cn', port: 993, tls: true },
    smtp: { host: 'smtp.feishu.cn', port: 465, tls: true },
  },
};
