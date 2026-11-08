# Phase 6 — CRM, waiting room, scheduling completed

**Numbering note.** The Phase 2 build plan has Phase 5 = *Patients and CRM* and Phase 6 = *Scheduling engine*. The release called "Phase 5" delivered most of the plan's scheduling work plus the patient directory. This release completes both, so the code is now in step with the plan: Phases 3–6 are done and Phase 7 (reception console) is next.

**Done when (plan):**
- Phase 5: a lead moves from enquiry to booked with a full timeline. ✅
- Phase 6: 50 parallel bookings, zero double-bookings. ✅ Two tests: 50 requests for one slot give exactly 1 booking, and 50 mixed 20/60-minute requests over overlapping times leave no two live appointments overlapping.

## Delivered

- [x] Migration 0006: `lead:read` permission for owner, branch manager, receptionist (branch) and counsellor (assigned); lead phone (encrypted), branch, "wants a visit by", creator; lead event notes; task creator/completer; consent recorder check; queue token timing and one token per appointment
- [x] **Leads:** add (name and/or number, interest, source, owner, follow-up date), one open lead per number, automatic link to a registered patient with the same number and name, edit, stage changes (lost needs a reason), notes, "register as patient" in one step
- [x] **Automatic stages:** booking a visit moves the patient's open enquiry to Booked; completing the visit moves it to Consulted. Shown as "automatic" in the history
- [x] **Scoring:** transparent rules (named a service +20, visit within 7 days +15, referred +15, visit booked +25, returning +10, no activity for 5 days −15), score 0–100 with a per-lead breakdown; the owner can change points or switch rules off; conditions are a fixed, validated set (no free-form expressions)
- [x] **Tasks:** for a person or a whole role, with due date and priority, linked to a lead, patient or appointment; "Your tasks" on Home; closed tasks cannot be reopened
- [x] **Consents:** append-only ledger per patient (data processing for care, WhatsApp updates, AI follow-up calls, marketing); current state + full history; the API's database login cannot update or delete consent rows
- [x] **Patient view:** timeline (visits and their changes, pipeline events, notes, tasks, consents), pipeline and tasks card, consents card
- [x] **Patient directory:** numbers masked in lists (98•• ••• 451) unless you searched by that number; last visit, next visit, source; "has an upcoming visit" filter
- [x] **Waiting room:** check-in issues a token (doctor's surname initial + number per branch and day, e.g. M-01); call, send in, reorder, mark left; tokens follow the visit (with doctor → done); shown on the Calendar for today
- [x] **Counsellors** see their own and unassigned leads and the patients behind their leads; they cannot assign leads to colleagues
- [x] 9 new tests (50 total): 2 unit tests for scoring, 7 integration tests; mutation-checked (widening the counsellor scope or removing the automatic "booked" move fails a test)

## Endpoints

| Method | Path | Permission |
| --- | --- | --- |
| GET / POST | /v1/leads | lead:read / lead:manage |
| GET / PATCH | /v1/leads/:id | lead:read / lead:manage |
| POST | /v1/leads/:id/stage, /notes, /patient | lead:manage |
| GET | /v1/lead-scoring-rules | lead:read |
| POST / PATCH | /v1/lead-scoring-rules, /:id | org:update |
| GET / POST / PATCH | /v1/tasks, /v1/tasks/:id | signed-in member (sees own, own role's and created tasks; owner sees all) |
| GET / POST | /v1/patients/:id/consents | patient:read / patient:manage |
| GET | /v1/patients/:id/timeline | patient:read |
| GET | /v1/queue?branchId&date | appointment:read |
| POST | /v1/queue/:id/call, /left, /v1/queue/reorder | appointment:manage |

## Not in this phase

- AI-owned leads are labelled, but AI follow-up calls start with the AI release (Phase 8–9), and only for patients with recorded consent.
- "Answered on 2+ channels" and "no reply" scoring need the inbox (Phase 7) and calls (Phase 8).
- Walk-ins without an appointment and the display board are part of the reception console (Phase 7).
- Patient data export and deletion requests (Phase 15 with the DPDP review).
