import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EmailAccount } from './account-store.js';

export interface FolderInfo {
  path: string;
  name: string;
  messageCount?: number;
  unseen?: number;
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  seen: boolean;
  hasAttachments: boolean;
  snippet: string;
}

export interface FullMessage {
  uid: number;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  body: string;
  html: string;
  attachments: { filename: string; size: number; contentType: string }[];
  messageId: string;
  inReplyTo?: string;
  references?: string;
}

function createClient(account: EmailAccount): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    auth: { user: account.imap.user, pass: account.imap.pass },
    logger: false,
  });
}

export async function listFolders(account: EmailAccount): Promise<FolderInfo[]> {
  const client = createClient(account);
  try {
    await client.connect();
    const tree = await client.listTree();
    const folders: FolderInfo[] = [];

    function walk(items: any[]) {
      for (const item of items) {
        folders.push({
          path: item.path,
          name: item.name,
        });
        if (item.folders?.length) walk(item.folders);
      }
    }
    walk(tree.folders || []);

    return folders;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function listMessages(
  account: EmailAccount,
  folder: string = 'INBOX',
  limit: number = 20,
  page: number = 1,
): Promise<{ messages: MessageSummary[]; total: number }> {
  const client = createClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const status = await client.status(folder, { messages: true, unseen: true });
      const total = status.messages || 0;

      if (total === 0) return { messages: [], total: 0 };

      // Calculate range (newest first)
      const start = Math.max(1, total - (page * limit) + 1);
      const end = Math.max(1, total - ((page - 1) * limit));
      const range = `${start}:${end}`;

      const messages: MessageSummary[] = [];
      for await (const msg of client.fetch(range, {
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: ['content-type'],
      })) {
        const env = msg.envelope as any;
        if (!env) continue;
        messages.push({
          uid: msg.uid,
          subject: env.subject || '(no subject)',
          from: env.from?.[0] ? `${env.from[0].name || ''} <${env.from[0].address || ''}>`.trim() : '',
          to: env.to?.map((a: any) => a.address).join(', ') || '',
          date: env.date?.toISOString?.() || '',
          seen: msg.flags?.has('\\Seen') || false,
          hasAttachments: !!(msg.bodyStructure as any)?.childNodes?.some((n: any) =>
            n.disposition === 'attachment',
          ),
          snippet: '',
        });
      }

      // Return newest first
      messages.reverse();
      return { messages, total };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getMessage(
  account: EmailAccount,
  folder: string,
  uid: number,
): Promise<FullMessage | null> {
  const client = createClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const raw = await client.download(String(uid), undefined, { uid: true });
      if (!raw?.content) return null;

      const parsed = await simpleParser(raw.content);

      return {
        uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map(a => a.text).join(', ') : parsed.to.text) : '',
        cc: parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc.map(a => a.text).join(', ') : parsed.cc.text) : '',
        date: parsed.date?.toISOString() || '',
        body: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map(a => ({
          filename: a.filename || 'unnamed',
          size: a.size,
          contentType: a.contentType,
        })),
        messageId: parsed.messageId || '',
        inReplyTo: parsed.inReplyTo || undefined,
        references: parsed.references ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references) : undefined,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function searchMessages(
  account: EmailAccount,
  query: {
    folder?: string;
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
    since?: string;
    before?: string;
    unseen?: boolean;
  },
  limit: number = 20,
): Promise<MessageSummary[]> {
  const client = createClient(account);
  try {
    await client.connect();
    const folder = query.folder || 'INBOX';
    const lock = await client.getMailboxLock(folder);
    try {
      const searchCriteria: any = {};
      if (query.from) searchCriteria.from = query.from;
      if (query.to) searchCriteria.to = query.to;
      if (query.subject) searchCriteria.subject = query.subject;
      if (query.body) searchCriteria.body = query.body;
      if (query.since) searchCriteria.since = new Date(query.since);
      if (query.before) searchCriteria.before = new Date(query.before);
      if (query.unseen) searchCriteria.seen = false;

      const uids = await client.search(searchCriteria, { uid: true }) as number[];
      if (!uids || !uids.length) return [];

      // Take last N (newest)
      const targetUids = uids.slice(-limit);
      const messages: MessageSummary[] = [];

      for await (const msg of client.fetch(targetUids, {
        envelope: true,
        flags: true,
        uid: true,
      })) {
        const env = msg.envelope as any;
        if (!env) continue;
        messages.push({
          uid: msg.uid,
          subject: env.subject || '(no subject)',
          from: env.from?.[0] ? `${env.from[0].name || ''} <${env.from[0].address || ''}>`.trim() : '',
          to: env.to?.map((a: any) => a.address).join(', ') || '',
          date: env.date?.toISOString?.() || '',
          seen: msg.flags?.has('\\Seen') || false,
          hasAttachments: false,
          snippet: '',
        });
      }

      messages.reverse();
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function moveMessage(
  account: EmailAccount,
  uid: number,
  fromFolder: string,
  toFolder: string,
): Promise<void> {
  const client = createClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(fromFolder);
    try {
      await client.messageMove(String(uid), toFolder, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function deleteMessage(
  account: EmailAccount,
  uid: number,
  folder: string,
): Promise<void> {
  const client = createClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function markRead(account: EmailAccount, uid: number, folder: string): Promise<void> {
  const client = createClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function markUnread(account: EmailAccount, uid: number, folder: string): Promise<void> {
  const client = createClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
