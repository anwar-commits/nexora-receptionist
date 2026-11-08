# Phase 8 — AI voice receptionist

## How a call works
1. A caller rings the clinic's Exotel or Plivo number. Exotel is connected natively in ElevenLabs; Plivo connects as a SIP trunk.
2. ElevenLabs calls our **call-start webhook** (`POST /v1/voice/elevenlabs/initiation`, header `X-DR-Secret`). It creates the call row, keeps the caller's number only encrypted and hashed, and returns the greeting. The greeting says the caller is speaking to an AI and that the call may be recorded. It also returns `dr_call_id`.
3. On every turn ElevenLabs sends the conversation to **our** OpenAI-compatible endpoint, `POST /v1/voice/llm/:agentId/chat/completions`. The request carries a per-agent key, which our database stores only as a keyed hash. ElevenLabs only handles speech. The prompt, tools and safety rules never leave our server.
4. Each turn runs in a fixed order (`src/voice/brain.ts`):
   1. **Red-flag check**, in code (`safety.ts`), in English, Hindi, Hinglish, Bengali and Urdu. If it fires (an emergency or self-harm):
      - the caller hears the approved 112 / Tele-MANAS 14416 script, and the model is not asked;
      - reception gets an urgent task and a hand-off;
      - booking is locked for the rest of the call.
   2. **Claude with tools**, at most 5 rounds. The tools run here, against the real calendar (`tools.ts`).
   3. **Output guard**: replies with doses, medicine advice, diagnoses or promised results are replaced before they are spoken, and the block is logged.
5. After the call, the **post-call webhook** (`POST /v1/voice/elevenlabs/post-call`) arrives. It is HMAC-signed and replays are rejected. It stores:
   - the transcript;
   - a summary, made by Claude if a key is set, otherwise taken from ElevenLabs;
   - the audio, encrypted (AES-256-GCM). It is deleted after the clinic's retention period by `pnpm --filter @dr/api recordings:purge`, which should be run daily.

## Rules enforced by the server, not the prompt
- Booking needs:
  - an active hold made on this call (one hold per call);
  - `confirmed_by_caller: true`;
  - a slot that is still free.
  Bookings are idempotent and recorded with `booked_by_kind = ai_agent` and `source_call_id`.
- A caller can only see or change appointments of patients registered to their own number. Cancelling or moving one also needs the patient's date of birth.
- Consent is recorded only for registered patients.
- The AI quotes a fee only for services where the clinic set "AI may quote fee".
- Every tool call is logged in `tool_invocations`, with dates of birth masked.

## Going live
1. The owner (or an AI-ops user) saves the settings.
2. Running the **40-case safety suite** saves the settings as a version and tests it. The suite has:
   - 35 deterministic cases;
   - 5 conversations judged against the real model.
   Each case runs in a rolled-back transaction with throw-away fixtures, so the clinic's calendar is never touched.
3. A **doctor or the owner approves the emergency protocol**. Changing the emergency transfer number clears the approval.
4. **Go live.** The database refuses to publish a version that has not passed the suite. Publishing also:
   - rotates the per-agent key;
   - creates or updates the ElevenLabs agent;
   - imports the phone numbers and assigns them to the agent.

Without `ANTHROPIC_API_KEY`, the 5 model cases are skipped, so nothing can go live. This is deliberate.

## Server configuration
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | The model that writes the replies. |
| `ELEVENLABS_API_KEY` | ElevenLabs account key. |
| `ELEVENLABS_BASE_URL` | Defaults to the India deployment, `https://api.in.residency.elevenlabs.io`, which Indian numbers need. |
| `PUBLIC_API_URL` | Where ElevenLabs reaches this API. |
| `ELEVENLABS_INIT_SECRET` | Must match the header configured on the call-start webhook in ElevenLabs. |
| `ELEVENLABS_WEBHOOK_SECRET` | Secret for the post-call webhook, which is set up in the ElevenLabs workspace settings. |
| `RECORDINGS_DIR` | Where encrypted audio is stored. Local disk; an S3 store fits the same interface. |

## Not yet verified against live accounts
These follow ElevenLabs' published API, but have not been run against a real account:
- the ElevenLabs request shapes (agent create/update, secrets, phone import, `built_in_tools`, `workspace_overrides`);
- how ElevenLabs passes `transfer_to_number` arguments.

The first real test call should confirm them. Phase 8 is done only once a real inbound call books an appointment.

## Screens
- **AI Receptionist** (sidebar): server connections, settings, emergency scripts and sign-off, the safety suite and versions, a test console (runs against the real calendar, then rolls everything back), and phone numbers. Doctors see only the emergency sign-off.
- **Calls**: the list, plus a detail drawer with summary, transcript, recording (each play is logged), tool actions and safety-event review.
- **Reception → Calls needing a person**: hand-offs with emergencies first. Staff can pick one up ("I'll call back") or close it with a note, which also closes the task.
