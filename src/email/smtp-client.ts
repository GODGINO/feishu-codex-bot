import * as nodemailer from 'nodemailer';
import type { EmailAccount } from './account-store.js';
import { getMessage } from './imap-client.js';

function createTransport(account: EmailAccount) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.tls,
    auth: { user: account.smtp.user, pass: account.smtp.pass },
  });
}

export interface SendOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

export async function sendEmail(account: EmailAccount, opts: SendOptions): Promise<void> {
  const transport = createTransport(account);
  try {
    await transport.sendMail({
      from: account.smtp.user,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.body,
      html: opts.html,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
    });
  } finally {
    transport.close();
  }
}

export async function replyEmail(
  account: EmailAccount,
  originalUid: number,
  folder: string,
  body: string,
): Promise<void> {
  const original = await getMessage(account, folder, originalUid);
  if (!original) throw new Error(`Message UID ${originalUid} not found in ${folder}`);

  // Build reply subject
  const subject = original.subject.startsWith('Re:')
    ? original.subject
    : `Re: ${original.subject}`;

  await sendEmail(account, {
    to: original.from,
    subject,
    body,
    inReplyTo: original.messageId,
    references: [original.references, original.messageId].filter(Boolean).join(' '),
  });
}

export async function forwardEmail(
  account: EmailAccount,
  originalUid: number,
  folder: string,
  to: string,
  comment?: string,
): Promise<void> {
  const original = await getMessage(account, folder, originalUid);
  if (!original) throw new Error(`Message UID ${originalUid} not found in ${folder}`);

  const subject = original.subject.startsWith('Fwd:')
    ? original.subject
    : `Fwd: ${original.subject}`;

  const forwardBody = [
    comment || '',
    '',
    '---------- Forwarded message ----------',
    `From: ${original.from}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    `To: ${original.to}`,
    '',
    original.body,
  ].join('\n');

  await sendEmail(account, {
    to,
    subject,
    body: forwardBody,
  });
}
