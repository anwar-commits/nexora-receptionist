# Phase 5 — Patients, calendar and appointments

> This release covered most of the plan's Phase 6 (scheduling engine) and the patient directory from Phase 5. The rest of both is in [phase-6.md](phase-6.md).

**Done when:** staff can register a patient, see free times that respect hours, leave, holidays and existing bookings, book without double-booking, and run the visit from booking to completion. ✅ Met (8 Nov 2026).

## Delivered

- [x] Migration 0005: row-level security on `app.patients` (a clinic sees only people it registered or has a profile for); clinic patient IDs (e.g. `LHS-1001`) from a per-clinic counter; appointment checks (bounded slot, clinic visits need a branch, fee ≥ 0); status change tracking; hold details
- [x] Patients: register, search (full mobile number, patient ID, part of name), view, edit. Mobile numbers stored encrypted, looked up by keyed hash. Same number + same name is refused as a duplicate (families sharing one number are fine)
- [x] Every read of a patient record is written to `data_access_logs` (who, which patient, purpose)
- [x] Free-slot engine (`apps/api/src/lib/availability.ts`): pure function, clinic time zone, weekly hours with validity dates, slot length, gap between patients, service duration, leave and blocks, clinic-wide and branch holidays, video/phone daily cap, lead time
- [x] Slot holds (5 minutes) for callers deciding; booking with a hold releases it
- [x] Booking only on a free slot; per-doctor lock plus the database exclusion constraint: in the test, 10 simultaneous requests for one slot give exactly 1 booking
- [x] Idempotent booking (`idempotencyKey`): a retried request returns the same appointment
- [x] Fee taken from the doctor's own fee for the service, else the standard fee
- [x] Lifecycle: confirm, check in (clinic visits, on the day only), with doctor, complete, no-show (only after the start time), cancel (reason required), reschedule (old kept as "moved", new linked to it)
- [x] Appointments clashing with leave or a holiday listed for staff to move
- [x] Scopes inside a clinic: branch staff see appointments at their branches (and online consults of doctors who work there) and patients of their branches; doctors see only their own appointments and patients
- [x] Web: calendar day view (doctor columns, clinic/online hours shaded, current-time line, branch filter), booking panel (find or register patient → service → doctor → visit type → free times), appointment panel with actions, patients list and patient page, home "Today" card
- [x] Favicon (removes the last console error)
- [x] 12 new tests (41 total): 5 unit tests for the slot engine, 7 integration tests; mutation-checked (removing the branch filter or the patients RLS policy fails a test)

## Endpoints

| Method | Path | Permission |
| --- | --- | --- |
| GET | /v1/patients?q= | patient:read |
| POST | /v1/patients | patient:manage |
| GET / PATCH | /v1/patients/:id | patient:read / patient:manage |
| GET | /v1/availability?doctorId&serviceId&mode&from&days&branchId | appointment:read |
| POST / DELETE | /v1/holds, /v1/holds/:id | appointment:manage |
| GET | /v1/appointments?from&to&doctorId&branchId&patientProfileId | appointment:read |
| GET | /v1/appointments/attention | appointment:read |
| GET | /v1/appointments/:id | appointment:read |
| POST | /v1/appointments | appointment:manage |
| POST | /v1/appointments/:id/status, /cancel, /reschedule | appointment:manage |

## Decisions

- **Patients are private per clinic for now.** `app.patients` was designed to be shared across clinics for the patient app. Until a patient links clinics themselves (by OTP in the patient app), each clinic creates its own person record and cannot see others'.
- **Clinic-wide patients.** A patient with no home branch (e.g. registered by the owner) is visible to all branches of that clinic.
- **Search by full number.** Numbers are encrypted, so partial-number search is not possible; name and patient ID search work on parts.
- **The gap between patients** is enforced by the slot engine; the database constraint prevents true overlaps.

## Not in this phase

- Reception queue tokens and waiting-room display (next phase).
- Booking by the AI receptionist (uses the same slot engine and holds; telephony release).
- Reminders and confirmations by SMS/WhatsApp (messaging release).
- Video links (video release); payments at booking (payments release).
- Week view and drag-to-move on the calendar.
