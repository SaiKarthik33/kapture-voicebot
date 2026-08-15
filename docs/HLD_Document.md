# High-Level Design — Kapture Finance "Maya" Outbound Collections Voicebot

**Version:** 1.0  
**Project:** Kapture Finance — Outbound Voice AI Collections Agent  
**Agent Name:** Maya  
**Stack:** Vapi · Deepgram Nova-2 · GPT-4o · ElevenLabs · Node.js/Express  

---

## Table of Contents

1. [Pipeline & Latency Budget](#1-pipeline--latency-budget)
2. [State Machine](#2-state-machine)
3. [Intents & Entities](#3-intents--entities)
4. [Tool/API Specifications](#4-toolapi-specifications)
5. [Auth & Data Safety](#5-auth--data-safety)
6. [Compliance & Guardrails](#6-compliance--guardrails)
7. [Edge Cases Matrix](#7-edge-cases-matrix)
8. [Observability Metrics](#8-observability-metrics)

---

## 1. Pipeline & Latency Budget

### 1.1 Processing Pipeline

```
Customer (PSTN / SIP)
        │
        ▼
  Vapi Engine
  (Orchestrator — manages STT, LLM, TTS, tool calls)
        │
        ├──► Deepgram Nova-2 (STT)
        │         └── Transcribed text ──► Vapi
        │
        ├──► GPT-4o (LLM Orchestrator, temp=0.1)
        │         └── Tool call request ──► Mock Webhook API
        │                   └── Tool result ──► GPT-4o
        │
        └──► ElevenLabs / Cartesia (TTS)
                  └── Synthesized audio ──► Customer
```

Every customer utterance travels: **Telephony → Vapi → STT → LLM → (optional tool call) → TTS → Telephony**.  
Tool calls add one additional round-trip to the webhook server and sit inside the LLM processing step.

### 1.2 Latency Budget

| Component | Target Latency | Notes |
|---|---|---|
| STT (Deepgram Nova-2) | ≈ 200 ms | Real-time streaming; end-of-utterance detection |
| LLM First Byte (GPT-4o) | ≈ 400 ms | Temperature 0.1; streaming enabled |
| TTS Synthesis (ElevenLabs) | ≈ 300 ms | Streaming synthesis; first audio chunk |
| Network Overhead | ≈ 200 ms | Vapi ↔ STT ↔ LLM ↔ TTS round-trips |
| **Total Target** | **< 1,200 ms** | End-to-end conversational turn |

**Tool call latency note:** When a tool call is required (e.g. `verify_customer`), the webhook round-trip adds approximately 50–150 ms on a local/ngrok server. This is absorbed within the LLM processing step and does not add a separate conversational turn.

**Critical path components:** STT → LLM → TTS are all in the critical conversational path. Tool calls extend LLM processing time but do not add a separate audio turn.

### 1.3 Component Configuration

| Component | Provider | Model/Config |
|---|---|---|
| Telephony | Vapi (SIP/PSTN) | Outbound call |
| STT | Deepgram | Nova-2, en-US |
| LLM | OpenAI | GPT-4o, temperature 0.1 |
| TTS | ElevenLabs | Sarah (professional female voice) |
| Webhook | Node.js/Express | POST /webhook, port 3000 |
| Tunnel (dev) | ngrok | HTTPS tunnel to localhost:3000 |

---

## 2. State Machine

### 2.1 State Overview

The conversation operates as a strict 7-state machine. State transitions are enforced by the system prompt and tool responses. No state may be skipped.

```
INIT
  │
  ▼
AUTH_PENDING ──── verify_customer returns verified=true ────► AUTHENTICATED
  │                                                                  │
  │ (wrong person / 2nd auth failure)                               ▼
  │                                                           NEGOTIATION
  │                                                          /     |      \
  ▼                                                   Branch A  Branch C/D  Branch B/E/F
CALL_ENDED ◄─── mark_disposition ◄─── PTP_COLLECTED   ESCALATED
```

### 2.2 State Definitions

#### STATE: INIT / AUTH_PENDING

| Field | Detail |
|---|---|
| Entry condition | Call begins |
| Purpose | Greet the caller, confirm identity, perform authentication |
| Permitted actions | Greet caller; ask if speaking with Rahul Sharma; request verification code; call `verify_customer`; call `mark_disposition(WRONG_PERSON)` if third party confirmed unavailable; call `mark_disposition(NO_RESPONSE)` after two silent re-prompts |
| Permitted tools | `verify_customer`, `mark_disposition` |
| Prohibited actions | Disclosing any debt, loan, EMI, overdue amount, or DPD; calling `log_promise_to_pay`; calling `send_payment_link`; calling `escalate_to_agent`; transitioning to AUTHENTICATED without `verified=true` |
| Transition → AUTHENTICATED | **ONLY** when `verify_customer` tool response contains `verified=true` |
| Transition → CALL_ENDED | Wrong person confirmed unavailable, OR second failed verification attempt |

> **Critical invariant:** The customer verbally claiming to be Rahul Sharma is NOT sufficient to transition out of AUTH_PENDING. `verify_customer` returning `verified=true` is the sole and only gate.

#### STATE: AUTHENTICATED

| Field | Detail |
|---|---|
| Entry condition | `verify_customer` returned `verified=true` |
| Purpose | Disclose debt details to the now-verified customer |
| Permitted actions | Disclose personal loan details (Rs. 8,499 overdue by 12 days); ask how customer would like to resolve; transition to NEGOTIATION |
| Duration | Transient — transitions immediately to NEGOTIATION after disclosure |

#### STATE: NEGOTIATION

| Field | Detail |
|---|---|
| Entry condition | Debt has been disclosed to the authenticated customer |
| Purpose | Identify customer intent and execute the appropriate resolution branch |
| Permitted tools | `log_promise_to_pay` (Branch A); `send_payment_link` (Branch A); `escalate_to_agent` (Branch C/D); `mark_disposition` (Branches B, E, F, or post-escalation) |
| Branches | A: PTP · B: Already Paid · C: Hardship · D: Dispute · E: DNC · F: Wrong Person |

#### STATE: PTP_COLLECTED

| Field | Detail |
|---|---|
| Entry condition | `log_promise_to_pay` and `send_payment_link` have both returned `success=true` |
| Purpose | Confirm commitment and payment link to customer; log disposition |
| Permitted tools | `mark_disposition(PTP_AGREED)` |
| Transition → CALL_ENDED | After `mark_disposition` succeeds |

#### STATE: ESCALATED

| Field | Detail |
|---|---|
| Entry condition | `escalate_to_agent` returned `success=true` |
| Purpose | Inform customer of transfer; log disposition |
| Permitted tools | `mark_disposition(HARDSHIP_ESCALATED)` or `mark_disposition(DISPUTED)` |
| Transition → CALL_ENDED | After `mark_disposition` succeeds |

#### STATE: CALL_ENDED

| Field | Detail |
|---|---|
| Entry condition | `mark_disposition` has been called successfully |
| Purpose | Deliver closing statement and end the call |
| Permitted actions | Polite closing statement appropriate to outcome |
| Prohibited actions | Any further tool calls; any further negotiation or information disclosure |

### 2.3 Terminal Paths & Dispositions

| Path | Final `mark_disposition` status |
|---|---|
| PTP committed + link sent | `PTP_AGREED` |
| Customer claims already paid | `ALREADY_PAID` |
| Hardship escalation | `HARDSHIP_ESCALATED` |
| Dispute escalation | `DISPUTED` |
| Wrong person (at greeting) | `WRONG_PERSON` |
| Wrong person (mid-call) | `WRONG_PERSON` |
| Do Not Call request | `DO_NOT_CALL` |
| Two failed auth attempts | `NO_RESPONSE` |
| Two silent re-prompts | `NO_RESPONSE` |
| Abusive customer (2nd instance) | `NO_RESPONSE` |

---

## 3. Intents & Entities

### 3.1 Intents

| Intent | Trigger | State | Branch |
|---|---|---|---|
| `Confirm_Identity` | Customer confirms they are Rahul Sharma | AUTH_PENDING | Proceed to verification |
| `Promise_To_Pay` | Customer agrees to pay today or on a future date | NEGOTIATION | Branch A |
| `Already_Paid` | Customer claims payment was already made | NEGOTIATION | Branch B |
| `Hardship_Claim` | Customer says they cannot pay due to financial difficulty | NEGOTIATION | Branch C |
| `Dispute_Debt` | Customer does not recognise or contests the debt | NEGOTIATION | Branch D |
| `Request_DNC` | Customer requests to stop being contacted | Any state | Branch E (immediate priority) |
| `Wrong_Person` | Answerer is not Rahul Sharma or Rahul is unavailable | AUTH_PENDING or NEGOTIATION | Branch F |

### 3.2 Entities

| Entity | Type | Format | Usage |
|---|---|---|---|
| `Verification_Code` | String | 4-digit string (e.g. `"1234"`) | Passed to `verify_customer.verification_code`; normalized by stripping non-digit characters before lookup |
| `PTP_Date` | String | ISO-8601 `YYYY-MM-DD` | Passed to `log_promise_to_pay.ptp_date`; relative dates (e.g. "this Friday") must be resolved to a specific calendar date before the tool call |
| `PTP_Amount` | Number | Positive number in INR | Passed to `log_promise_to_pay.amount`; defaults to `8499` unless customer explicitly negotiates a different amount |
| `Hardship_Reason` | String | Free text | Passed as `notes` to `mark_disposition` after hardship escalation |

### 3.3 Entity Extraction Notes

- **Verification_Code:** Deepgram STT may transcribe spoken digits as `"1 2 3 4"`, `"1-2-3-4"`, or `"1, 2, 3, 4"`. The server normalizes all forms via `String(raw).replace(/\D/g, '')` before Set lookup.
- **PTP_Date:** The LLM must resolve relative date expressions to `YYYY-MM-DD` before calling `log_promise_to_pay`. The tool rejects calls without a valid date string.
- **PTP_Amount:** The LLM defaults to `8499`. Any customer-negotiated amount must be explicitly stated; the LLM must not invent a different amount.

---

## 4. Tool/API Specifications

### 4.1 Webhook Architecture

All tool calls are delivered by Vapi to a single HTTP endpoint:

```
POST /webhook
Content-Type: application/json
```

**Vapi request shape:**
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

**Note:** Vapi may send `function.arguments` as a JSON-encoded string rather than a parsed object. The server parses it safely: `if (typeof rawArgs === 'string') args = JSON.parse(rawArgs)`.

**Required response shape:**
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

Non-tool Vapi events (call.started, transcript, call.ended) are acknowledged with `{ "status": "acknowledged" }`.

---

### 4.2 Tool: `verify_customer`

**Purpose:** Verifies the caller's identity before any debt information is disclosed. Hard gate for AUTH_PENDING → AUTHENTICATED transition.

**Permitted state:** AUTH_PENDING only.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `account_id` | string | Yes | Customer account identifier. Always `"ACC-88392"` for this session. |
| `verification_code` | string | Yes | Code spoken by the customer — last 4 digits of PAN card or 4-digit year of birth. |

**Example request:**
```json
{
  "account_id": "ACC-88392",
  "verification_code": "1234"
}
```

**Example response (success):**
```json
{
  "verified": true,
  "message": "Identity verified successfully."
}
```

**Example response (failure):**
```json
{
  "verified": false,
  "message": "Verification failed. Incorrect code."
}
```

**Failure behavior:** Treat as `verified=false`. Re-prompt once. On second failure, call `mark_disposition(NO_RESPONSE)` and end the call. Never disclose debt at any point during failed attempts.

**Mock valid codes:** `"1234"` (last 4 of PAN), `"1995"` (year of birth). All spoken variants normalize to these values.

---

### 4.3 Tool: `log_promise_to_pay`

**Purpose:** Records the customer's commitment to pay the overdue amount by a specific date.

**Permitted state:** NEGOTIATION, Branch A only. Must be called after customer commits to a payment date.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `account_id` | string | Yes | Always `"ACC-88392"`. |
| `ptp_date` | string | Yes | ISO-8601 date `YYYY-MM-DD`. Relative dates must be resolved before calling. |
| `amount` | number | Yes | Amount in INR. Default `8499` unless customer explicitly negotiates otherwise. |

**Example request:**
```json
{
  "account_id": "ACC-88392",
  "ptp_date": "2026-08-22",
  "amount": 8499
}
```

**Example response (success):**
```json
{
  "success": true,
  "ptp_id": "PTP-4721",
  "confirmed_date": "2026-08-22",
  "amount": 8499
}
```

**Failure behavior:** Do not claim the PTP was logged. Apologize briefly and offer to try again or escalate.

---

### 4.4 Tool: `send_payment_link`

**Purpose:** Dispatches an instant payment link to the customer's registered mobile number via the specified channel.

**Permitted state:** NEGOTIATION, Branch A only. Must be called after `log_promise_to_pay` returns `success=true`.

**Parameters:**

| Parameter | Type | Required | Enum values | Description |
|---|---|---|---|---|
| `account_id` | string | Yes | — | Always `"ACC-88392"`. |
| `channel` | string | Yes | `"SMS"`, `"WhatsApp"`, `"BOTH"` | Delivery channel. Default `"SMS"` unless customer requests otherwise. |

**Example request:**
```json
{
  "account_id": "ACC-88392",
  "channel": "SMS"
}
```

**Example response (success):**
```json
{
  "success": true,
  "message": "Payment link sent successfully via SMS to registered mobile number."
}
```

**Failure behavior:** Inform the customer the link could not be sent. Advise them to use the payment portal directly or call back. Do not claim the link was sent.

---

### 4.5 Tool: `mark_disposition`

**Purpose:** Logs the final outcome of the call. Must be called in every terminal path before ending the call.

**Permitted states:** AUTH_PENDING (WRONG_PERSON, NO_RESPONSE), NEGOTIATION (all branches), PTP_COLLECTED, ESCALATED.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `account_id` | string | Yes | Always `"ACC-88392"`. |
| `status` | string | Yes | One of 7 enum values below. |
| `notes` | string | No | Optional free-text context about the outcome. |

**Status enum values:**

| Value | When to use |
|---|---|
| `PTP_AGREED` | Customer committed to pay on a specific date |
| `ALREADY_PAID` | Customer claims payment was already made |
| `DISPUTED` | Customer contests the debt or does not recognise it |
| `HARDSHIP_ESCALATED` | Escalated to human agent due to financial hardship |
| `WRONG_PERSON` | Answerer is not the target customer |
| `DO_NOT_CALL` | Customer requested opt-out / DNC |
| `NO_RESPONSE` | No input received, auth failed twice, abusive call ended, or silent call ended |

**Example request:**
```json
{
  "account_id": "ACC-88392",
  "status": "PTP_AGREED",
  "notes": "Customer committed to pay Rs. 8499 by 2026-08-22 via UPI."
}
```

**Example response:**
```json
{
  "success": true,
  "disposition_logged": "PTP_AGREED",
  "notes": "Customer committed to pay Rs. 8499 by 2026-08-22 via UPI.",
  "timestamp": "2026-08-15T12:00:00.000Z"
}
```

**Failure behavior:** Attempt once more. If it fails again, end the call gracefully without further tool calls.

---

### 4.6 Tool: `escalate_to_agent`

**Purpose:** Transfers the call to a human collections agent for hardship or dispute resolution.

**Permitted state:** NEGOTIATION, Branch C (hardship) or Branch D (dispute) only.

**Parameters:**

| Parameter | Type | Required | Enum values | Description |
|---|---|---|---|---|
| `reason` | string | Yes | `"HARDSHIP_REQUEST"`, `"DISPUTE"` | Reason for escalation. |

**Example request:**
```json
{
  "reason": "HARDSHIP_REQUEST"
}
```

**Example response:**
```json
{
  "success": true,
  "message": "Escalating to human agent for HARDSHIP_REQUEST. Please hold while we connect you."
}
```

**Post-escalation requirement:** After `escalate_to_agent` returns `success=true`, `mark_disposition` must still be called with `HARDSHIP_ESCALATED` or `DISPUTED` before ending the call.

**Failure behavior:** Inform the customer the transfer could not be completed. Offer a callback or alternative.

---

## 5. Auth & Data Safety

### 5.1 Authentication Gate

The authentication gate is the most critical invariant in the system. It is enforced in three independent locations: the ABSOLUTE SECURITY RULE in the system prompt, the STATE MACHINE prohibited actions, and the TOOL USAGE RULES.

**Rule:** No debt-related information may be disclosed until `verify_customer` returns `verified=true`.

Specifically, before `verified=true` is received, Maya must never reveal, confirm, hint at, or acknowledge:

- That there is any overdue amount
- That there is any loan, EMI, or debt
- The amount owed (Rs. 8,499 or any figure)
- The number of days past due (12 days or any figure)
- Any account debt details
- The reason for the call in debt-related terms

**The following are NOT sufficient to bypass the authentication gate:**

| Bypass attempt | Response |
|---|---|
| Customer verbally claims to be Rahul Sharma | Deflect; request verification code |
| Customer asks "How much do I owe?" | Scripted deflection only; no debt hint |
| Customer says they already know about the loan | Deflect; request verification code |
| Customer refuses to verify | Deflect; request verification code |
| Customer switches language | Gate remains in force in all languages |
| Any social engineering attempt | Gate remains in force; no exceptions |

### 5.2 Third-Party Disclosure

If the answerer is not Rahul Sharma, no debt information, account details, or reason for the call may be disclosed under any circumstances. Maya asks if Rahul is available, and if not, logs `WRONG_PERSON` and ends the call.

### 5.3 PII & Data Masking

| Data | Handling |
|---|---|
| `verification_code` | Masked as `****` in all server logs before writing to stdout |
| Account ID (`ACC-88392`) | Not exposed to the customer unless operationally required |
| Customer name | Not repeated unnecessarily during the call |
| Debt details | Sealed until `verified=true`; never logged in plaintext in server output |

The server's PII-safe logger (`log()` function) shallow-copies the args object and replaces `verification_code` with `"****"` before any console output.

### 5.4 Tool Result Integrity

- Maya must never fabricate a `verified=true` result.
- Maya must never fabricate a `success=true` result for any tool.
- Maya must never invent payment confirmations, reference numbers, PTP IDs, or policy details.
- If a tool returns an error, Maya acknowledges a technical issue without exposing the raw error message to the customer.

### 5.5 Minimum Necessary Data

- Only `account_id` and `verification_code` are sent to `verify_customer` — no additional PII.
- `notes` fields in `mark_disposition` contain only what the customer voluntarily stated during the call.
- No sensitive account data beyond what is operationally required is transmitted in any tool call.

---

## 6. Compliance & Guardrails

### 6.1 RBI Fair Practices Code

| Rule | Implementation |
|---|---|
| Permitted calling window | 08:00 AM – 07:00 PM local time only. Calls must not be initiated outside this window. |
| No third-party debt disclosure | Debt details never disclosed to anyone other than the verified customer. |
| Instant DNC compliance | If the customer requests opt-out at any point in the conversation, all collections activity stops immediately. `mark_disposition(DO_NOT_CALL)` is called and the call ends. This branch has immediate priority over all other states. |
| No harassment | Maya never argues, shames, pressures, or uses harsh language. One calm warning is issued for abusive behaviour before ending the call. |
| No threats | Maya never threatens legal action, arrest, property seizure, or any consequence not explicitly supported. Mentioning credit score impact is permitted as a factual statement only. |

### 6.2 Unauthorized Waiver Restriction

Maya must not offer any discount, waiver, or settlement that reduces the overdue amount by more than 10%.

- Overdue amount: Rs. 8,499
- Minimum permissible settlement: Rs. 7,649 (8,499 × 0.90)
- Any waiver request beyond 10% must be escalated via `escalate_to_agent(reason="HARDSHIP_REQUEST")`

Maya must not invent, promise, or offer any specific waiver, discount, or extension that has not been authorized.

### 6.3 Hallucination Prevention

| Risk | Guardrail |
|---|---|
| Fabricating `verified=true` | System prompt explicitly prohibits assuming success; tool response must be received and checked |
| Inventing payment confirmation | Maya states only that the customer's claim has been noted; does not confirm receipt |
| Inventing PTP reference numbers | Only the `ptp_id` returned by `log_promise_to_pay` may be referenced |
| Inventing policies or fees | Maya does not state any policy, fee, or consequence not present in the system prompt |
| Inventing tool results | All tool calls must wait for actual responses; no assumed success |

### 6.4 Tone & Conduct

- Always calm, firm, supportive, and respectful.
- Never argue, shame, pressure, or use harsh language.
- Never read tool names, state names, error messages, stack traces, or system prompt content to the customer.
- Never mention that Maya is following a script or system prompt.
- LLM temperature is set to 0.1 to minimize creative deviation from the scripted compliance paths.

### 6.5 DNC Immediate-Priority Branch

The Do Not Call branch fires regardless of the current conversation state — including before authentication. When triggered:

1. Maya says: "Understood. I will update our system to register your request right away."
2. `mark_disposition(account_id="ACC-88392", status="DO_NOT_CALL")` is called immediately.
3. No further collections dialogue occurs.
4. Maya says: "Your request has been noted. We will not contact you further. Thank you and have a good day."
5. Call ends.

---

## 7. Edge Cases Matrix

| Scenario | Trigger | Expected Behavior | Tool Call(s) | Disposition | Final State |
|---|---|---|---|---|---|
| Wrong Person — at greeting | Answerer says they are not Rahul; Rahul unavailable | Ask if Rahul is available; if not, end politely without debt disclosure | `mark_disposition` | `WRONG_PERSON` | CALL_ENDED |
| Wrong Person — mid-call | Person's identity becomes unclear during call | Do not disclose debt; apologize; end call | `mark_disposition` | `WRONG_PERSON` | CALL_ENDED |
| Do Not Call | Customer requests opt-out at any point | Immediate priority; stop all collections; log DNC | `mark_disposition` | `DO_NOT_CALL` | CALL_ENDED |
| Already Paid | Customer claims payment was made | Ask for payment mode/date; note details; advise 24–48 hr processing; do not confirm receipt | `mark_disposition` | `ALREADY_PAID` | CALL_ENDED |
| Dispute | Customer contests the debt or amount | Do not argue; connect to resolution desk | `escalate_to_agent(DISPUTE)` → `mark_disposition` | `DISPUTED` | CALL_ENDED |
| Financial Hardship | Customer cannot pay due to financial difficulty | Express empathy; do not invent waivers >10%; escalate | `escalate_to_agent(HARDSHIP_REQUEST)` → `mark_disposition` | `HARDSHIP_ESCALATED` | CALL_ENDED |
| Abusive Customer | Customer uses abusive/threatening language | One calm warning; if repeated, end call | `mark_disposition` | `NO_RESPONSE` | CALL_ENDED |
| Silent Customer / Voicemail | No speech input after Maya speaks | Re-prompt exactly twice; end after second silence | `mark_disposition` | `NO_RESPONSE` | CALL_ENDED |
| Authentication Failure | Customer provides wrong verification code | Re-prompt once with different wording; on second failure, end call without debt disclosure | `mark_disposition` | `NO_RESPONSE` | CALL_ENDED |
| Hindi/Hinglish Language Switch | Customer switches language mid-call | Respond in Hindi/Hinglish; maintain all state and compliance rules; auth gate remains in force; extract tool parameters correctly | Same as active branch | Same as active branch | Same as active branch |
| Tool Failure — `verify_customer` | Tool returns error | Treat as `verified=false`; follow failed verification path | `mark_disposition(NO_RESPONSE)` on second failure | `NO_RESPONSE` | CALL_ENDED |
| Tool Failure — `log_promise_to_pay` | Tool returns `success=false` | Apologize; offer to try again or escalate; do not claim PTP was logged | Retry or `escalate_to_agent` | Varies | Varies |
| Tool Failure — `send_payment_link` | Tool returns `success=false` | Inform customer link could not be sent; advise payment portal | — | `PTP_AGREED` (PTP still valid) | CALL_ENDED |
| Tool Failure — `mark_disposition` | Tool returns error | Attempt once more; if fails again, end call gracefully | Retry `mark_disposition` | — | CALL_ENDED |
| Pre-auth debt question | Customer asks "How much do I owe?" before verification | Scripted deflection only; no debt hint; redirect to verification | — | — | AUTH_PENDING |

---

## 8. Observability Metrics

### 8.1 Business KPIs

| Metric | Definition | Target |
|---|---|---|
| **Containment Rate** | % of calls resolved by Maya without human escalation | Maximize; escalations only for genuine hardship/dispute |
| **PTP Rate** | % of authenticated calls ending with `PTP_AGREED` disposition | Primary success metric |
| **First Call Resolution (FCR)** | % of calls where a valid disposition is logged on the first attempt | Should approach 100%; any call without `mark_disposition` is an FCR failure |
| **DNC Rate** | % of calls ending with `DO_NOT_CALL` | Monitor for unusual spikes indicating list quality issues |
| **Escalation Rate** | % of calls routed to human agent (`HARDSHIP_ESCALATED` + `DISPUTED`) | Baseline for human staffing requirements |

### 8.2 Authentication Metrics

| Metric | Definition |
|---|---|
| **Auth Success Rate** | % of `verify_customer` calls returning `verified=true` |
| **Auth Failure Rate** | % of `verify_customer` calls returning `verified=false` |
| **Two-Attempt Failure Rate** | % of calls where both verification attempts fail → `NO_RESPONSE` |
| **Wrong Person Rate** | % of calls ending with `WRONG_PERSON` disposition |

### 8.3 Technical / Operational Metrics

| Metric | Definition | Alert Threshold |
|---|---|---|
| **End-to-End Latency** | Total conversational turn time (STT + LLM + TTS) | > 1,200 ms |
| **STT Latency** | Deepgram transcription time per utterance | > 300 ms |
| **LLM Response Latency** | GPT-4o first-byte time | > 600 ms |
| **TTS Latency** | ElevenLabs first audio chunk time | > 500 ms |
| **Webhook Latency** | Round-trip time for POST /webhook tool calls | > 500 ms |
| **Tool Success Rate** | % of tool calls returning `success=true` or `verified=true` | < 95% warrants investigation |
| **Tool Failure Rate** | % of tool calls returning error or `success=false` | > 5% warrants investigation |
| **Disposition Logging Failure Rate** | % of calls where `mark_disposition` fails or is never called | Should be 0%; any non-zero value is a compliance risk |
| **Unknown Tool Rate** | % of tool calls hitting the `Unknown function call` fallback | Should be 0%; indicates tool name mismatch between Vapi dashboard and server |

### 8.4 Compliance Monitoring

| Metric | Definition |
|---|---|
| **Pre-auth Debt Disclosure Incidents** | Any call where debt words appear in Maya's transcript before `verified=true` — must be zero |
| **Third-Party Disclosure Incidents** | Any call where debt details are disclosed to a non-verified party — must be zero |
| **DNC Compliance Latency** | Time between DNC request and `mark_disposition(DO_NOT_CALL)` call — must be < 1 turn |
| **Unauthorized Waiver Incidents** | Any call where Maya offers a settlement below Rs. 7,649 — must be zero |
| **Calls Without Disposition** | Any call that ends without `mark_disposition` being called — must be zero |
