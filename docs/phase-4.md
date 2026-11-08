# Phase 4 — Clinic setup

**Done when:** an owner can set up a clinic end to end (details, branches and hours, doctors and hours, services and fees, phone choice) and finish setup; staff see only what their role allows. ✅ Met (8 Nov 2026).

## Delivered

- [x] Migration 0004: permissions `doctor:manage`, `schedule:manage`, `service:manage`; settings and onboarding columns; database checks for slot length, fees, durations, service modes, leave ranges; one doctor profile per staff account; unique active service names per department; holidays unique per day and branch
- [x] Doctor weekly hours cannot overlap: checked by the API with a readable message, and by an exclusion constraint in PostgreSQL
- [x] Doctors: add, edit, deactivate, remove (refused while they have upcoming appointments); optional link to a staff account; registration number shown as "not verified" until the platform team verifies it (a clinic cannot mark it verified)
- [x] Weekly hours: clinic sessions at a branch, video and phone sessions online; sessions outside the branch's opening hours are saved but flagged
- [x] Leave and blocked time, with a count of booked appointments that fall inside it
- [x] Services and fees in paise; "after assessment" fees; the AI may only say a fee that is set and allowed; clearing a fee switches quoting off; fee changes audited with before/after
- [x] Doctor-specific fees per service
- [x] Clinic settings: recording and transcript on/off and retention, AI pickup mode and delay, follow-up calling window, receptionist refund limit, payment at booking, cancellation policy, phone setup choice
- [x] Holidays per branch or for all branches
- [x] Onboarding checklist computed from real data; "Finish setup" refused until steps 1–5 are done
- [x] Web: six-step setup wizard (save and exit at any step), Settings with 10 working sections, home card with setup progress
- [x] CI: actions moved to Node 24 versions (checkout v7, setup-node v7, pnpm/action-setup v6), runner pinned to ubuntu-26.04
- [x] 6 new integration tests (29 total); mutation-checked: removing the branch-scope check or the fee-quoting rule makes a test fail
- [x] Browser walkthrough of the full setup as the demo owner

## Who can change what

| Action | Owner | Branch manager | Doctor | Receptionist |
| --- | --- | --- | --- | --- |
| See doctors, services, settings, holidays | ✓ | ✓ | ✓ | ✓ |
| Add or edit doctors, doctor services | ✓ | — | — | — |
| Weekly hours | all | sessions at own branches | own | — |
| Leave | all | doctors who work at own branches | own | — |
| Services and fees | ✓ | — | — | — |
| Clinic settings, finish setup | ✓ | — | — | — |
| Holidays | all | own branches | — | — |

## Endpoints

| Method | Path | Permission |
| --- | --- | --- |
| GET | /v1/doctors, /v1/doctors/:id | org:read |
| POST, PATCH, DELETE | /v1/doctors, /v1/doctors/:id | doctor:manage |
| PUT | /v1/doctors/:id/schedule | schedule:manage (org / branch / own) |
| POST, DELETE | /v1/doctors/:id/leave, /v1/doctors/:id/leave/:leaveId | schedule:manage |
| PUT | /v1/doctors/:id/services | doctor:manage |
| GET | /v1/services | org:read |
| POST, PATCH | /v1/services, /v1/services/:id | service:manage |
| GET / PATCH | /v1/settings | org:read / org:update |
| GET / POST / DELETE | /v1/holidays | org:read / branch:manage |
| GET | /v1/onboarding | org:read |
| POST | /v1/onboarding/complete | org:update |

## Not in this phase (stated in the UI where it matters)

- Phone numbers and call forwarding (telephony release). The phone step stores the choice only; the AI does not answer calls.
- Logo and doctor photo upload (file storage arrives with documents).
- Service import from a spreadsheet.
- Moving appointments affected by leave (calendar release).
- Custom roles (built-in roles are listed read-only).
- Invitation SMS/WhatsApp messages (messaging release).
