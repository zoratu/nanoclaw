/**
 * Sinch Conversation API channel for managed NanoClaw hosting.
 *
 * Inbound: polls an SQS queue for messages routed by the Acebot Sinch webhook Lambda.
 * Outbound: sends messages via Sinch Conversation API (supports Telegram, SMS, RCS, WhatsApp, etc.)
 */

import { Channel, NewMessage, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';
import { setRegisteredGroup } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import fs from 'fs';

const SINCH_PROJECT_ID = process.env.SINCH_PROJECT_ID || '';
const SINCH_KEY_ID = process.env.SINCH_KEY_ID || '';
const SINCH_KEY_SECRET = process.env.SINCH_KEY_SECRET || '';
const SINCH_APP_ID = process.env.SINCH_APP_ID || '';
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || '';
const SQS_POLL_INTERVAL = parseInt(process.env.SQS_POLL_INTERVAL || '2000', 10);
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

interface SqsMessage {
  type: string;
  channel: string;
  from: string;
  contactId: string;
  conversationId: string;
  body: string;
  timestamp?: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getSinchToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }

  const auth = Buffer.from(`${SINCH_KEY_ID}:${SINCH_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://auth.sinch.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sinch auth failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

class SinchChannel implements Channel {
  name = 'sinch';
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private autoRegistered = new Set<string>();

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  private ensureGroupRegistered(chatJid: string, senderName: string): void {
    const groups = this.registeredGroups();
    if (groups[chatJid] || this.autoRegistered.has(chatJid)) return;

    const folderName = chatJid.replace(/[^a-zA-Z0-9]/g, '-');
    const group: RegisteredGroup = {
      name: senderName,
      folder: folderName,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    };

    try {
      const groupDir = resolveGroupFolderPath(folderName);
      fs.mkdirSync(groupDir + '/logs', { recursive: true });
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to create group folder');
    }

    setRegisteredGroup(chatJid, group);
    this.autoRegistered.add(chatJid);
    logger.info({ chatJid, name: senderName }, 'Auto-registered Sinch contact as group');
  }

  async connect(): Promise<void> {
    logger.info({ appId: SINCH_APP_ID }, 'Sinch channel connecting');
    this.pollTimer = setInterval(() => this.pollSqs(), SQS_POLL_INTERVAL);
    this.connected = true;
    logger.info('Sinch channel connected (polling SQS)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // jid format: "sinch:{contactId}:{conversationId}"
    const parts = jid.split(':');
    const contactId = parts[1] || '';
    const conversationId = parts[2] || '';

    if (!conversationId) {
      logger.error({ jid }, 'Cannot send: no conversationId in JID');
      return;
    }

    const token = await getSinchToken();
    const url = `https://us.conversation.api.sinch.com/v1/projects/${SINCH_PROJECT_ID}/messages:send`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: SINCH_APP_ID,
        recipient: {
          contact_id: contactId,
        },
        message: {
          text_message: {
            text,
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error({ status: res.status, error: errText, jid }, 'Failed to send via Sinch');
      throw new Error(`Sinch send failed: ${res.status}`);
    }

    logger.info({ jid, length: text.length }, 'Message sent via Sinch');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sinch:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Sinch channel disconnected');
  }

  private async pollSqs(): Promise<void> {
    try {
      const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
      const sqs = new SQSClient({ region: AWS_REGION });

      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }));

      if (!result.Messages || result.Messages.length === 0) return;

      for (const sqsMsg of result.Messages) {
        try {
          const parsed: SqsMessage = JSON.parse(sqsMsg.Body || '{}');

          // Only process sinch messages
          if (parsed.type !== 'sinch') continue;

          const chatJid = `sinch:${parsed.contactId}:${parsed.conversationId}`;
          const now = parsed.timestamp || new Date().toISOString();

          this.ensureGroupRegistered(chatJid, parsed.from);
          this.onChatMetadata(chatJid, now, parsed.from, `sinch-${parsed.channel}`, false);

          const message: NewMessage = {
            id: `sinch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            chat_jid: chatJid,
            sender: parsed.from,
            sender_name: parsed.from,
            content: parsed.body,
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
          };

          this.onMessage(chatJid, message);
          logger.info({ channel: parsed.channel, from: parsed.from, length: parsed.body.length }, 'Inbound message received from SQS (Sinch)');

          await sqs.send(new DeleteMessageCommand({
            QueueUrl: SQS_QUEUE_URL,
            ReceiptHandle: sqsMsg.ReceiptHandle!,
          }));
        } catch (parseErr) {
          logger.error({ err: parseErr, body: sqsMsg.Body }, 'Failed to parse SQS message');
        }
      }
    } catch (err) {
      logger.debug({ err }, 'SQS poll error (Sinch)');
    }
  }
}

registerChannel('sinch', (opts) => {
  if (!SINCH_PROJECT_ID || !SINCH_KEY_ID || !SINCH_KEY_SECRET || !SINCH_APP_ID || !SQS_QUEUE_URL) {
    return null;
  }
  return new SinchChannel(opts);
});
