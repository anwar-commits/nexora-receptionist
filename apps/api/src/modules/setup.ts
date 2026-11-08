import {
  WEEKDAYS, doctorBody, doctorServicesBody, holidayBody, leaveBody, scheduleBody, serviceBody, settingsBody,
  updateDoctorBody, updateServiceBody, type OnboardingStatus, type ScheduleRuleInput,
} from '@dr/contracts';
import {
  Branch, Department, Doctor, DoctorService, Holiday, Membership, Op, Organization, OrganizationSettings, QueryTypes,
  ScheduleException, ScheduleRule, Service, UniqueConstraintError,
} from '@dr/db';
import { Router, type Request } from 'express';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';

/**
 * Phase 4: everything a clinic sets up before the AI can take calls —
 * doctors, weekly hours and leave, services and fees, clinic settings, holidays,
 * and the onboarding checklist that ties them together.
 */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hhmm = (t: string) => t.slice(0, 5);
const num = (v: string | number | null) => (v === null ? null : Number(v));
const badRequest = (message: string, details?: unknown) => new HttpError(400, 'validation_failed', message, details);

// ---------- JSON shapes ----------
const doctorJson = (d: Doctor) => ({
  id: d.id, userId: d.userId, departmentId: d.departmentId, displayName: d.displayName,
  qualifications: d.qualifications, registrationNumber: d.registrationNumber, registrationCouncil: d.registrationCouncil,
  registrationVerified: !!d.registrationVerifiedAt, yearsExperience: d.yearsExperience, languages: d.languages,
  bioApproved: d.bioApproved, slotMinutes: d.slotMinutes, bufferMinutes: d.bufferMinutes, maxOnlinePerDay: d.maxOnlinePerDay,
  bookableByAi: d.bookableByAi, isActive: d.isActive,
});
const ruleJson = (r: ScheduleRule) => ({
  id: r.id, weekday: r.weekday, start: hhmm(r.startLocal), end: hhmm(r.endLocal), mode: r.mode, branchId: r.branchId,
});
const serviceJson = (s: Service) => ({
  id: s.id, departmentId: s.departmentId, name: s.name, durationMinutes: s.durationMinutes, feePaise: num(s.feePaise),
  aiMayQuoteFee: s.aiMayQuoteFee, modes: s.modes, isActive: s.isActive,
});
const leaveJson = (e: ScheduleException) => ({
  id: e.id, kind: e.kind, startsAt: e.during[0].value, endsAt: e.during[1].value, reason: e.reason,
});
const settingsJson = (s: OrganizationSettings) => ({
  recordingEnabled: s.recordingEnabled, transcriptEnabled: s.transcriptEnabled,
  recordingRetentionDays: s.recordingRetentionDays, transcriptRetentionDays: s.transcriptRetentionDays,
  aiPickupMode: s.aiPickupMode, aiPickupAfterSeconds: s.aiPickupAfterSeconds,
  outboundStartLocal: hhmm(s.outboundStartLocal), outboundEndLocal: hhmm(s.outboundEndLocal),
  refundLimitReceptionistPaise: Number(s.refundLimitReceptionistPaise), prepayPolicy: s.prepayPolicy,
  cancellationPolicyText: s.cancellationPolicyText, freeCancellationHours: s.freeCancellationHours,
  phoneSetupChoice: s.phoneSetupChoice, onboardingCompletedAt: s.onboardingCompletedAt,
});

type Rule = Pick<ScheduleRuleInput, 'weekday' | 'start' | 'end' | 'mode' | 'branchId'>;

/** Returns a readable message for the first pair of sessions that overlap on the same day, if any. */
export function findOverlap(rules: Rule[]): string | null {
  const byDay = new Map<number, Rule[]>();
  for (const r of rules) byDay.set(r.weekday, [...(byDay.get(r.weekday) ?? []), r]);
  for (const [day, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.start < sorted[i - 1]!.end) {
        return `${DAY_NAMES[day]}: ${sorted[i - 1]!.start}–${sorted[i - 1]!.end} overlaps ${sorted[i]!.start}–${sorted[i]!.end}`;
      }
    }
  }
  return null;
}

/** Clinic sessions that fall outside their branch's opening hours. Saved, but flagged. */
function hoursWarnings(rules: Rule[], branches: Map<string, Branch>): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (!r.branchId) continue;
    const b = branches.get(r.branchId);
    if (!b || Object.keys(b.openingHours ?? {}).length === 0) continue;
    const periods = b.openingHours[WEEKDAYS[r.weekday]!] ?? [];
    const inside = periods.some(([open, close]) => open <= r.start && r.end <= close);
    if (!inside) out.push(`${DAY_NAMES[r.weekday]} ${r.start}–${r.end} is outside ${b.name}'s opening hours`);
  }
  return out;
}

export function setupRouter(deps: Deps): Router {
  const { db } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const orgId = (req: Request) => req.ctx!.org!.id;

  async function loadDoctor(id: string): Promise<Doctor> {
    const d = await Doctor.findOne({ where: { id, deletedAt: null } });
    if (!d) throw notFound('Doctor not found');
    return d;
  }

  /**
   * What part of a doctor's schedule this member may edit:
   * 'all', or only sessions at some branches (branch managers). Throws if nothing.
   */
  async function scheduleAccess(req: Request, d: Doctor, purpose: 'hours' | 'leave' = 'hours'): Promise<'all' | string[]> {
    const g = grant(req, 'schedule:manage');
    if (g.scope === 'org') return 'all';
    if (g.scope === 'own') {
      if (d.userId && d.userId === req.ctx!.userId) return 'all';
      throw forbidden('You can only change your own hours');
    }
    const mine = req.ctx!.org!.branchIds;
    if (mine.length === 0) return 'all';
    if (g.scope !== 'branch') throw forbidden();
    // Hours: a branch manager may add or change sessions at their branches for any doctor.
    if (purpose === 'hours') return mine;
    // Leave blocks the doctor everywhere, so only if they work at one of the manager's branches.
    const there = await ScheduleRule.count({ where: { doctorId: d.id, branchId: mine } });
    if (there > 0) return mine;
    throw forbidden('This doctor does not work at your branches');
  }

  async function assertDepartment(id: string | null | undefined) {
    if (id && !(await Department.findByPk(id))) throw badRequest('Unknown department');
  }

  async function assertStaffAccount(req: Request, userId: string | null | undefined) {
    if (!userId) return;
    const m = await Membership.findOne({ where: { organizationId: orgId(req), userId, status: ['active', 'invited'] } });
    if (!m) throw badRequest('That person is not on this clinic’s staff');
  }

  // =====================================================================
  // Doctors
  // =====================================================================
  r.get('/doctors', user, org, requirePermission('org:read'), async (req, res) => {
    const includeInactive = req.query.includeInactive === '1';
    const items = await inOrg(req, async () => {
      const docs = await Doctor.findAll({
        where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
        order: [['displayName', 'ASC']],
      });
      const ids = docs.map((d) => d.id);
      const rules = ids.length ? await ScheduleRule.findAll({ where: { doctorId: ids }, order: [['weekday', 'ASC'], ['startLocal', 'ASC']] }) : [];
      const links = ids.length ? await DoctorService.findAll({ where: { doctorId: ids } }) : [];
      return docs.map((d) => {
        const mine = rules.filter((x) => x.doctorId === d.id);
        return {
          ...doctorJson(d),
          weeklyHours: mine.map(ruleJson),
          modes: [...new Set(mine.map((x) => x.mode))],
          branchIds: [...new Set(mine.map((x) => x.branchId).filter((x): x is string => !!x))],
          serviceIds: links.filter((l) => l.doctorId === d.id).map((l) => l.serviceId),
        };
      });
    });
    res.json({ items });
  });

  r.get('/doctors/:id', user, org, requirePermission('org:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const d = await loadDoctor(String(req.params.id));
      const rules = await ScheduleRule.findAll({ where: { doctorId: d.id }, order: [['weekday', 'ASC'], ['startLocal', 'ASC']] });
      const links = await DoctorService.findAll({ where: { doctorId: d.id } });
      const leave = await db.sequelize.query<{ id: string }>(
        `SELECT id FROM app.schedule_exceptions WHERE doctor_id = :id AND upper(during) > now() ORDER BY lower(during)`,
        { replacements: { id: d.id }, type: QueryTypes.SELECT },
      );
      const leaveRows = leave.length ? await ScheduleException.findAll({ where: { id: leave.map((x) => x.id) } }) : [];
      leaveRows.sort((a, b) => +a.during[0].value - +b.during[0].value);
      return {
        ...doctorJson(d),
        weeklyHours: rules.map(ruleJson),
        services: links.map((l) => ({ serviceId: l.serviceId, feeOverridePaise: num(l.feeOverridePaise) })),
        upcomingLeave: leaveRows.map(leaveJson),
      };
    });
    res.json(out);
  });

  r.post('/doctors', user, org, requirePermission('doctor:manage'), async (req, res) => {
    const body = parse(doctorBody, req.body);
    const d = await inOrg(req, async () => {
      await assertDepartment(body.departmentId);
      await assertStaffAccount(req, body.userId);
      try {
        const created = await Doctor.create({
          organizationId: orgId(req), userId: body.userId ?? null, departmentId: body.departmentId ?? null,
          displayName: body.displayName, qualifications: body.qualifications ?? null,
          registrationNumber: body.registrationNumber ?? null, registrationCouncil: body.registrationCouncil ?? null,
          yearsExperience: body.yearsExperience ?? null, languages: body.languages, bioApproved: body.bioApproved ?? null,
          slotMinutes: body.slotMinutes, bufferMinutes: body.bufferMinutes, maxOnlinePerDay: body.maxOnlinePerDay ?? null,
          bookableByAi: body.bookableByAi,
        });
        await auditFromReq(req, { action: 'doctor.create', targetType: 'doctor', targetId: created.id, details: { name: created.displayName } });
        return created;
      } catch (e) {
        if (e instanceof UniqueConstraintError) throw conflict('This staff account already has a doctor profile');
        throw e;
      }
    });
    res.status(201).json({ ...doctorJson(d), weeklyHours: [], services: [], upcomingLeave: [] });
  });

  r.patch('/doctors/:id', user, org, requirePermission('doctor:manage'), async (req, res) => {
    const body = parse(updateDoctorBody, req.body);
    const d = await inOrg(req, async () => {
      const found = await loadDoctor(String(req.params.id));
      if (body.departmentId !== undefined) await assertDepartment(body.departmentId);
      if (body.userId !== undefined) await assertStaffAccount(req, body.userId);
      // Registration verification is done by the platform team, never by the clinic itself.
      const changingRegistration = (body.registrationNumber !== undefined && body.registrationNumber !== found.registrationNumber)
        || (body.registrationCouncil !== undefined && body.registrationCouncil !== found.registrationCouncil);
      try {
        await found.update({ ...body, ...(changingRegistration ? { registrationVerifiedAt: null } : {}) });
      } catch (e) {
        if (e instanceof UniqueConstraintError) throw conflict('This staff account already has a doctor profile');
        throw e;
      }
      await auditFromReq(req, { action: 'doctor.update', targetType: 'doctor', targetId: found.id, details: { fields: Object.keys(body) } });
      return found;
    });
    res.json(doctorJson(d));
  });

  /** Removes a doctor from the clinic's directory. Refused while they still have upcoming appointments. */
  r.delete('/doctors/:id', user, org, requirePermission('doctor:manage'), async (req, res) => {
    await inOrg(req, async () => {
      const d = await loadDoctor(String(req.params.id));
      const [row] = await db.sequelize.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.appointments WHERE doctor_id = :id AND upper(slot) > now()
           AND status IN ('held','booked','confirmed','checked_in','in_consultation')`,
        { replacements: { id: d.id }, type: QueryTypes.SELECT },
      );
      const upcoming = Number(row?.n ?? 0);
      if (upcoming > 0) throw conflict(`${d.displayName} has ${upcoming} upcoming appointment(s). Move or cancel them first.`);
      await d.update({ deletedAt: new Date(), isActive: false });
      await auditFromReq(req, { action: 'doctor.remove', targetType: 'doctor', targetId: d.id, details: { name: d.displayName } });
    });
    res.status(204).end();
  });

  // ---------- weekly hours ----------
  /**
   * Replaces the doctor's weekly hours. Branch managers replace only the sessions at their
   * branches; everything else in the week is kept and still checked for overlaps.
   */
  r.put('/doctors/:id/schedule', user, org, requirePermission('schedule:manage'), async (req, res) => {
    const body = parse(scheduleBody, req.body);
    const out = await inOrg(req, async () => {
      const d = await loadDoctor(String(req.params.id));
      const access = await scheduleAccess(req, d);
      const existing = await ScheduleRule.findAll({ where: { doctorId: d.id } });

      let kept: ScheduleRule[] = [];
      if (access !== 'all') {
        const outside = body.rules.find((x) => !x.branchId || !access.includes(x.branchId));
        if (outside) throw forbidden('You can only edit clinic sessions at your branches');
        kept = existing.filter((x) => !x.branchId || !access.includes(x.branchId));
      }

      const branchIds = [...new Set(body.rules.map((x) => x.branchId).filter((x): x is string => !!x))];
      const branches = branchIds.length ? await Branch.findAll({ where: { id: branchIds, deletedAt: null } }) : [];
      if (branches.length !== branchIds.length) throw badRequest('Unknown branch');
      const closed = branches.find((b) => !b.isActive);
      if (closed) throw badRequest(`${closed.name} is closed. Reopen it before adding sessions there.`);

      const overlap = findOverlap([...kept.map(ruleJson), ...body.rules]);
      if (overlap) throw conflict(`Sessions overlap — ${overlap}`);

      const replaced = existing.filter((x) => !kept.includes(x));
      if (replaced.length) await ScheduleRule.destroy({ where: { id: replaced.map((x) => x.id) } });
      for (const x of body.rules) {
        await ScheduleRule.create({
          organizationId: orgId(req), doctorId: d.id, branchId: x.branchId, weekday: x.weekday,
          startLocal: x.start, endLocal: x.end, mode: x.mode,
        });
      }
      await auditFromReq(req, { action: 'doctor.schedule.update', targetType: 'doctor', targetId: d.id, details: { removed: replaced.length, added: body.rules.length } });

      const all = await ScheduleRule.findAll({ where: { doctorId: d.id }, order: [['weekday', 'ASC'], ['startLocal', 'ASC']] });
      const allBranches = await Branch.findAll({ where: { deletedAt: null } });
      return {
        weeklyHours: all.map(ruleJson),
        warnings: hoursWarnings(body.rules, new Map(allBranches.map((b) => [b.id, b]))),
      };
    });
    res.json(out);
  });

  // ---------- leave ----------
  r.post('/doctors/:id/leave', user, org, requirePermission('schedule:manage'), async (req, res) => {
    const body = parse(leaveBody, req.body);
    const out = await inOrg(req, async () => {
      const d = await loadDoctor(String(req.params.id));
      await scheduleAccess(req, d, 'leave');
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      if (endsAt.getTime() - startsAt.getTime() > 366 * 86_400_000) throw badRequest('Leave can be at most a year at a time');
      const e = await ScheduleException.create({
        organizationId: orgId(req), doctorId: d.id, kind: body.kind,
        during: [{ value: startsAt, inclusive: true }, { value: endsAt, inclusive: false }],
        reason: body.reason ?? null, createdBy: req.ctx!.userId,
      });
      // Appointments already booked in this window are counted, not moved: rescheduling arrives with the calendar.
      const [row] = await db.sequelize.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.appointments WHERE doctor_id = :id AND slot && tstzrange(:a, :b)
           AND status IN ('held','booked','confirmed')`,
        { replacements: { id: d.id, a: startsAt.toISOString(), b: endsAt.toISOString() }, type: QueryTypes.SELECT },
      );
      await auditFromReq(req, { action: 'doctor.leave.create', targetType: 'doctor', targetId: d.id, details: { kind: body.kind, startsAt, endsAt } });
      return { ...leaveJson(e), affectedAppointments: Number(row?.n ?? 0) };
    });
    res.status(201).json(out);
  });

  r.delete('/doctors/:id/leave/:leaveId', user, org, requirePermission('schedule:manage'), async (req, res) => {
    await inOrg(req, async () => {
      const d = await loadDoctor(String(req.params.id));
      await scheduleAccess(req, d, 'leave');
      const e = await ScheduleException.findOne({ where: { id: String(req.params.leaveId), doctorId: d.id } });
      if (!e) throw notFound('Leave not found');
      await e.destroy();
      await auditFromReq(req, { action: 'doctor.leave.delete', targetType: 'doctor', targetId: d.id, details: { leaveId: e.id } });
    });
    res.status(204).end();
  });

  // ---------- which services a doctor offers ----------
  r.put('/doctors/:id/services', user, org, requirePermission('doctor:manage'), async (req, res) => {
    const body = parse(doctorServicesBody, req.body);
    const items = await inOrg(req, async () => {
      const d = await loadDoctor(String(req.params.id));
      const ids = [...new Set(body.items.map((x) => x.serviceId))];
      if (ids.length !== body.items.length) throw badRequest('A service is listed twice');
      const found = ids.length ? await Service.count({ where: { id: ids, isActive: true } }) : 0;
      if (found !== ids.length) throw badRequest('Unknown or inactive service');
      await DoctorService.destroy({ where: { doctorId: d.id } });
      for (const x of body.items) {
        await DoctorService.create({ doctorId: d.id, serviceId: x.serviceId, organizationId: orgId(req), feeOverridePaise: x.feeOverridePaise === null ? null : String(x.feeOverridePaise) });
      }
      await auditFromReq(req, { action: 'doctor.services.update', targetType: 'doctor', targetId: d.id, details: { count: ids.length } });
      return body.items;
    });
    res.json({ items });
  });

  // =====================================================================
  // Services and fees
  // =====================================================================
  r.get('/services', user, org, requirePermission('org:read'), async (req, res) => {
    const includeInactive = req.query.includeInactive === '1';
    const rows = await inOrg(req, () => Service.findAll({
      where: includeInactive ? {} : { isActive: true },
      order: [['name', 'ASC']],
    }));
    res.json({ items: rows.map(serviceJson) });
  });

  r.post('/services', user, org, requirePermission('service:manage'), async (req, res) => {
    const body = parse(serviceBody, req.body);
    const s = await inOrg(req, async () => {
      await assertDepartment(body.departmentId);
      try {
        const created = await Service.create({
          organizationId: orgId(req), departmentId: body.departmentId ?? null, name: body.name,
          durationMinutes: body.durationMinutes, feePaise: body.feePaise === null ? null : String(body.feePaise),
          aiMayQuoteFee: body.aiMayQuoteFee, modes: body.modes,
        });
        await auditFromReq(req, { action: 'service.create', targetType: 'service', targetId: created.id, details: { name: created.name, feePaise: body.feePaise } });
        return created;
      } catch (e) {
        if (e instanceof UniqueConstraintError) throw conflict('A service with this name already exists in this department');
        throw e;
      }
    });
    res.status(201).json(serviceJson(s));
  });

  r.patch('/services/:id', user, org, requirePermission('service:manage'), async (req, res) => {
    const body = parse(updateServiceBody, req.body);
    const s = await inOrg(req, async () => {
      const found = await Service.findByPk(String(req.params.id));
      if (!found) throw notFound('Service not found');
      if (body.departmentId !== undefined) await assertDepartment(body.departmentId);
      const nextFee = body.feePaise !== undefined ? body.feePaise : num(found.feePaise);
      // Clearing the fee also stops the AI quoting it.
      const nextQuote = body.feePaise === null ? false : (body.aiMayQuoteFee ?? found.aiMayQuoteFee);
      if (nextQuote && nextFee === null) throw badRequest('The AI can only quote a fee that is set');
      const before = { feePaise: num(found.feePaise), aiMayQuoteFee: found.aiMayQuoteFee };
      try {
        const { feePaise, ...rest } = body;
        await found.update({
          ...rest,
          ...(feePaise !== undefined ? { feePaise: feePaise === null ? null : String(feePaise) } : {}),
          aiMayQuoteFee: nextQuote,
        });
      } catch (e) {
        if (e instanceof UniqueConstraintError) throw conflict('A service with this name already exists in this department');
        throw e;
      }
      if (body.isActive === false) await DoctorService.destroy({ where: { serviceId: found.id } });
      await auditFromReq(req, {
        action: 'service.update', targetType: 'service', targetId: found.id,
        details: { fields: Object.keys(body), before, after: { feePaise: num(found.feePaise), aiMayQuoteFee: found.aiMayQuoteFee } },
      });
      return found;
    });
    res.json(serviceJson(s));
  });

  // =====================================================================
  // Clinic settings (calls, recording, payments, cancellation)
  // =====================================================================
  r.get('/settings', user, org, requirePermission('org:read'), async (req, res) => {
    const s = await inOrg(req, () => OrganizationSettings.findByPk(orgId(req)));
    if (!s) throw notFound();
    res.json(settingsJson(s));
  });

  r.patch('/settings', user, org, requirePermission('org:update'), async (req, res) => {
    const body = parse(settingsBody, req.body);
    const s = await inOrg(req, async () => {
      const found = await OrganizationSettings.findByPk(orgId(req));
      if (!found) throw notFound();
      const start = body.outboundStartLocal ?? hhmm(found.outboundStartLocal);
      const end = body.outboundEndLocal ?? hhmm(found.outboundEndLocal);
      if (end <= start) throw badRequest('The calling window must end after it starts');
      const before = Object.fromEntries(Object.keys(body).map((k) => [k, (settingsJson(found) as Record<string, unknown>)[k]]));
      const { refundLimitReceptionistPaise, ...rest } = body;
      await found.update({
        ...rest,
        ...(refundLimitReceptionistPaise !== undefined ? { refundLimitReceptionistPaise: String(refundLimitReceptionistPaise) } : {}),
      });
      await auditFromReq(req, { action: 'settings.update', targetType: 'organization', targetId: orgId(req), details: { before, after: body } });
      return found;
    });
    res.json(settingsJson(s));
  });

  // =====================================================================
  // Holidays (clinic closed for the day)
  // =====================================================================
  r.get('/holidays', user, org, requirePermission('org:read'), async (req, res) => {
    const rows = await inOrg(req, () => Holiday.findAll({
      where: { onDate: { [Op.gte]: new Date().toISOString().slice(0, 10) } },
      order: [['onDate', 'ASC']],
    }));
    res.json({ items: rows.map((h) => ({ id: h.id, onDate: h.onDate, name: h.name, branchId: h.branchId })) });
  });

  r.post('/holidays', user, org, requirePermission('branch:manage'), async (req, res) => {
    const body = parse(holidayBody, req.body);
    const g = grant(req, 'branch:manage');
    const mine = req.ctx!.org!.branchIds;
    if (g.scope !== 'org' && mine.length && (!body.branchId || !mine.includes(body.branchId))) {
      throw forbidden('You can only add holidays for your branches');
    }
    const h = await inOrg(req, async () => {
      if (body.branchId && !(await Branch.findOne({ where: { id: body.branchId, deletedAt: null } }))) throw badRequest('Unknown branch');
      try {
        const created = await Holiday.create({ organizationId: orgId(req), branchId: body.branchId, onDate: body.onDate, name: body.name });
        await auditFromReq(req, { action: 'holiday.create', targetType: 'holiday', targetId: created.id, details: { onDate: body.onDate, name: body.name } });
        return created;
      } catch (e) {
        if (e instanceof UniqueConstraintError) throw conflict('There is already a holiday on that day');
        throw e;
      }
    });
    res.status(201).json({ id: h.id, onDate: h.onDate, name: h.name, branchId: h.branchId });
  });

  r.delete('/holidays/:id', user, org, requirePermission('branch:manage'), async (req, res) => {
    const g = grant(req, 'branch:manage');
    const mine = req.ctx!.org!.branchIds;
    await inOrg(req, async () => {
      const h = await Holiday.findByPk(String(req.params.id));
      if (!h) throw notFound('Holiday not found');
      if (g.scope !== 'org' && mine.length && (!h.branchId || !mine.includes(h.branchId))) throw forbidden('You can only remove holidays for your branches');
      await h.destroy();
      await auditFromReq(req, { action: 'holiday.delete', targetType: 'holiday', targetId: h.id, details: { onDate: h.onDate } });
    });
    res.status(204).end();
  });

  // =====================================================================
  // Onboarding checklist
  // =====================================================================
  async function onboardingStatus(req: Request): Promise<OnboardingStatus> {
    const o = await Organization.findByPk(orgId(req));
    const s = await OrganizationSettings.findByPk(orgId(req));
    if (!o || !s) throw notFound();
    const branches = await Branch.findAll({ where: { deletedAt: null, isActive: true }, order: [['createdAt', 'ASC']] });
    const doctors = await Doctor.findAll({ where: { deletedAt: null, isActive: true } });
    const rules = doctors.length ? await ScheduleRule.findAll({ where: { doctorId: doctors.map((d) => d.id) } }) : [];
    const services = await Service.count({ where: { isActive: true } });

    const clinic: string[] = [];
    if (o.specialities.length === 0) clinic.push('Choose at least one speciality');
    if (o.languages.length === 0) clinic.push('Choose the languages your patients speak');
    if (!branches.some((b) => b.phone)) clinic.push('Add the phone number patients call');

    const branchMissing: string[] = [];
    if (branches.length === 0) branchMissing.push('Add at least one open branch');
    for (const b of branches) if (Object.keys(b.openingHours ?? {}).length === 0) branchMissing.push(`Set opening hours for ${b.name}`);

    const doctorMissing: string[] = [];
    if (doctors.length === 0) doctorMissing.push('Add at least one doctor');
    for (const d of doctors) if (!rules.some((x) => x.doctorId === d.id)) doctorMissing.push(`Set weekly hours for ${d.displayName}`);

    const steps: OnboardingStatus['steps'] = [
      { key: 'clinic', title: 'Clinic details', done: clinic.length === 0, missing: clinic },
      { key: 'branches', title: 'Branches', done: branchMissing.length === 0, missing: branchMissing },
      { key: 'doctors', title: 'Doctors and hours', done: doctorMissing.length === 0, missing: doctorMissing },
      { key: 'services', title: 'Services and fees', done: services > 0, missing: services > 0 ? [] : ['Add at least one service'] },
      { key: 'phone', title: 'Phone and AI receptionist', done: !!s.phoneSetupChoice, missing: s.phoneSetupChoice ? [] : ['Choose how your phone line will connect'] },
    ];
    const canComplete = steps.every((x) => x.done);
    steps.push({ key: 'review', title: 'Review and go live', done: !!s.onboardingCompletedAt, missing: s.onboardingCompletedAt ? [] : ['Review and finish setup'] });
    return { steps, completedAt: s.onboardingCompletedAt ? s.onboardingCompletedAt.toISOString() : null, canComplete };
  }

  r.get('/onboarding', user, org, requirePermission('org:read'), async (req, res) => {
    res.json(await inOrg(req, () => onboardingStatus(req)));
  });

  r.post('/onboarding/complete', user, org, requirePermission('org:update'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const status = await onboardingStatus(req);
      if (status.completedAt) return status;
      if (!status.canComplete) {
        throw new HttpError(409, 'conflict', 'Some setup steps are not finished yet', status.steps.filter((x) => !x.done && x.key !== 'review'));
      }
      await OrganizationSettings.update({ onboardingCompletedAt: new Date(), onboardingCompletedBy: req.ctx!.userId }, { where: { organizationId: orgId(req) } });
      await auditFromReq(req, { action: 'onboarding.complete', targetType: 'organization', targetId: orgId(req) });
      return onboardingStatus(req);
    });
    res.json(out);
  });

  return r;
}
