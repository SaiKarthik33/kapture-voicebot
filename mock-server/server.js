'use strict';

require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Mock accepted verification codes (last 4 of PAN or birth year)
const VALID_VERIFICATION_CODES = new Set(['1234', '1995']);

const VALID_DISPOSITION_STATUSES = new Set([
  'PTP_AGREED',
  'ALREADY_PAID',
  'DISPUTED',
  'HARDSHIP_ESCALATED',
  'WRONG_PERSON',
  'DO_NOT_CALL',
  'NO_RESPONSE',
]);

const VALID_PAYMENT_CHANNELS = new Set(['SMS', 'WhatsApp', 'BOTH']);

const VALID_ESCALATION_REASONS = new Set(['HARDSHIP_REQUEST', 'DISPUTE']);

// ---------------------------------------------------------------------------
// PII-safe logger
// Masks verification codes and customer names before writing to stdout.
// ---------------------------------------------------------------------------
function log(toolName, args) {
  const safe = { ...args };
  if ('verification_code' in safe) safe.verification_code = '****';
  console.log(`[${new Date().toISOString()}] Tool call received: ${toolName}`, JSON.stringify(safe));
}

// ---------------------------------------------------------------------------
// Tool handlers
// Each handler receives the parsed args object and returns a plain result
// object. Validation errors are returned as { success: false, error: '...' }.
// ---------------------------------------------------------------------------

// verify_customer
// Gate for AUTH_PENDING → AUTHENTICATED transition.
// Returns verified: true only for the two mock codes defined above.
//
// Normalization: live STT may transcribe "1234" as "1 2 3 4", "1-2-3-4",
// or "1, 2, 3, 4". Strip every non-digit character before comparing so all
// spoken variants of a valid code resolve correctly.
function normalizeVerificationCode(raw) {
  return String(raw).replace(/\D/g, '');
}

function handleVerifyCustomer(args) {
  const { account_id, verification_code } = args;

  if (!account_id || verification_code == null || verification_code === '') {
    return { success: false, error: 'Missing required parameters: account_id, verification_code' };
  }

  if (VALID_VERIFICATION_CODES.has(normalizeVerificationCode(verification_code))) {
    return { verified: true, message: 'Identity verified successfully.' };
  }

  return { verified: false, message: 'Verification failed. Incorrect code.' };
}

// log_promise_to_pay
// Records the customer's PTP commitment. Generates a PTP-XXXX reference ID.
function handleLogPromiseToPay(args) {
  const { account_id, ptp_date, amount } = args;

  if (!account_id || !ptp_date || amount === undefined || amount === null) {
    return { success: false, error: 'Missing required parameters: account_id, ptp_date, amount' };
  }

  if (typeof amount !== 'number' || amount <= 0) {
    return { success: false, error: 'Parameter amount must be a positive number' };
  }

  const ptp_id = `PTP-${Math.floor(1000 + Math.random() * 9000)}`;

  return {
    success: true,
    ptp_id,
    confirmed_date: ptp_date,
    amount,
  };
}

// send_payment_link
// Dispatches a payment link via the requested channel (SMS / WhatsApp / BOTH).
function handleSendPaymentLink(args) {
  const { account_id, channel } = args;

  if (!account_id || !channel) {
    return { success: false, error: 'Missing required parameters: account_id, channel' };
  }

  if (!VALID_PAYMENT_CHANNELS.has(channel)) {
    return {
      success: false,
      error: `Invalid channel "${channel}". Allowed values: SMS, WhatsApp, BOTH`,
    };
  }

  return {
    success: true,
    message: `Payment link sent successfully via ${channel} to registered mobile number.`,
  };
}

// mark_disposition
// Logs the final call outcome. Must be called in every terminal call path.
function handleMarkDisposition(args) {
  const { account_id, status, notes } = args;

  if (!account_id || !status) {
    return { success: false, error: 'Missing required parameters: account_id, status' };
  }

  if (!VALID_DISPOSITION_STATUSES.has(status)) {
    return {
      success: false,
      error: `Invalid status "${status}". Allowed values: ${[...VALID_DISPOSITION_STATUSES].join(', ')}`,
    };
  }

  return {
    success: true,
    disposition_logged: status,
    notes: notes || null,
    timestamp: new Date().toISOString(),
  };
}

// escalate_to_agent
// Transfers the call to a human agent for hardship or dispute resolution.
// After this returns, the LLM must still call mark_disposition before ending.
function handleEscalateToAgent(args) {
  const { reason } = args;

  if (!reason) {
    return { success: false, error: 'Missing required parameter: reason' };
  }

  if (!VALID_ESCALATION_REASONS.has(reason)) {
    return {
      success: false,
      error: `Invalid reason "${reason}". Allowed values: HARDSHIP_REQUEST, DISPUTE`,
    };
  }

  return {
    success: true,
    message: `Escalating to human agent for ${reason}. Please hold while we connect you.`,
  };
}

// ---------------------------------------------------------------------------
// Tool router
// Maps tool name → handler function.
// Includes PascalCase aliases to handle Vapi dashboard name mismatches.
// ---------------------------------------------------------------------------
const TOOL_HANDLERS = {
  verify_customer: handleVerifyCustomer,
  VerifyCustomer: handleVerifyCustomer,
  Verify_Customer: handleVerifyCustomer,
  log_promise_to_pay: handleLogPromiseToPay,
  LogPromiseToPay: handleLogPromiseToPay,
  send_payment_link: handleSendPaymentLink,
  SendPaymentLink: handleSendPaymentLink,
  mark_disposition: handleMarkDisposition,
  MarkDisposition: handleMarkDisposition,
  escalate_to_agent: handleEscalateToAgent,
  EscalateToAgent: handleEscalateToAgent,
};

// ---------------------------------------------------------------------------
// POST /webhook
// Single endpoint that receives all Vapi events.
//
// Vapi sends tool-call events with this shape:
//   { message: { type: "tool-calls", toolCalls: [{ id, function: { name, arguments } }] } }
//
// Vapi expects this response shape for tool calls:
//   { results: [{ toolCallId: "...", result: "<JSON string>" }] }
//
// All other Vapi event types (call.started, call.ended, transcript, etc.)
// are acknowledged with { status: "acknowledged" }.
// ---------------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  const { message } = req.body;

  // Handle Vapi tool-call events
  if (message && message.type === 'tool-calls') {
    const toolCall = message.toolCalls && message.toolCalls[0];

    if (!toolCall || !toolCall.function) {
      return res.status(400).json({ error: 'Malformed tool-calls payload' });
    }

    const { name, arguments: rawArgs } = toolCall.function;
    const callId = toolCall.id;

    // Vapi may send function.arguments as a JSON string — parse it if so.
    let args;
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs); } catch { args = {}; }
    } else {
      args = rawArgs || {};
    }

    // PII-safe log: masks verification_code before printing
    log(name, args);

    const handler = TOOL_HANDLERS[name];
    let result;

    if (!handler) {
      // Unknown tool — return error result but still use Vapi response format
      result = { success: false, message: 'Unknown function call' };
    } else {
      result = handler(args || {});
    }

    // Vapi requires result to be a JSON-encoded string inside the results array
    return res.status(200).json({
      results: [
        {
          toolCallId: callId,
          result: JSON.stringify(result),
        },
      ],
    });
  }

  // Acknowledge all other Vapi event types (call.started, transcript, etc.)
  return res.status(200).json({ status: 'acknowledged' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Kapture Mock Collections Webhook Server running on port ${PORT}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/webhook`);
});
