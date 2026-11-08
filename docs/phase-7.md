# Phase 7 — Reception console

**Done when (plan):** a receptionist runs a full day in staging. ✅ Walked through in a browser as the seeded receptionist (SMS-code sign-in):
1. book a patient for today;
2. check them in and get token M-01;
3. collect ₹500 by UPI and print the receipt;
4. take a walk-in (M-02), collect cash and send them in;
5. answer a new WhatsApp enquiry;
6. refund ₹100 within the receptionist's limit;
7. close the day: net ₹900, by method and by person.

## Delivered

- [x] Migration 0007:
  - permissions: `inbox:read`, `inbox:reply` (owner, branch manager, receptionist; counsellor for their leads) and `channel:manage` (owner);
  - encrypted channel credentials;
  - webhook lookup function;
  - conversation reply window and unread count;
  - receipt counter, partial refunds and payment references;
  - payments and refunds cannot be deleted by the app;
  - walk-in tokens.
- [x] **Reception console**:
  - today's numbers;
  - arriving patients with Check in and No-show;
  - waiting room with paid/due per token;
  - "To collect" list;
  - inbox preview and your tasks.
  - Calls panel: says plainly that it fills once the AI answers the phone line.
- [x] **Walk-ins:** find or register the patient, choose doctor and service, and get a token. Walk-in tokens move to "with doctor" and "done" without an appointment.
- [x] **Desk payments:**
  - cash, UPI (reference required) or card;
  - numbered receipts (`LHS-R-00001`) and a printable receipt marked "not a tax invoice";
  - no over-collection: two desks collecting the same fee at once give one payment;
  - retried taps do not charge twice;
  - advance payments without a visit.
- [x] **Refunds:**
  - partial or full, with a reason;
  - receptionists capped by the clinic's limit; the owner and branch managers are not;
  - never more than was paid.
- [x] **Day close:** every payment, net total, totals by method and by person, any day, per branch.
- [x] **Inbox:**
  - one thread per person and number;
  - new numbers become pipeline enquiries;
  - registered patients are linked automatically;
  - assign, close and reopen;
  - masked numbers in the list.
  - WhatsApp's 24-hour rule is enforced, and the screen explains why replying is blocked.
- [x] **WhatsApp Business Cloud API (Meta):**
  - connect a number (phone number ID, access token and app secret, stored encrypted);
  - subscription check with a one-time verify token;
  - every webhook verified with `X-Hub-Signature-256` over the raw body;
  - duplicates ignored, every delivery logged in `webhook_events`;
  - delivery receipts update messages and never go backwards;
  - forged deliveries cannot block real ones.
- [x] **Test channel:** a WhatsApp or SMS channel that sends nothing outside the platform, plus "pretend a patient wrote", for training and staging. Refused in production.
- [x] 6 new tests (56 total): 2 unit tests (webhook parsing, 24-hour window) and 4 integration tests.
  - The integration tests cover desk money, branch isolation, the inbox flow, and signed webhooks (wrong secret, a body changed after signing, replays).
  - Mutation-checked: disabling the signature check or the refund limit fails a test.

## Endpoints

| Method | Path | Permission |
| --- | --- | --- |
| POST | /v1/queue/walk-in, /v1/queue/:id/in-room, /v1/queue/:id/done | appointment:manage |
| GET | /v1/payments/due, /v1/payments?date&branchId, /v1/payments/:id/receipt | payment:collect |
| POST | /v1/payments | payment:collect |
| POST | /v1/payments/:id/refund | payment:refund (limit for receptionists) |
| GET / PATCH | /v1/conversations, /v1/conversations/:id | inbox:read / inbox:reply |
| POST | /v1/conversations/:id/messages | inbox:reply |
| GET / POST / DELETE | /v1/channel-accounts | inbox:read / channel:manage |
| POST | /v1/channel-accounts/:id/simulate-inbound | inbox:reply, test channels, not in production |
| GET / POST | /v1/webhooks/whatsapp/:accountId | Meta (verify token / signature) |

## Needs your accounts

- **WhatsApp Business:** a Meta Business account, a verified WhatsApp number, a system-user access token and the app secret. Paste them into Settings › Channels and set the shown callback URL and verify token in Meta.
- **SMS:** a DLT-registered sender ID and templates (with a provider such as MSG91, Exotel or Gupshup), connected in Phase 13.
- **Razorpay:** for online payment links (Phase 13). Desk payments need nothing.

## Not in this phase

- WhatsApp templates (needed after 24 hours of silence; also reminders and confirmations): Phase 13.
- AI-drafted replies in the inbox: Phase 9 (approved knowledge).
- Live calls, hand-offs and missed calls on the console: Phase 8.
- Waiting-room display board for a TV: Phase 12 (staff apps).
