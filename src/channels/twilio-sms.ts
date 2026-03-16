/**
 * Twilio SMS channel for managed NanoClaw hosting.
 *
 * Inbound: polls an SQS queue for messages routed by the Acebot webhook Lambda.
 * Outbound: sends SMS via Twilio REST API.
 */

import { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || '';
const SQS_POLL_INTERVAL = parseInt(process.env.SQS_POLL_INTERVAL || '2000', 10);
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

interface SqsMessage {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  fromName?: string;
  timestamp?: string;
  type?: 'sms' | 'voice';
}

class TwilioSmsChannel implements Channel {
  name = 'twilio-sms';
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    logger.info({ phone: TWILIO_PHONE_NUMBER }, 'Twilio SMS channel connecting');

    // Start SQS polling loop
    this.pollTimer = setInterval(() => this.pollSqs(), SQS_POLL_INTERVAL);
    this.connected = true;

    logger.info('Twilio SMS channel connected (polling SQS)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // jid is the sender's phone number (e.g., +14085551234)
    const toNumber = jid.replace('sms:', '');

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const body = new URLSearchParams({
      To: toNumber,
      From: TWILIO_PHONE_NUMBER,
      Body: text,
    });

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error({ to: toNumber, status: res.status, error: errText }, 'Failed to send SMS');
      throw new Error(`Twilio send failed: ${res.status}`);
    }

    logger.info({ to: toNumber, length: text.length }, 'SMS sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sms:') || jid.startsWith('+');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Twilio SMS channel disconnected');
  }

  private async pollSqs(): Promise<void> {
    try {
      // Use AWS SDK v3 lightweight HTTP call to avoid bundling the full SDK
      const url = new URL(SQS_QUEUE_URL);
      const receiveUrl = `${SQS_QUEUE_URL}?Action=ReceiveMessage&MaxNumberOfMessages=10&WaitTimeSeconds=0&AttributeName=All`;

      // We need to sign the request with SigV4 - use the SDK
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
          const chatJid = `sms:${parsed.from}`;
          const now = parsed.timestamp || new Date().toISOString();

          // Notify about chat metadata
          this.onChatMetadata(chatJid, now, parsed.fromName || parsed.from, 'twilio-sms', false);

          // Create inbound message
          const message: NewMessage = {
            id: parsed.messageSid || `sms-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            chat_jid: chatJid,
            sender: parsed.from,
            sender_name: parsed.fromName || parsed.from,
            content: parsed.body,
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
          };

          this.onMessage(chatJid, message);
          logger.info({ from: parsed.from, length: parsed.body.length }, 'Inbound SMS received from SQS');

          // Delete message from queue
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: SQS_QUEUE_URL,
            ReceiptHandle: sqsMsg.ReceiptHandle!,
          }));
        } catch (parseErr) {
          logger.error({ err: parseErr, body: sqsMsg.Body }, 'Failed to parse SQS message');
        }
      }
    } catch (err) {
      // Don't log connection errors every 2 seconds - only on first failure
      logger.debug({ err }, 'SQS poll error');
    }
  }
}

// Self-register with the channel registry
registerChannel('twilio-sms', (opts) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !SQS_QUEUE_URL) {
    return null; // Missing credentials, skip
  }
  return new TwilioSmsChannel(opts);
});
