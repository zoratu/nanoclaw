// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// telegram

// sinch (managed hosting: SQS inbound, Sinch Conversation API outbound)
import './sinch.js';

// twilio-sms (managed hosting: SQS inbound, Twilio REST outbound)
import './twilio-sms.js';

// whatsapp
