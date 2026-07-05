/* ============================================================
   VISIBILITY ENGINE — Phase 14.1 (foundation) + Phase 14.2 (improvements)
   MediCore Clinic Management System

   Answers "what DATA can this user see?" — a layer below the
   Permission Engine ("what can this user DO?") and completely
   separate from it.

       Authentication -> User -> Role -> Permission Engine
                                            |
                                            v
                                    Visibility Engine
                                            |
                                            v
                                   MongoDB Query Filter
                                            |
                                            v
                                      API Response

   This file does not read req.headers, verify JWTs, or check
   `can()`/requirePermission() — a request must already have
   passed authenticate() + tenantScope() (+ requireClinicContext()
   where relevant) before anything here runs. Route handlers keep
   doing that; this module only decides the extra MongoDB filter
   to AND onto an already-tenant-scoped query.

   STILL A FOUNDATION PHASE — nothing in server.js's routes calls
   this yet. The one exception (per Phase 14.2 Goal 1) is
   authenticate(), which now attaches req.user.doctorId so this
   engine never has to look it up itself. No route behavior, no
   UI, no Permission Engine change.

   ------------------------------------------------------------
   PHASE 14.2 — WHAT CHANGED AND WHY
   Everything from Phase 14.1 below this header is UNCHANGED:
   SCOPE_KINDS, VISIBILITY_MODULES, VISIBILITY_MATRIX,
   resolveScope, getUserDataScope, buildMongoFilter,
   buildPatientDoctorFilter, isDenied, hasFullClinicScope,
   hasOwnDataScope all still exist with identical behavior —
   nothing here is a breaking change for a caller that only knows
   Phase 14.1's API.

   Added on top, later in this file:
     - getVisibilityContext()   Goal 5 + Goal 9: the single rich
                                 result object, computed once and
                                 cacheable per-request.
     - Dashboard helpers        Goal 2: widget-aware, not
                                 document-aware.
     - getVisiblePatients()     Goal 3: names the abstraction the
                                 spec asks for. Internally still
                                 calls buildPatientDoctorFilter —
                                 the join-through-Appointment
                                 strategy hasn't changed, only its
                                 public name/shape, so swapping in
                                 a future assignedDoctorId field
                                 only touches this one function.
     - Financial helpers        Goal 4.
     - Export helpers           Goal 6.
     - Analytics helpers        Goal 7.
     - AI helpers               Goal 8.
     - Extension-point registry Goal 10.
   ============================================================ */

/* ------------------------------------------------------------
   SCOPE KINDS
   The engine resolves every (role, module) pair to one of a
   small set of scope kinds. New scopes (Branch, Department,
   Multi-Clinic, Assigned-Staff, ...) can be added here without
   touching call sites — they just get a new resolver + filter
   builder, same shape as the ones below.
   ------------------------------------------------------------ */
const SCOPE_KINDS = Object.freeze({
  FULL_CLINIC: 'FULL_CLINIC',   // see every record in the clinic
  OWN_DATA: 'OWN_DATA',         // see only records tied to this user (typically: this doctor)
  OPERATIONAL: 'OPERATIONAL',   // full operational visibility, but not financial data
  FINANCIAL: 'FINANCIAL',       // billing/revenue visibility, not clinical/admin data
  NONE: 'NONE',                 // no visibility (deny-by-default fallback)
});

/* ------------------------------------------------------------
   MODULES
   Mirrors the modules this engine has an opinion about. A module
   not listed here simply isn't gated by the Visibility Engine
   yet (falls through to FULL_CLINIC once tenantScope has already
   applied clinicId — i.e. today's behavior, unchanged) rather
   than being silently blocked.
   ------------------------------------------------------------ */
const VISIBILITY_MODULES = Object.freeze([
  'dashboard', 'appointments', 'patients', 'doctors', 'calendar',
  'billing', 'reports',
]);

/* ------------------------------------------------------------
   ROLE -> MODULE -> SCOPE KIND
   This table is the single place role-based data visibility is
   declared. It replaces the pattern of scattering
   `if (role === 'doctor') filter.doctorId = ...` across
   individual route handlers — a future integration phase updates
   route handlers to call resolveScope()/buildMongoFilter() from
   here instead of writing that logic inline.

   Kept data-driven (a plain object) rather than a chain of
   if/else so it's trivial to audit and to extend for new roles
   or modules later.
   ------------------------------------------------------------ */
const VISIBILITY_MATRIX = Object.freeze({
  clinic_admin: {
    dashboard: SCOPE_KINDS.FULL_CLINIC,
    appointments: SCOPE_KINDS.FULL_CLINIC,
    patients: SCOPE_KINDS.FULL_CLINIC,
    doctors: SCOPE_KINDS.FULL_CLINIC,
    calendar: SCOPE_KINDS.FULL_CLINIC,
    billing: SCOPE_KINDS.FULL_CLINIC,
    reports: SCOPE_KINDS.FULL_CLINIC,
  },
  doctor: {
    dashboard: SCOPE_KINDS.OWN_DATA,
    appointments: SCOPE_KINDS.OWN_DATA,
    patients: SCOPE_KINDS.OWN_DATA,
    doctors: SCOPE_KINDS.NONE,       // doctor directory/admin isn't "own data" for a doctor
    calendar: SCOPE_KINDS.OWN_DATA,
    billing: SCOPE_KINDS.OWN_DATA,   // "own invoices (future)" per spec
    reports: SCOPE_KINDS.OWN_DATA,
  },
  receptionist: {
    dashboard: SCOPE_KINDS.OPERATIONAL,
    appointments: SCOPE_KINDS.OPERATIONAL,
    patients: SCOPE_KINDS.OPERATIONAL,
    doctors: SCOPE_KINDS.OPERATIONAL,  // "doctor schedules" per spec — read visibility, not admin
    calendar: SCOPE_KINDS.OPERATIONAL,
    billing: SCOPE_KINDS.NONE,         // "cannot access financial analytics"
    reports: SCOPE_KINDS.NONE,         // "cannot access revenue reports"
  },
  billing_staff: {
    dashboard: SCOPE_KINDS.FINANCIAL,
    appointments: SCOPE_KINDS.NONE,    // "cannot view clinical records not required for billing"
    patients: SCOPE_KINDS.NONE,
    doctors: SCOPE_KINDS.NONE,         // "cannot view doctor productivity"
    calendar: SCOPE_KINDS.NONE,
    billing: SCOPE_KINDS.FINANCIAL,
    reports: SCOPE_KINDS.FINANCIAL,    // financial reports only — see FINANCIAL filter builder note
  },
});

/* ------------------------------------------------------------
   resolveScope(role, moduleName)

   Pure lookup, no I/O. Returns one of SCOPE_KINDS. Unknown role
   or unknown module -> NONE (deny by default, matching the
   Permission Engine's own posture — see requirePermission() in
   server.js, which never grants by omission).
   ------------------------------------------------------------ */
function resolveScope(role, moduleName) {
  const roleRow = VISIBILITY_MATRIX[role];
  if (!roleRow) return SCOPE_KINDS.NONE;
  const scope = roleRow[moduleName];
  return scope || SCOPE_KINDS.NONE;
}

/* ------------------------------------------------------------
   getUserDataScope(user)

   Convenience summary of a user's own visibility profile, useful
   for callers that want a quick "what kind of user is this" read
   (e.g. deciding whether to even attempt a query) without walking
   the whole matrix themselves.

   `user` is the shape authenticate() attaches to req.user, i.e.
   { userId, clinicId, role, doctorId? }. See doctorId note below.
   ------------------------------------------------------------ */
function getUserDataScope(user, moduleName) {
  if (!user || !user.role) return SCOPE_KINDS.NONE;
  return resolveScope(user.role, moduleName);
}

/* ------------------------------------------------------------
   buildMongoFilter(user, moduleName)

   The actual "Query Filter Engine". Given the authenticated user
   and the module being queried, returns a plain object to be
   merged (via Object.assign / spread) into a query that ALREADY
   has clinicId set by tenantScope(). This function never sets
   clinicId itself — tenant isolation stays exactly where it is
   today (tenantScope + requireClinicContext), untouched.

   Returns:
     - {}                          for FULL_CLINIC / OPERATIONAL
                                    (no extra restriction beyond
                                    the tenant scope already applied)
     - { doctorId: <id> }          for OWN_DATA, when the module's
                                    schema supports a direct
                                    doctorId field (appointments,
                                    calendar/events, invoices)
     - { __visibilityDeny: true }  for NONE — a filter that can
                                    never match a real document
                                    (see note below), so a route
                                    that forgets to check the scope
                                    kind first still returns zero
                                    rows instead of leaking data.

   IMPORTANT — 'patients' + OWN_DATA:
   The current Patient schema (server.js patientSchema) has no
   doctor-ownership field (no assignedDoctor/primaryDoctor). A
   doctor's "own patients" can only be derived by joining through
   Appointment (patients who have >=1 appointment with that
   doctor), which is NOT a flat filter object — it requires a
   distinct-ids lookup first. buildMongoFilter() cannot express
   that as a single object, so for ('doctor', 'patients') it
   returns the deny-safe sentinel and the caller must instead use
   buildPatientDoctorFilter() (below), an async helper that does
   the two-step lookup. This is called out explicitly rather than
   quietly returning {} (which would over-grant) or guessing at a
   field name that doesn't exist in the schema.
   ------------------------------------------------------------ */
function buildMongoFilter(user, moduleName) {
  const scope = getUserDataScope(user, moduleName);

  switch (scope) {
    case SCOPE_KINDS.FULL_CLINIC:
    case SCOPE_KINDS.OPERATIONAL:
      return {};

    case SCOPE_KINDS.FINANCIAL:
      // Financial scope is a module-access decision (billing_staff
      // gets billing/reports/dashboard; everything else is NONE at
      // the module level via the matrix above) rather than an
      // extra per-document filter within those modules — a billing
      // clerk sees all of the clinic's invoices, not a subset of
      // them. No additional restriction beyond tenantScope's
      // clinicId.
      return {};

    case SCOPE_KINDS.OWN_DATA: {
      if (moduleName === 'patients') {
        // See doctrine in the header comment — cannot be expressed
        // as a flat filter with the current schema. Deny-safe until
        // the caller performs the two-step lookup explicitly.
        return { __visibilityDeny: true };
      }
      if (!user || !user.doctorId) {
        // A doctor-role user with no linked Doctor record can't be
        // scoped to "their own" anything — deny rather than
        // silently falling through to full access.
        return { __visibilityDeny: true };
      }
      // appointments, calendar (events), billing (invoices) all
      // carry a direct doctorId field on their schema.
      return { doctorId: user.doctorId };
    }

    case SCOPE_KINDS.NONE:
    default:
      return { __visibilityDeny: true };
  }
}

/* ------------------------------------------------------------
   buildPatientDoctorFilter(user, { Appointment })

   Async helper for the one module/role combination that needs a
   join: a doctor's "own patients". Takes the Appointment model as
   a parameter (rather than requiring it) to keep this module
   free of any mongoose/model imports — it stays a pure filter
   library that future modules wire up to their own model
   references.

   Returns a Mongo filter object ({ _id: { $in: [...] } }) or the
   same deny-safe sentinel if the user isn't a properly-linked
   doctor. Not used anywhere yet — provided now so the patients
   module has a documented, correct path in the next integration
   phase instead of inventing one under time pressure later.
   ------------------------------------------------------------ */
async function buildPatientDoctorFilter(user, { Appointment }) {
  if (!user || user.role !== 'doctor' || !user.doctorId || !Appointment) {
    return { __visibilityDeny: true };
  }
  const patientIds = await Appointment.distinct('patientId', {
    clinicId: user.clinicId,
    doctorId: user.doctorId,
  });
  return { _id: { $in: patientIds } };
}

/* ------------------------------------------------------------
   isDenied(filter)

   Small helper so callers don't need to know the sentinel's shape
   directly. A route can do:

     const filter = { clinicId: req.clinicId, ...buildMongoFilter(req.user, 'patients') };
     if (isVisibilityEngine.isDenied(filter)) return res.status(200).json({ success: true, data: [], pagination: {...} });

   rather than querying MongoDB with a filter that happens to
   match nothing (works, but wastes a round trip and is easy to
   get subtly wrong if the sentinel key is ever changed).
   ------------------------------------------------------------ */
function isDenied(filter) {
  return Boolean(filter && filter.__visibilityDeny);
}

/* ------------------------------------------------------------
   hasFullClinicScope(user, moduleName)
   hasOwnDataScope(user, moduleName)
   Small named predicates for readability at call sites that just
   need a yes/no rather than the raw scope constant.
   ------------------------------------------------------------ */
function hasFullClinicScope(user, moduleName) {
  return getUserDataScope(user, moduleName) === SCOPE_KINDS.FULL_CLINIC;
}

function hasOwnDataScope(user, moduleName) {
  return getUserDataScope(user, moduleName) === SCOPE_KINDS.OWN_DATA;
}

/* ============================================================
   PHASE 14.2 — GOAL 5: VISIBILITY RESULT OBJECT
   ============================================================

   getVisibilityContext(user, moduleName) computes everything a
   caller is likely to need about a user's visibility for a module
   in one pass, instead of each of Dashboard/Reports/Export/
   Analytics/AI/Search calling resolveScope()/buildMongoFilter()
   separately and re-deriving the same booleans by hand (and
   risking each one doing it slightly differently).

   Shape (matches the spec's example exactly, plus `role`/`module`
   for convenience at the call site):

     {
       role,               // the resolved role string, for logging/debugging
       module,             // the module this context was computed for
       scope,              // one of SCOPE_KINDS
       mongoFilter,        // output of buildMongoFilter() — {} / {doctorId} / deny sentinel
       canViewFinancial,   // true only for FINANCIAL scope
       canViewOperational, // true for FULL_CLINIC / OPERATIONAL (i.e. "sees the operational picture")
       canViewClinical,    // true for FULL_CLINIC / OWN_DATA (i.e. "sees patient/appointment detail")
       dashboardScope,     // see getDashboardVisibility() — Goal 2
       reportScope,        // see getReportVisibility() — Goal 7 groundwork
       exportScope,        // see getExportVisibility() — Goal 6 groundwork
     }

   This function is pure/synchronous (like everything else in this
   file) EXCEPT that mongoFilter for ('doctor', 'patients') is the
   deny-safe sentinel here too, not the joined id list — computing
   that requires the Appointment model and a DB round trip
   (buildPatientDoctorFilter), which a synchronous, cacheable
   context object should not silently trigger. Callers that need
   the doctor's real patient-id filter still call
   buildPatientDoctorFilter()/getVisiblePatients() explicitly.
   ------------------------------------------------------------ */
function getVisibilityContext(user, moduleName) {
  const role = (user && user.role) || null;
  const scope = getUserDataScope(user, moduleName);
  const mongoFilter = buildMongoFilter(user, moduleName);

  return {
    role,
    module: moduleName,
    scope,
    mongoFilter,
    canViewFinancial: scope === SCOPE_KINDS.FINANCIAL,
    canViewOperational: scope === SCOPE_KINDS.FULL_CLINIC || scope === SCOPE_KINDS.OPERATIONAL,
    canViewClinical: scope === SCOPE_KINDS.FULL_CLINIC || scope === SCOPE_KINDS.OWN_DATA,
    dashboardScope: getDashboardVisibility(user).scope,
    reportScope: getReportVisibility(user, moduleName),
    exportScope: getExportVisibility(user, moduleName),
  };
}

/* ------------------------------------------------------------
   GOAL 9 — PERFORMANCE: per-request memoization

   getVisibilityContext() is cheap (no I/O), but a request that
   touches it from several places (a route handler, a response
   serializer, an audit log call) shouldn't recompute it several
   times over, and — more importantly — every caller within one
   request must see the *same* object rather than independently
   re-deriving it. getRequestVisibility(req, moduleName) caches
   the result on the request object itself, the same pattern
   server.js already uses for the permission matrix
   (see loadPermissionMatrixOnce, keyed by req._permissionMatrix).

   Usage from a route handler (not wired up yet — Phase 14.2 is
   still foundation-only per the "no route integration" rule):

     const ctx = visibilityEngine.getRequestVisibility(req, 'patients');
     if (visibilityEngine.isDenied(ctx.mongoFilter)) { ... }

   Deliberately takes `req` (not just `user`) because the cache
   needs somewhere request-scoped to live; it never reads
   anything else off req (no headers, no re-deriving req.user).
   ------------------------------------------------------------ */
function getRequestVisibility(req, moduleName) {
  if (!req) return getVisibilityContext(null, moduleName);
  if (!req._visibilityContext) req._visibilityContext = {};
  const cacheKey = moduleName || '__default__';
  if (req._visibilityContext[cacheKey]) return req._visibilityContext[cacheKey];
  const ctx = getVisibilityContext(req.user, moduleName);
  req._visibilityContext[cacheKey] = ctx;
  return ctx;
}

/* ============================================================
   PHASE 14.2 — GOAL 2: DEDICATED DASHBOARD VISIBILITY
   ============================================================

   The dashboard is not "a module with rows" the way patients or
   appointments are — it's a collection of independent widgets
   (today's appointments, revenue-this-month, my-schedule,
   notifications, ...), each of which may draw from a different
   collection with a different scope. Reusing buildMongoFilter()
   for 'dashboard' as if it were one flat query would force every
   widget into the same scope, which is wrong (e.g. a doctor's
   dashboard shows their OWN appointments/patients/revenue, but
   the notifications widget is inherently per-user regardless of
   role).

   getDashboardVisibility(user) returns a widget-keyed map instead
   of a single filter, so a future dashboard route can do:

     const dash = getDashboardVisibility(req.user);
     if (dash.widgets.revenue.visible) { ...query with dash.widgets.revenue.mongoFilter... }

   rather than the route re-deriving per-widget rules itself.
   ------------------------------------------------------------ */
const DASHBOARD_WIDGETS = Object.freeze([
  'appointments', 'patients', 'revenue', 'schedule', 'notifications',
]);

// role -> widget -> scope. Deliberately separate from
// VISIBILITY_MATRIX (which is module-level) since dashboard
// widgets don't map 1:1 onto modules — e.g. 'revenue' isn't a
// module elsewhere in this file, it's billing data shown inline.
const DASHBOARD_MATRIX = Object.freeze({
  clinic_admin: {
    appointments: SCOPE_KINDS.FULL_CLINIC,
    patients: SCOPE_KINDS.FULL_CLINIC,
    revenue: SCOPE_KINDS.FULL_CLINIC,
    schedule: SCOPE_KINDS.FULL_CLINIC,
    notifications: SCOPE_KINDS.FULL_CLINIC,
  },
  doctor: {
    appointments: SCOPE_KINDS.OWN_DATA,
    patients: SCOPE_KINDS.OWN_DATA,
    revenue: SCOPE_KINDS.OWN_DATA,
    schedule: SCOPE_KINDS.OWN_DATA,
    notifications: SCOPE_KINDS.OWN_DATA, // always "own" — a user's own notifications, not role-dependent
  },
  receptionist: {
    appointments: SCOPE_KINDS.OPERATIONAL,
    patients: SCOPE_KINDS.OPERATIONAL,
    revenue: SCOPE_KINDS.NONE,           // no financial analytics per spec
    schedule: SCOPE_KINDS.OPERATIONAL,
    notifications: SCOPE_KINDS.OWN_DATA,
  },
  billing_staff: {
    appointments: SCOPE_KINDS.NONE,
    patients: SCOPE_KINDS.NONE,
    revenue: SCOPE_KINDS.FINANCIAL,
    schedule: SCOPE_KINDS.NONE,
    notifications: SCOPE_KINDS.OWN_DATA,
  },
});

function getDashboardVisibility(user) {
  const role = user && user.role;
  const roleRow = DASHBOARD_MATRIX[role] || {};

  const widgets = {};
  DASHBOARD_WIDGETS.forEach((widget) => {
    const scope = roleRow[widget] || SCOPE_KINDS.NONE;
    let mongoFilter;
    if (scope === SCOPE_KINDS.NONE) {
      mongoFilter = { __visibilityDeny: true };
    } else if (scope === SCOPE_KINDS.OWN_DATA) {
      if (widget === 'patients') {
        // Same join-required caveat as buildMongoFilter — resolved
        // via getVisiblePatients()/buildPatientDoctorFilter, not a
        // flat filter here.
        mongoFilter = { __visibilityDeny: true, __requiresJoin: 'patients' };
      } else if (widget === 'notifications') {
        // Own notifications = filtered by userId, not doctorId —
        // every role has notifications, only doctors have doctorId.
        mongoFilter = user && user.userId ? { userId: user.userId } : { __visibilityDeny: true };
      } else if (user && user.doctorId) {
        mongoFilter = { doctorId: user.doctorId };
      } else {
        mongoFilter = { __visibilityDeny: true };
      }
    } else {
      // FULL_CLINIC, OPERATIONAL, FINANCIAL — no extra restriction
      // beyond tenantScope's clinicId, same rationale as
      // buildMongoFilter() above.
      mongoFilter = {};
    }
    widgets[widget] = { scope, visible: scope !== SCOPE_KINDS.NONE, mongoFilter };
  });

  return {
    role: role || null,
    // Overall dashboard "flavor" label — informational, mirrors
    // the spec's Clinic Admin / Doctor / Receptionist / Billing
    // Staff dashboard framing. Individual widgets above are the
    // source of truth; this is a convenience summary only.
    scope: role === 'clinic_admin' ? SCOPE_KINDS.FULL_CLINIC
      : role === 'doctor' ? SCOPE_KINDS.OWN_DATA
      : role === 'receptionist' ? SCOPE_KINDS.OPERATIONAL
      : role === 'billing_staff' ? SCOPE_KINDS.FINANCIAL
      : SCOPE_KINDS.NONE,
    widgets,
  };
}

/* ============================================================
   PHASE 14.2 — GOAL 3: PATIENT VISIBILITY ABSTRACTION
   ============================================================

   getVisiblePatients(user, { Appointment, Patient }) is the named
   abstraction the spec asks for: route handlers (in a future
   integration phase) call this instead of knowing HOW a doctor's
   patient list is derived.

   Today's strategy (unchanged from Phase 14.1): join through
   Appointment.distinct('patientId', { doctorId }). Tomorrow's
   strategy, if the schema grows an assignedDoctorId/
   primaryDoctorId field, becomes a flat { assignedDoctorId }
   filter — and only the inside of this one function needs to
   change; every caller keeps calling getVisiblePatients() exactly
   as before. That's the entire point of the abstraction layer the
   spec asks for.

   `Patient` is accepted as a parameter now (unused today) so the
   future flat-filter version doesn't need a signature change —
   it'll just start using it to run the query directly instead of
   returning a filter for the caller to run.

   Returns the same shape buildMongoFilter()/buildPatientDoctorFilter
   already use: either a Mongo filter object or the deny sentinel.
   Full clinic / operational scopes correctly return {} here too
   (a receptionist or admin's "visible patients" is just
   tenantScope's clinicId, nothing extra) — this function handles
   the whole scope range for 'patients', not only the doctor case.
   ------------------------------------------------------------ */
async function getVisiblePatients(user, { Appointment, Patient } = {}) {
  const scope = getUserDataScope(user, 'patients');

  if (scope === SCOPE_KINDS.FULL_CLINIC || scope === SCOPE_KINDS.OPERATIONAL) {
    return {};
  }
  if (scope === SCOPE_KINDS.OWN_DATA) {
    // Delegates to the existing join-based helper — see header
    // comment. This is the one seam a future schema change edits.
    return buildPatientDoctorFilter(user, { Appointment });
  }
  return { __visibilityDeny: true };
}

/* ============================================================
   PHASE 14.2 — GOAL 4: FINANCIAL VISIBILITY LAYER
   ============================================================

   Today only 'billing' and 'reports' (financial slice) and the
   dashboard's 'revenue' widget exist, and FINANCIAL scope is
   clinic-wide-or-nothing (a billing clerk sees every invoice in
   the clinic, never a subset) — so getFinancialVisibility() today
   returns the same {} / deny shape as buildMongoFilter(). It
   exists as its own named function (rather than callers reusing
   buildMongoFilter('billing') directly) so that when the spec's
   listed future modules — Payments, Refunds, Expenses, Insurance
   — arrive as real collections, each gets a documented entry
   point here instead of every future route reinventing "am I
   billing_staff or clinic_admin".
   ------------------------------------------------------------ */
const FINANCIAL_MODULES = Object.freeze([
  'invoices', 'payments', 'refunds', 'expenses', 'insurance', 'revenue', 'billingDashboard', 'financialReports',
]);

// financialModule -> roles allowed to see it at all. Distinct from
// VISIBILITY_MATRIX because these aren't top-level nav modules —
// they're sub-resources of 'billing'/'reports' that don't exist as
// collections yet. Both clinic_admin and billing_staff are
// financial-capable roles; everyone else is denied, matching the
// spec ("Billing Staff can view... Cannot view... Administrative
// settings" and receptionist "Cannot access financial analytics").
const FINANCIAL_ROLE_ACCESS = Object.freeze({
  clinic_admin: true,
  billing_staff: true,
  doctor: false,
  receptionist: false,
});

function getFinancialVisibility(user, financialModule) {
  const role = user && user.role;
  const allowed = Boolean(FINANCIAL_ROLE_ACCESS[role]);

  if (!FINANCIAL_MODULES.includes(financialModule)) {
    // Unknown / not-yet-registered financial module — deny rather
    // than silently granting access to something this layer has
    // no rule for yet.
    return { allowed: false, mongoFilter: { __visibilityDeny: true } };
  }

  return {
    allowed,
    mongoFilter: allowed ? {} : { __visibilityDeny: true },
  };
}

/* ============================================================
   PHASE 14.2 — GOAL 6: EXPORT VISIBILITY
   ============================================================

   A future Export Engine must never let an export bypass the
   same rules a live query would enforce — the classic hole where
   "view" is scoped but "export CSV" quietly isn't. getExportVisibility()
   is the single source an export route should consult: same
   scope resolution as getVisibilityContext(), reused rather than
   re-derived, so the two can never drift apart.
   ------------------------------------------------------------ */
function getExportVisibility(user, moduleName) {
  const scope = getUserDataScope(user, moduleName);
  return {
    module: moduleName,
    scope,
    allowed: scope !== SCOPE_KINDS.NONE,
    mongoFilter: buildMongoFilter(user, moduleName),
    // Export-specific: even when allowed, an export of 'patients'
    // for a doctor requires the same join as a live query — flag
    // it so the (future) Export Engine knows to call
    // getVisiblePatients() instead of trusting mongoFilter alone.
    requiresJoin: moduleName === 'patients' && scope === SCOPE_KINDS.OWN_DATA,
  };
}

/* ============================================================
   PHASE 14.2 — GOAL 7: ANALYTICS VISIBILITY
   ============================================================

   "Analytics should never expose another doctor's statistics."
   getReportVisibility()/getAnalyticsVisibility() give
   Revenue/Patient/Appointment analytics, Doctor Performance, and
   Department Reports a single place to ask "what slice of the
   clinic can this user's analytics cover", rather than each
   report query hand-rolling its own doctorId check (the exact
   anti-pattern Phase 14.1 removed from route handlers generally).

   Doctor Performance is called out specifically because it's the
   one analytic that is fundamentally ABOUT doctors as subjects —
   a receptionist/admin viewing "doctor performance" is looking at
   other people's aggregate stats, which is operational, not a
   privacy concern the way raw patient data is; a doctor viewing
   it is restricted to their own row only.
   ------------------------------------------------------------ */
function getReportVisibility(user, moduleName) {
  // Reports piggyback on the same module scoping as everything
  // else — 'reports' scope per VISIBILITY_MATRIX already encodes
  // "doctor sees own reports, billing_staff sees financial
  // reports, receptionist sees none". Named separately from
  // getUserDataScope so call sites read as "report visibility"
  // rather than a generic lookup, and so this is the one place to
  // extend if report visibility ever needs to diverge from plain
  // module visibility.
  return getUserDataScope(user, moduleName === undefined ? 'reports' : moduleName);
}

function getDoctorPerformanceVisibility(user) {
  const role = user && user.role;
  if (role === 'clinic_admin' || role === 'receptionist') {
    // Aggregate view across all doctors — operational, not
    // clinical/financial, so both admin and reception can see it
    // per the spec's "reception: Doctor schedules" allowance.
    return { scope: SCOPE_KINDS.OPERATIONAL, mongoFilter: {}, restrictedToSelf: false };
  }
  if (role === 'doctor') {
    if (!user.doctorId) return { scope: SCOPE_KINDS.NONE, mongoFilter: { __visibilityDeny: true }, restrictedToSelf: true };
    return { scope: SCOPE_KINDS.OWN_DATA, mongoFilter: { doctorId: user.doctorId }, restrictedToSelf: true };
  }
  return { scope: SCOPE_KINDS.NONE, mongoFilter: { __visibilityDeny: true }, restrictedToSelf: true };
}

/* ============================================================
   PHASE 14.2 — GOAL 8: AI VISIBILITY
   ============================================================

   A future AI Assistant is just another consumer of this engine
   — it must never see a wider slice of data than the same user
   would get from a normal API call. getAIVisibility() doesn't add
   new rules; it packages the existing per-module scopes into the
   shape an AI orchestration layer would plausibly want (which
   collections it may query, and with what filter), so "hook up
   the AI assistant" later means wiring to this function, not
   re-deciding visibility rules a third time (API routes, exports,
   and now AI would otherwise each grow their own copy).
   ------------------------------------------------------------ */
function getAIVisibility(user) {
  const role = user && user.role;
  const queryableModules = VISIBILITY_MODULES.filter(
    (m) => getUserDataScope(user, m) !== SCOPE_KINDS.NONE
  );

  return {
    role: role || null,
    queryableModules,
    filtersByModule: queryableModules.reduce((acc, m) => {
      acc[m] = buildMongoFilter(user, m);
      return acc;
    }, {}),
    // Mirrors the spec's four examples directly, as a readable
    // summary an AI orchestration layer can log/display without
    // re-deriving it from filtersByModule.
    summary:
      role === 'clinic_admin' ? 'Analyze entire clinic' :
      role === 'doctor' ? 'Analyze only own patients and appointments' :
      role === 'receptionist' ? 'Analyze appointments and operational data' :
      role === 'billing_staff' ? 'Analyze invoices and financial data' :
      'No analysis scope',
  };
}

/* ============================================================
   PHASE 14.2 — GOAL 10: FUTURE SCALABILITY / EXTENSION POINTS
   ============================================================

   Placeholders only — no implementation, per the spec. Each is a
   registry future phases add entries to, rather than a resolver
   that has to be rewritten when the first real one is needed.
   Keeping them as empty, documented objects (not functions that
   throw "not implemented") means code written against them today
   doesn't need to change shape later — it just starts finding
   entries where today it finds none.
   ------------------------------------------------------------ */
const FUTURE_SCOPE_EXTENSIONS = Object.freeze({
  // e.g. BRANCH_SCOPE.clinic_admin = SCOPE_KINDS.FULL_CLINIC (all branches)
  //      BRANCH_SCOPE.branch_manager = { branchId: user.branchId }
  BRANCH_SCOPE: {},
  DEPARTMENT_SCOPE: {},
  MULTI_CLINIC_SCOPE: {},      // for a future super_admin-adjacent "regional manager" role
  ASSIGNED_STAFF_SCOPE: {},    // e.g. a nurse assigned to specific doctors
  CUSTOM_POLICY_SCOPE: {},     // per-clinic overrides beyond the standard 4 roles
  REGIONAL_MANAGER_SCOPE: {},
  CHAIN_CLINIC_SCOPE: {},      // multi-clinic groups under one owner
});

module.exports = {
  // Phase 14.1 — unchanged, still the core of the engine
  SCOPE_KINDS,
  VISIBILITY_MODULES,
  VISIBILITY_MATRIX,
  resolveScope,
  getUserDataScope,
  buildMongoFilter,
  buildPatientDoctorFilter,
  isDenied,
  hasFullClinicScope,
  hasOwnDataScope,

  // Phase 14.2 — Goal 5 + 9: result object + per-request cache
  getVisibilityContext,
  getRequestVisibility,

  // Phase 14.2 — Goal 2: dashboard
  DASHBOARD_WIDGETS,
  DASHBOARD_MATRIX,
  getDashboardVisibility,

  // Phase 14.2 — Goal 3: patients abstraction
  getVisiblePatients,

  // Phase 14.2 — Goal 4: financial
  FINANCIAL_MODULES,
  getFinancialVisibility,

  // Phase 14.2 — Goal 6: export
  getExportVisibility,

  // Phase 14.2 — Goal 7: analytics/reports
  getReportVisibility,
  getDoctorPerformanceVisibility,

  // Phase 14.2 — Goal 8: AI
  getAIVisibility,

  // Phase 14.2 — Goal 10: extension points (placeholders)
  FUTURE_SCOPE_EXTENSIONS,
};