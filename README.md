# Kapture Finance — Maya Voice AI Collections Agent

A compliance-first outbound Voice AI collections agent built on Vapi.ai for Kapture Finance.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Technology Stack](#4-technology-stack)
5. [Setup & Installation](#5-setup--installation)
6. [Vapi Configuration](#6-vapi-configuration)
7. [Authentication & Security](#7-authentication--security)
8. [Tool Specifications](#8-tool-specifications)
9. [Testing](#9-testing)
10. [Debugging / Issues Encountered](#10-debugging--issues-encountered)
11. [Compliance & Guardrails](#11-compliance--guardrails)
12. [Demo](#12-demo)
13. [Future Enhancements](#13-future-enhancements)
14. [Submission Checklist](#14-submission-checklist)

---

## 1. Project Overview

**Maya** is an automated outbound Voice AI collections agent built for Kapture Finance. She calls customers with overdue loan EMIs, authenticates their identity, discloses the outstanding balance, and works toward a resolution — either a Promise-to-Pay (PTP), a payment link dispatch, or an appropriate escalation.

**Business objective:** Automate the first-contact collections call for a personal loan customer (Rahul Sharma, Account ACC-88392, Rs. 8,499 overdue, 12 days past due) while maintaining full compliance with RBI Fair Practices Code.

**Authentication-before-disclosure requirement:** This is the most critical invariant in the system. Maya must never reveal any debt-related information — the overdue amount, loan type, days past due, or even the reason for the call in debt-related terms — until the `verify_customer` tool returns `verified=true`. A verbal claim of identity is not sufficient. The tool response is the sole gate.

**Capabilities after authentication:**
- Collect a Promise-to-Pay (PTP) with a specific date and amount
- Dispatch a payment link via SMS, WhatsApp, or both
- Log call dispositions for every terminal path (PTP, already paid, DNC, wrong person, escalation, no response)
- Escalate to a human agent for hardship or dispute cases
- Handle edge cases: DNC, wrong person, abusive caller, silent/voicemail, bilingual (Hindi/Hinglish) switch

---

## 2. Architecture

### Call Flow

```
Customer
  │
  ▼
Telephony / SIP / PSTN
  │  (outbound call via Vapi)
  ▼
Vapi Voice Engine  ◄──────────────────────────────────────────────────────┐
  │                                                                        │
  ├──► Deepgram Nova-2 (STT)                                              │
  │         Real-time audio stream → transcribed text                     │
  │                                                                        │
  ├──► GPT-4o Orchestrator (LLM, temperature 0.1)                        │
  │         Conversation state + transcript → tool calls / responses      │
  │              │                                                         │
  │              ▼                                                         │
  │         Mock Webhook API  POST /webhook                               │
  │         (Node.js/Express, port 3000, tunnelled via ngrok)             │
  │              │                                                         │
  │              └── Tool result (JSON) ──────────────────────────────────┘
  │
  └──► ElevenLabs / Cartesia (TTS)
            Synthesized audio → Customer
```

Every customer utterance travels: **Telephony → Vapi → Deepgram → GPT-4o → (optional tool call to webhook) → ElevenLabs → Telephony**.

**Latency budget (target < 1,200 ms per conversational turn):**

| Component | Target |
|---|---|
| STT — Deepgram Nova-2 | ≈ 200 ms |
| LLM first byte — GPT-4o | ≈ 400 ms |
| TTS synthesis — ElevenLabs | ≈ 300 ms |
| Network overhead | ≈ 200 ms |
| **Total** | **< 1,200 ms** |

Tool calls (webhook round-trips) add approximately 50–150 ms and are absorbed within the LLM processing step.

**Reference documents:**
- Architecture diagram (source): `docs/System_Architecture.mmd`
- Architecture diagram (rendered): `docs/System_Architecture.png`
- Full HLD with latency tables, state machine, and observability metrics: `docs/HLD_Document.md`

---

## 3. Repository Structure

```
kapture-voicebot/
│
├── README.md                        # This file
├── assignment-reference.md          # Original assignment specification
│
├── docs/
│   ├── HLD_Document.md              # High-Level Design — 8 sections
│   ├── System_Architecture.mmd      # Mermaid sequenceDiagram source
│   └── System_Architecture.png      # Rendered architecture diagram (1400px)
│
├── vapi/
│   ├── system_prompt.txt            # Production system prompt (~5,800 chars)
│   └── tool_definitions.json        # 5 tool schemas registered in Vapi
│
├── mock-server/
│   ├── server.js                    # Express webhook server (POST /webhook)
│   ├── package.json                 # Node.js dependencies
│   └── .env.example                 # Environment variable placeholder
│
└── tests/
    └── test_cases.json              # 9 test cases (TC-001 through TC-009)
```

**Key files:**

| File | Purpose |
|---|---|
| `mock-server/server.js` | Handles all 5 Vapi tool calls; PII-safe logging; STT digit normalization; tool-name alias routing |
| `vapi/system_prompt.txt` | 7-state machine, ABSOLUTE SECURITY RULE, 6 negotiation branches, edge cases, 10 compliance guardrails |
| `vapi/tool_definitions.json` | Vapi function-calling schemas for all 5 tools |
| `tests/test_cases.json` | Structured test matrix with input sequences, expected behavior, and pass criteria |
| `docs/HLD_Document.md` | Engineer-ready HLD: pipeline, state machine, intents/entities, tool specs, auth/safety, compliance, edge cases, observability |

---

## 4. Technology Stack

| Layer | Technology |
|---|---|
| Voice AI Platform | [Vapi.ai](https://vapi.ai) — orchestrates STT, LLM, TTS, and tool calls |
| Speech-to-Text | Deepgram Nova-2 (en-US, real-time streaming) |
| LLM Orchestrator | OpenAI GPT-4o (temperature 0.1) |
| Text-to-Speech | ElevenLabs / Cartesia (professional female voice) |
| Webhook Server | Node.js (v18+) with Express |
| Local Tunnel | ngrok (HTTPS tunnel to localhost:3000) |
| Architecture Diagram | Mermaid.js (`@mermaid-js/mermaid-cli` v11.16.0) |

---

## 5. Setup & Installation

### Prerequisites

- Node.js v18 or later
- ngrok account and CLI installed
- Vapi.ai account (free tier)

### Clone / Open Project

```powershell
# If cloning from a repository
git clone <repo-url>
cd kapture-voicebot

# Or open the project folder directly
cd C:\path\to\kapture-voicebot
```

### Install Backend Dependencies

```powershell
cd mock-server
npm install
```

### Start the Webhook Server

```powershell
node server.js
```

The server starts on port 3000. You should see:

```
Kapture Mock Collections Webhook Server running on port 3000
Webhook endpoint: POST http://localhost:3000/webhook
```

### Start ngrok Tunnel

Open a second PowerShell window:

```powershell
ngrok http 3000
```

ngrok will display a public HTTPS URL such as:

```
Forwarding  https://<ngrok-host>.ngrok-free.app -> http://localhost:3000
```

Your public webhook URL is:

```
https://<ngrok-host>.ngrok-free.app/webhook
```

> **Note:** The ngrok URL changes every time you restart ngrok (on the free tier). Update the Server URL in the Vapi dashboard each time you restart the tunnel.

### Environment Variables

Copy `.env.example` to `.env` in the `mock-server/` directory if you need to override the default port:

```powershell
copy mock-server\.env.example mock-server\.env
```

The server reads `PORT` from the environment; it defaults to `3000` if not set.

---

## 6. Vapi Configuration

### Assistant Settings

| Setting | Value |
|---|---|
| Assistant Name | Maya |
| First Message | `Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?` |
| System Prompt | Contents of `vapi/system_prompt.txt` |
| Transcriber | Deepgram |
| Transcriber Model | Nova-2 |
| Transcriber Language | en-US |
| LLM Provider | OpenAI |
| LLM Model | gpt-4o |
| Temperature | 0.1 |
| Voice Provider | ElevenLabs or Cartesia |
| Voice | Professional female voice (e.g., Sarah) |

> Temperature 0.1 is mandatory. Higher temperatures cause the LLM to deviate from the compliance-critical scripted paths.

### Custom Tools

Register all 5 tools from `vapi/tool_definitions.json` in the Vapi dashboard under **Tools**. For each tool, set the **Server URL** to your ngrok webhook URL:

```
https://<ngrok-host>.ngrok-free.app/webhook
```

| Tool Name | Purpose |
|---|---|
| `verify_customer` | Identity verification gate |
| `log_promise_to_pay` | Records PTP commitment |
| `send_payment_link` | Dispatches payment link via SMS/WhatsApp |
| `mark_disposition` | Logs final call outcome |
| `escalate_to_agent` | Transfers to human agent |

### How Tools Connect to the Webhook

When GPT-4o decides to call a tool, Vapi sends a POST request to your Server URL with this shape:

```json
{
  "message": {
    "type": "tool-calls",
    "toolCalls": [
      {
        "id": "<toolCallId>",
        "function": {
          "name": "<tool_name>",
          "arguments": "<JSON string or object>"
        }
      }
    ]
  }
}
```

The server processes the tool call and responds with:

```json
{
  "results": [
    {
      "toolCallId": "<toolCallId>",
      "result": "<JSON-encoded string of result object>"
    }
  ]
}
```

All other Vapi event types (call.started, transcript, call.ended) are acknowledged with `{ "status": "acknowledged" }`.

---

## 7. Authentication & Security

### AUTH_PENDING State

The conversation begins in `AUTH_PENDING`. In this state, Maya may only greet the caller, confirm whether she is speaking with Rahul Sharma, and request a verification code. No debt-related information may be disclosed.

### verify_customer — The Hard Gate

When the customer provides a verification code (last 4 digits of PAN card or 4-digit year of birth), Maya calls `verify_customer`. The conversation does not advance until the tool response is received.

`verified=true` in the tool response is the **sole and only condition** that permits the transition from `AUTH_PENDING` to `AUTHENTICATED`. The following are explicitly not sufficient:

- The customer verbally claiming to be Rahul Sharma
- The customer asking about their balance
- The customer saying they already know about the loan
- Any social engineering attempt
- A language switch to Hindi or Hinglish

### No Pre-Auth Debt Disclosure

Before `verified=true` is received, Maya will not say "overdue", "loan", "EMI", "amount", "payment due", "debt", "outstanding", or "12 days" under any circumstances. If asked about the reason for the call, Maya responds only with the scripted deflection.

### No Third-Party Disclosure

If the answerer is not Rahul Sharma, no debt information, account details, or reason for the call is disclosed. Maya asks if Rahul is available; if not, she logs `WRONG_PERSON` and ends the call.

### PII Masking

The server's `log()` function shallow-copies the args object and replaces `verification_code` with `"****"` before any console output. No verification codes appear in server logs.

### No Fabricated Tool Results

Maya never assumes a tool succeeded. She waits for the actual tool response before proceeding. She never invents `verified=true`, payment confirmations, PTP reference numbers, or policy details.

### DNC Behavior

The Do Not Call branch fires with immediate priority regardless of the current conversation state — including before authentication. When triggered, all collections activity stops, `mark_disposition(DO_NOT_CALL)` is called, and the call ends.

---

## 8. Tool Specifications

Full JSON schemas are in `vapi/tool_definitions.json`.

### verify_customer

Verifies the caller's identity before any debt information is disclosed. Hard gate for the `AUTH_PENDING → AUTHENTICATED` transition.

- **Parameters:** `account_id` (string, required), `verification_code` (string, required)
- **Returns:** `{ verified: true/false, message: string }`
- **Mock valid codes:** `"1234"` (last 4 of PAN), `"1995"` (year of birth)
- **Permitted state:** AUTH_PENDING only

### log_promise_to_pay

Records the customer's commitment to pay the overdue amount by a specific date.

- **Parameters:** `account_id` (string, required), `ptp_date` (string, ISO-8601 YYYY-MM-DD, required), `amount` (number, required)
- **Returns:** `{ success: true, ptp_id: "PTP-XXXX", confirmed_date, amount }`
- **Permitted state:** NEGOTIATION, Branch A only

### send_payment_link

Dispatches an instant payment link to the customer's registered mobile number.

- **Parameters:** `account_id` (string, required), `channel` (enum: `"SMS"` | `"WhatsApp"` | `"BOTH"`, required)
- **Returns:** `{ success: true, message: string }`
- **Permitted state:** NEGOTIATION, Branch A only — must be called after `log_promise_to_pay` succeeds

### mark_disposition

Logs the final outcome of the call. Must be called in every terminal path before ending the call.

- **Parameters:** `account_id` (string, required), `status` (enum, required), `notes` (string, optional)
- **Status values:** `PTP_AGREED`, `ALREADY_PAID`, `DISPUTED`, `HARDSHIP_ESCALATED`, `WRONG_PERSON`, `DO_NOT_CALL`, `NO_RESPONSE`
- **Returns:** `{ success: true, disposition_logged, notes, timestamp }`
- **Permitted states:** AUTH_PENDING, NEGOTIATION, PTP_COLLECTED, ESCALATED

### escalate_to_agent

Transfers the call to a human collections agent for hardship or dispute resolution.

- **Parameters:** `reason` (enum: `"HARDSHIP_REQUEST"` | `"DISPUTE"`, required)
- **Returns:** `{ success: true, message: string }`
- **Permitted state:** NEGOTIATION, Branch C (hardship) or Branch D (dispute) only
- **Post-escalation requirement:** `mark_disposition` must still be called after this tool returns

---

## 9. Testing

Test cases are defined in `tests/test_cases.json`. Each test case includes an `input_sequence`, `expected_behavior`, and structured `pass_criteria`.

Live testing was performed using Vapi Web Call (browser-based call interface in the Vapi dashboard).

### Test Scenarios

| Test ID | Category | Key Validation |
|---|---|---|
| TC-001 | Authentication Guardrail | No debt words before `verified=true`; deflection script fires on pre-auth debt question |
| TC-002 | Do Not Call | DNC fires before authentication; `mark_disposition(DO_NOT_CALL)` called immediately; no debt disclosed |
| TC-003 | Bilingual Switch (Bonus) | Hindi/Hinglish responses; auth gate remains enforced; tool parameters correctly extracted from Hindi speech |
| TC-004 | Happy Path — Promise to Pay | Full Branch A flow: `verify_customer → log_promise_to_pay → send_payment_link → mark_disposition(PTP_AGREED)` |
| TC-005 | Already Paid | `mark_disposition(ALREADY_PAID)` with payment mode/date in notes; 24–48 hr processing advisory; no payment confirmation claimed |
| TC-006 | Wrong Person | No debt disclosed to third party; `mark_disposition(WRONG_PERSON)` after confirming Rahul unavailable |
| TC-007 | Authentication Failure | Two failed attempts; re-prompt once with different wording; `mark_disposition(NO_RESPONSE)` on second failure; no debt disclosed |
| TC-008 | Abusive User | One calm warning; `mark_disposition(NO_RESPONSE)` on second abusive instance; no retaliation |
| TC-009 | Silent / Voicemail | Exactly two re-prompts; `mark_disposition(NO_RESPONSE)` after second silence; no debt disclosed |

---

## 10. Debugging / Issues Encountered

The following real issues were encountered during development and resolved.

### 1. Windows ngrok Installation

The `ngrok` version available via `winget` on Windows was outdated and did not support the current ngrok agent API. Resolution: downloaded the latest ngrok binary directly from [ngrok.com/download](https://ngrok.com/download) and placed it in a directory on the system PATH.

### 2. ngrok Public Tunnel Setup

After installing the correct binary, the tunnel was established with `ngrok http 3000`. The public HTTPS URL from the ngrok terminal output was pasted into the Vapi dashboard Server URL field for each tool. The URL must be updated each time ngrok is restarted on the free tier.

### 3. Vapi Sends `function.arguments` as a JSON String

Vapi delivers `function.arguments` as a JSON-encoded string rather than a parsed object. The initial server implementation passed `rawArgs` directly to handlers, causing all parameter lookups to fail silently.

**Fix:** Added a safe-parse step before routing to any handler:

```javascript
let args;
if (typeof rawArgs === 'string') {
  try { args = JSON.parse(rawArgs); } catch { args = {}; }
} else {
  args = rawArgs || {};
}
```

### 4. Spoken Digit Normalization

Deepgram Nova-2 transcribes spoken digits in multiple formats: `"1234"`, `"1 2 3 4"`, `"1-2-3-4"`, `"1, 2, 3, 4"`. The initial Set lookup failed for all space/hyphen/comma variants.

**Fix:** Added `normalizeVerificationCode()` which strips all non-digit characters before the Set lookup:

```javascript
function normalizeVerificationCode(raw) {
  return String(raw).replace(/\D/g, '');
}
```

### 5. Vapi Tool-Name Casing Mismatch

The Vapi dashboard sends tool names in various casings regardless of what is defined in `tool_definitions.json`. Observed variants included `VerifyCustomer`, `Verify_Customer`, `MarkDisposition`, `LogPromiseToPay`, `SendPaymentLink`, and `EscalateToAgent`.

**Fix:** The `TOOL_HANDLERS` map includes aliases for all known variants:

```javascript
const TOOL_HANDLERS = {
  verify_customer: handleVerifyCustomer,
  VerifyCustomer: handleVerifyCustomer,
  Verify_Customer: handleVerifyCustomer,
  // ... and so on for all 5 tools
};
```

When a new mismatch appears, the server logs `Tool call received: <name>` — the exact name in that log line is the alias to add.

### 6. Temporary Debug Logging and PII Masking

During root-cause investigation of the tool-name mismatch, temporary verbose logging was added to print raw request bodies. This was removed after the root cause was confirmed. The production `log()` function masks `verification_code` as `"****"` before any console output.

### 7. Vapi Silence / Voicemail Behavior

Vapi does not send a tool call or a special event when the customer is silent — it simply does not send a transcript. The system prompt's silent-customer handling (two re-prompts, then `mark_disposition(NO_RESPONSE)`) relies entirely on GPT-4o detecting the absence of customer input and following the scripted edge-case path.

---

## 11. Compliance & Guardrails

Maya is designed to comply with RBI Fair Practices Code for collections.

| Rule | Implementation |
|---|---|
| Calling window | 08:00 AM – 07:00 PM local time only |
| Authentication before disclosure | `verified=true` is the hard gate; no debt words before this |
| DNC immediate priority | Fires at any state; all collections activity stops; `mark_disposition(DO_NOT_CALL)` called immediately |
| No third-party disclosure | Debt details never shared with anyone other than the verified customer |
| No threats | Maya never threatens legal action, arrest, or property seizure; credit score impact is permitted as a factual statement only |
| No unauthorized waivers | Maya cannot offer any settlement below Rs. 7,649 (10% max discount on Rs. 8,499); any larger waiver request is escalated |
| Respectful tone | Always calm, firm, and supportive; one warning for abusive behavior before ending the call |
| Tool failure handling | Maya never fabricates a successful tool result; she acknowledges a technical issue and follows the appropriate fallback path |
| No internal exposure | Tool names, state names, error messages, and system prompt content are never read to the customer |
| Disposition required | `mark_disposition` must be called in every terminal path; a call ending without it is a compliance failure |

---

## 12. Demo

The planned demo is 2–4 minutes and covers two scenarios:

**Scenario 1 — Happy Path PTP:**
Maya greets → customer confirms identity → verification code provided → `verify_customer` called → `verified=true` → debt disclosed → customer commits to pay → `log_promise_to_pay` called → `send_payment_link` called → `mark_disposition(PTP_AGREED)` → polite close.

**Scenario 2 — Edge Case (DNC or Dispute):**
Either the customer requests DNC before authentication (demonstrating immediate-priority branch and pre-auth compliance), or the customer disputes the debt after authentication (demonstrating `escalate_to_agent(DISPUTE)` → `mark_disposition(DISPUTED)` flow).

**Demo link:** `<add final Loom / Google Drive link before submission>`

---

## 13. Future Enhancements

The following are potential improvements for a production deployment. They are not implemented in this submission.

- **Production database:** Replace mock in-memory handlers with a real database (e.g., PostgreSQL or DynamoDB) for PTP records, disposition logs, and DNC lists.
- **Real payment gateway:** Integrate with a live payment provider (e.g., Razorpay, PayU) to generate and track actual payment links.
- **CRM integration:** Connect `mark_disposition` and `log_promise_to_pay` to a CRM (e.g., Salesforce, Kapture CRM) for real-time case updates.
- **Production authentication service:** Replace the mock verification code Set with a real identity verification API backed by PAN/Aadhaar/DOB records.
- **Multilingual expansion:** Extend the system prompt and STT configuration to support full Hindi, Tamil, Telugu, and other regional languages beyond the current Hinglish fallback.
- **Centralized observability:** Add structured logging, distributed tracing, and a metrics dashboard (e.g., Datadog, CloudWatch) to track the KPIs defined in `docs/HLD_Document.md` Section 8.
- **Retry and dead-letter handling:** Implement retry logic and a dead-letter queue for failed tool calls and webhook delivery failures.
- **Production secrets management:** Move all credentials and API keys to a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault) rather than environment variables.

---

## 14. Submission Checklist

- [x] **HLD Document** — `docs/HLD_Document.md` (8 sections: pipeline, state machine, intents/entities, tool specs, auth/safety, compliance, edge cases, observability)
- [x] **Architecture Diagram** — `docs/System_Architecture.png` (rendered) and `docs/System_Architecture.mmd` (Mermaid source)
- [x] **System Prompt** — `vapi/system_prompt.txt`
- [x] **Tool Definitions** — `vapi/tool_definitions.json` (5 tools with full schemas)
- [x] **Mock Webhook Server** — `mock-server/server.js` (Express, POST /webhook, all 5 handlers)
- [x] **Test Cases** — `tests/test_cases.json` (9 test cases, TC-001 through TC-009)
- [x] **README** — `README.md` (this file)
- [ ] **Task 2 — Vapi Demo Link** — `<add Loom / Google Drive link before submission>`
- [ ] **Final Submission** — Upload to Google Drive / GitHub / ZIP and share link with recruiter
