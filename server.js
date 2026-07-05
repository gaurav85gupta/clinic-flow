/* ============================================================
   server.js — MediCore Clinic Management API
   Phase 2.0B: Database Connection & Security Layer
   ============================================================ */

const path = require('path');

/* ── Dotenv path — works in both dev and packaged Electron build ──
   In packaged build: Electron sets DOTENV_PATH → Resources/.env
   In development:    falls back to server/.env (original behaviour) */
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.join(__dirname, '.env'),
});

const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const mongoose      = require('mongoose');
const mongoSanitize = require('express-mongo-sanitize');

// Phase 14.3 — Dashboard Visibility Integration. First real route-level
// consumer of the Visibility Engine (visibilityEngine.js, Phase 14.1/14.2).
// Only consumed here — nothing in this file modifies the engine itself.
const visibilityEngine = require('../js/visibilityEngine');

/* ============================================================
   1. ENVIRONMENT VALIDATION — fail fast on missing vars
   ============================================================ */

const REQUIRED_VARS = ['PORT', 'NODE_ENV', 'MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('\n❌  Missing required environment variables:');
  missing.forEach((k) => console.error(`   ✗  ${k}`));
  console.error('\n   Add them to your .env file and restart.\n');
  process.exit(1);
}
console.log('✅  Environment variables validated');

// Task 03 (Phase 4.2) — weak secrets cannot be used to sign/verify tokens
const MIN_JWT_SECRET_LENGTH = 32;
if (process.env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  console.error(
    `\n❌  JWT_SECRET is too short (${process.env.JWT_SECRET.length} chars). ` +
    `Minimum required: ${MIN_JWT_SECRET_LENGTH} characters.\n` +
    `   Generate a strong secret, e.g.: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n`
  );
  process.exit(1);
}
console.log('✅  JWT_SECRET strength validated');

/* ============================================================
   1B. MONGOOSE SCHEMAS — Clinic & User (Phase 3.0B.1)
   Core foundation models only. No routes/controllers here.
   ============================================================ */

const { Schema } = mongoose;

/* ---------- CLINIC SCHEMA ---------- */

const clinicSchema = new Schema(
  {
    // Basic Information
    name: {
      type: String,
      required: [true, 'Clinic name is required'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'Clinic slug is required'],
      trim: true,
      lowercase: true,
      unique: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    ownerEmail: {
      type: String,
      required: [true, 'Owner email is required'],
      trim: true,
      lowercase: true,
      unique: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },

    // Address
    address: {
      street:  { type: String, trim: true },
      city:    { type: String, trim: true },
      state:   { type: String, trim: true },
      country: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    // Status
    status: {
      type: String,
      enum: {
        values: ['active', 'suspended', 'trial', 'cancelled'],
        message: '{VALUE} is not a valid clinic status',
      },
      default: 'trial',
    },

    // Branding
    branding: {
      logo:          { type: String, trim: true },
      website:       { type: String, trim: true },
      primaryColor:  { type: String, trim: true },
      tagline:       { type: String, trim: true },
    },

    // Subscription
    subscription: {
      plan:        { type: String, trim: true },
      status:      { type: String, trim: true },
      trialEndsAt: { type: Date },
      renewsAt:    { type: Date },
      maxDoctors:  { type: Number, default: 0 },
      maxPatients: { type: Number, default: 0 },
    },

    // Future Branch Support Placeholder
    branchEnabled: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON:   { transform: (doc, ret) => { delete ret.__v; return ret; } },
    toObject: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

// Clinic indexes
clinicSchema.index({ slug: 1 },       { unique: true });
clinicSchema.index({ ownerEmail: 1 }, { unique: true });
clinicSchema.index({ status: 1 });

// Hot-reload safe export
const Clinic = mongoose.models.Clinic || mongoose.model('Clinic', clinicSchema, 'clinics');

/* ---------- USER SCHEMA ---------- */

const USER_ROLES = ['super_admin', 'clinic_admin', 'doctor', 'receptionist', 'billing_staff'];

const userSchema = new Schema(
  {
    // Ownership — required for every role except super_admin
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: function () {
        return this.role !== 'super_admin';
      },
    },

    // Identity
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      // Phase 14.0 (Staff Management) — email stays mandatory for the
      // super_admin/clinic_admin accounts that already log in with it
      // (index.html → POST /api/auth/login — UNCHANGED). It is now
      // optional for staff accounts (doctor/receptionist) created via
      // /api/staff, which authenticate with `username` instead — see
      // the `username` field below.
      required: function () {
        return this.role === 'super_admin' || this.role === 'clinic_admin';
      },
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },

    // Phase 14.0 (Staff Management) — login identifier for staff
    // accounts (doctor/receptionist) created via /api/staff. Admin
    // accounts continue logging in with `email` and never set this.
    username: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9_.]{3,30}$/, 'Username must be 3-30 characters: lowercase letters, numbers, "_" or "."'],
      required: function () {
        return this.role !== 'super_admin' && this.role !== 'clinic_admin';
      },
    },

    // Phase 14.0 (Staff Management) — staff contact number, collected
    // on the Add Staff form. Not required for super_admin/clinic_admin
    // (the clinic-level phone already lives on the Clinic document).
    phone: {
      type: String,
      trim: true,
    },

    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      minlength: [20, 'passwordHash looks too short to be a valid bcrypt hash'],
    },

    // Role
    role: {
      type: String,
      enum: {
        values: USER_ROLES,
        message: '{VALUE} is not a valid role',
      },
      required: [true, 'Role is required'],
    },

    // Doctor Link (optional — only relevant when role === 'doctor')
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      default: null,
    },

    // Security
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
      default: null,
    },
    // FUTURE USE (Phase 4.x password reset, not yet implemented):
    // When a password-reset/change endpoint is built, it must set this
    // field to `new Date()` on every successful password change. The
    // authenticate() middleware should then compare it against the JWT's
    // `iat` (issued-at) claim — if passwordChangedAt > iat, the token was
    // issued before the most recent password change and must be rejected
    // with 401, even if it has not yet expired. This is what makes
    // "change password" effectively invalidate any stolen older tokens.
    // No endpoint or enforcement logic exists yet — comment only, per
    // Phase 4.2 Task 08.
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON:   { transform: (doc, ret) => { delete ret.__v; delete ret.passwordHash; return ret; } },
    toObject: { transform: (doc, ret) => { delete ret.__v; delete ret.passwordHash; return ret; } },
  }
);

// User indexes
// Phase 14.0 — partial indexes (not a plain `unique: true`) because
// email is now optional for staff accounts and username is optional
// for admin accounts. A plain unique index would treat every missing
// field as the same `null` and reject the second such document per
// clinic; partialFilterExpression excludes documents where the field
// is absent from the index entirely.
userSchema.index(
  { email: 1, clinicId: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
userSchema.index(
  { username: 1, clinicId: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } }
);
userSchema.index({ clinicId: 1, role: 1 });
userSchema.index({ clinicId: 1, isActive: 1 });
// Phase 12.1 (Staff Identity Linking) — DB-level backstop for "a
// doctor profile may have only ONE login account". The application-
// level check in createStaff/updateStaff produces the clean error
// message; this partial unique index makes the guarantee hold even
// under a concurrent-request race, without affecting receptionist/
// billing_staff/admin accounts, which never set doctorId
// (partialFilterExpression excludes null/undefined entirely).
userSchema.index(
  { clinicId: 1, doctorId: 1 },
  { unique: true, partialFilterExpression: { doctorId: { $type: 'objectId' } } }
);

// Hot-reload safe export
const User = mongoose.models.User || mongoose.model('User', userSchema, 'users');

/* ============================================================
   1C. MONGOOSE SCHEMAS — Business Models (Phase 3.0B.2)
   Patients, Doctors, Appointments, Invoices, Settings,
   Notifications, Audit Logs.
   Schemas + validation + indexes ONLY.
   No routes, controllers, CRUD, or business logic here.
   ============================================================ */

/* ---------- PATIENT SCHEMA ---------- */

const patientSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    // Identity
    patientId: {
      type: String,
      required: [true, 'patientId is required'],
      trim: true,
    },
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
    },
    gender: {
      type: String,
      enum: {
        values: ['Male', 'Female', 'Other'],
        message: '{VALUE} is not a valid gender',
      },
    },
    dateOfBirth: {
      type: Date,
    },
    age: {
      type: Number,
      min: [0, 'Age cannot be negative'],
    },

    // Contact
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },
    address: {
      street:  { type: String, trim: true },
      city:    { type: String, trim: true },
      state:   { type: String, trim: true },
      country: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    // Emergency Contact
    emergencyContact: {
      name:     { type: String, trim: true },
      phone:    { type: String, trim: true },
      relation: { type: String, trim: true },
    },

    // Medical
    bloodGroup: {
      type: String,
      trim: true,
    },
    allergies: {
      type: [String],
      default: [],
    },
    medicalConditions: {
      type: [String],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
    },

    // CRM
    source: {
      type: String,
      enum: {
        values: ['Walk-In', 'Website', 'WhatsApp', 'Referral', 'Google Ads', 'Facebook Ads', 'Other'],
        message: '{VALUE} is not a valid source',
      },
      default: 'Walk-In',
    },

    // Status
    isActive: {
      type: Boolean,
      default: true,
    },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    // Phase 6.1 Task 05 — Patient History Foundation.
    // Placeholder fields only: defaults set here, nothing writes to
    // them yet. Reserved for future Appointment/Billing modules to
    // populate (e.g. on appointment completion / invoice creation).
    lastVisitAt:   { type: Date, default: null },
    lastInvoiceAt: { type: Date, default: null },
    totalVisits:   { type: Number, default: 0, min: 0 },
    totalInvoices: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Patient indexes
patientSchema.index({ clinicId: 1, patientId: 1 }, { unique: true });
patientSchema.index({ clinicId: 1, phone: 1 });
patientSchema.index({ clinicId: 1, fullName: 1 });
// Phase 9.0 — supports the dashboard's "active patients" count
// (Patient.countDocuments({ clinicId, isActive: true })) and any
// future active-patient list/filter, same rationale as the
// existing Doctor.{clinicId,isActive} index below.
patientSchema.index({ clinicId: 1, isActive: 1 });

// Hot-reload safe export
const Patient = mongoose.models.Patient || mongoose.model('Patient', patientSchema, 'patients');

/* ---------- DOCTOR SCHEMA ---------- */

const doctorSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    // Identity
    doctorId: {
      type: String,
      required: [true, 'doctorId is required'],
      trim: true,
    },
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
    },

    // Professional
    specialization: {
      type: String,
      trim: true,
    },
    qualification: {
      type: String,
      trim: true,
    },
    experienceYears: {
      type: Number,
      min: [0, 'Experience years cannot be negative'],
    },
    licenseNumber: {
      type: String,
      trim: true,
    },

    // Contact
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },

    // Avatar / initials — small UI conveniences, mirrors the frontend's
    // existing av-N / initials pattern (see global.js, doctors.js mocks).
    initials: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [3, 'initials must be 3 characters or fewer'],
    },
    avatarColor: {
      type: String,
      trim: true,
      default: 'av-1',
    },

    // Availability — Phase 7.0: replaces the old flat workingDays[] +
    // single workingHours{start,end} with one entry per weekday so the
    // future Appointment Engine can directly check "is this doctor open
    // on this day, and during this time window" without guessing.
    // Always exactly 7 entries (Mon..Sun), seeded on create.
    weeklyAvailability: {
      type: [
        {
          _id: false,
          day: {
            type: String,
            enum: {
              values: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
              message: '{VALUE} is not a valid day',
            },
            required: true,
          },
          isAvailable: { type: Boolean, default: false },
          startTime:   { type: String, trim: true }, // "09:00"
          endTime:     { type: String, trim: true }, // "17:00"
        },
      ],
      default: [],
    },

    // isAvailable: short-term, manually-toggled flag (e.g. "on leave
    // today", "in surgery") — independent of weeklyAvailability, which
    // describes the doctor's normal recurring schedule. Both are
    // checked together once the Appointment Engine validates a slot.
    isAvailable: {
      type: Boolean,
      default: true,
    },

    // Billing
    consultationFee: {
      type: Number,
      min: [0, 'Consultation fee cannot be negative'],
    },

    // Future: Calendar/Appointment integration (Phase 8.0+). Not
    // enforced or read anywhere yet — placeholder only, default keeps
    // existing behavior (30 min) identical to clinic-wide Settings.appointmentDuration.
    defaultSlotDurationMinutes: {
      type: Number,
      min: [1, 'defaultSlotDurationMinutes must be at least 1 minute'],
      default: null,
    },

    // Status
    isActive: {
      type: Boolean,
      default: true,
    },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Doctor indexes
doctorSchema.index({ clinicId: 1, doctorId: 1 }, { unique: true });
doctorSchema.index({ clinicId: 1, specialization: 1 });
doctorSchema.index({ clinicId: 1, isActive: 1 });
// Phase 7.0 — supports the doctor search endpoint (name/specialization
// substring search) and future "doctors available today" queries.
doctorSchema.index({ clinicId: 1, fullName: 1 });

// Hot-reload safe export
const Doctor = mongoose.models.Doctor || mongoose.model('Doctor', doctorSchema, 'doctors');

/* ---------- DEPARTMENT SCHEMA (Phase 12.5) ----------
   Single source of truth for every department used anywhere in the
   app (doctor specialization dropdown, appointment filters, dashboard
   widgets, reports, billing). Doctor.specialization itself stays a
   free-text string (no schema change / no data migration on Doctor —
   see Phase 12.5 scoping note); Department only supplies the allowed
   *values* for that dropdown going forward. Existing doctors with a
   specialization that has no matching Department are left as-is. */

const departmentSchema = new Schema(
  {
    // Ownership — every department belongs to exactly one clinic.
    // Different clinics may reuse the same department name freely;
    // uniqueness is enforced only within a clinic (index below).
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    departmentId: {
      type: String,
      required: [true, 'departmentId is required'],
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    // Optional UI accent color (hex or existing av-N-style token) —
    // purely cosmetic, no default enforced server-side.
    color: {
      type: String,
      trim: true,
    },
    // Controls display order in dropdowns/lists (Settings > Departments
    // "Reorder"). Lower sorts first. Not required to be contiguous.
    displayOrder: {
      type: Number,
      default: 0,
    },

    // Status — soft delete only. Inactive departments stay selectable
    // for doctors that already reference them, but cannot be chosen
    // when creating a new doctor (enforced in doctor create validation).
    isActive: {
      type: Boolean,
      default: true,
    },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Department indexes
departmentSchema.index({ clinicId: 1, departmentId: 1 }, { unique: true });
// Uniqueness of name is scoped per clinic and case-insensitive via a
// collation, so "Cardiology" and "cardiology" collide within a clinic
// but two different clinics can each have their own "Cardiology".
departmentSchema.index(
  { clinicId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);
departmentSchema.index({ clinicId: 1, isActive: 1 });
departmentSchema.index({ clinicId: 1, displayOrder: 1 });

// Hot-reload safe export
const Department = mongoose.models.Department || mongoose.model('Department', departmentSchema, 'departments');

/* ---------- APPOINTMENT SCHEMA ---------- */

const appointmentSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    // Relationships
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'patientId is required'],
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      required: [true, 'doctorId is required'],
    },

    // Scheduling
    // appointmentDate is stored normalized to midnight UTC (date-only —
    // see normalizeAppointmentDate() in section 4H) so same-day queries
    // and the conflict-check window are exact equality / simple range
    // matches, never timezone-dependent date-math.
    appointmentDate: {
      type: Date,
      required: [true, 'appointmentDate is required'],
    },
    startTime: {
      type: String,
      trim: true,
      required: [true, 'startTime is required'], // "HH:MM", 24hr — same format as Doctor.weeklyAvailability
    },
    endTime: {
      type: String,
      trim: true,
      required: [true, 'endTime is required'],
    },
    // Phase 8.0 — derived from startTime/endTime at creation time so
    // conflict checks, billing, and dashboard analytics don't need to
    // re-parse "HH:MM" strings on every read.
    durationMinutes: {
      type: Number,
      min: [1, 'durationMinutes must be at least 1 minute'],
    },

    // Visit type — matches the frontend's existing appointment-type
    // labels (see appointments.js mock data).
    type: {
      type: String,
      enum: {
        values: ['Consultation', 'Follow-up', 'Telemedicine', 'Procedure', 'Other'],
        message: '{VALUE} is not a valid appointment type',
      },
      default: 'Consultation',
    },

    // Status
    status: {
      type: String,
      enum: {
        values: ['scheduled', 'confirmed', 'waiting', 'completed', 'cancelled', 'no_show'],
        message: '{VALUE} is not a valid appointment status',
      },
      default: 'scheduled',
    },

    // Source
    source: {
      type: String,
      enum: {
        values: ['manual', 'website', 'whatsapp', 'phone_call'],
        message: '{VALUE} is not a valid source',
      },
      default: 'manual',
    },

    // Tracking — supports either a userId or the literal string 'automation'
    bookedBy: {
      type: Schema.Types.Mixed,
      validate: {
        validator: function (v) {
          if (v === null || v === undefined) return true;
          if (v === 'automation') return true;
          return mongoose.Types.ObjectId.isValid(v);
        },
        message: 'bookedBy must be a valid userId or the string "automation"',
      },
    },

    // Cancellation (Phase 8.0) — minimal metadata, only ever set when
    // status transitions to 'cancelled'. Kept on the document itself
    // rather than a separate collection, consistent with "no
    // unnecessary architecture" — the audit log is the source of
    // truth for the full history; these fields are just for fast,
    // no-join reads (e.g. "why was this cancelled" on the detail view).
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancellationReason: { type: String, trim: true, default: null },

    // Notes
    notes: {
      type: String,
      trim: true,
    },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Appointment indexes
appointmentSchema.index({ clinicId: 1, appointmentDate: 1 });
appointmentSchema.index({ clinicId: 1, doctorId: 1, appointmentDate: 1 });
appointmentSchema.index({ clinicId: 1, patientId: 1 });
appointmentSchema.index({ clinicId: 1, status: 1 });
// Phase 8.0 — the conflict-detection query (section 4H) filters by
// clinicId + doctorId + appointmentDate + status in every call; this
// compound index covers that query directly instead of falling back
// to the broader {clinicId, doctorId, appointmentDate} index above.
appointmentSchema.index({ clinicId: 1, doctorId: 1, appointmentDate: 1, status: 1 });

// Hot-reload safe export
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema, 'appointments');

/* ---------- INVOICE SCHEMA ---------- */

const invoiceItemSchema = new Schema(
  {
    description: { type: String, trim: true, required: [true, 'Item description is required'] },
    quantity:    { type: Number, required: [true, 'Item quantity is required'], min: [0, 'Quantity cannot be negative'] },
    price:       { type: Number, required: [true, 'Item price is required'], min: [0, 'Price cannot be negative'] },
    amount:      { type: Number, required: [true, 'Item amount is required'], min: [0, 'Amount cannot be negative'] },
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    // Relationships
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'patientId is required'],
    },
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Appointment',
    },

    // Invoice Info
    invoiceNumber: {
      type: String,
      required: [true, 'invoiceNumber is required'],
      trim: true,
    },
    invoiceDate: {
      type: Date,
      required: [true, 'invoiceDate is required'],
      default: Date.now,
    },

    // Items
    items: {
      type: [invoiceItemSchema],
      default: [],
    },

    // Totals — numbers only, never formatted currency strings
    subtotal: { type: Number, required: true, min: [0, 'Subtotal cannot be negative'] },
    tax:      { type: Number, default: 0, min: [0, 'Tax cannot be negative'] },
    discount: { type: Number, default: 0, min: [0, 'Discount cannot be negative'] },
    total:    { type: Number, required: true, min: [0, 'Total cannot be negative'] },

    // Payment
    paymentMethod: {
      type: String,
      trim: true,
    },
    paymentStatus: {
      type: String,
      enum: {
        values: ['paid', 'pending', 'overdue', 'cancelled'],
        message: '{VALUE} is not a valid payment status',
      },
      default: 'pending',
    },
    paidAt: {
      type: Date,
      default: null,
    },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Invoice indexes
invoiceSchema.index({ clinicId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ clinicId: 1, patientId: 1 });
invoiceSchema.index({ clinicId: 1, paymentStatus: 1 });

// Hot-reload safe export
const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema, 'invoices');

/* ---------- SETTINGS SCHEMA ---------- */
/* One document per clinic. */

const settingSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
      unique: true,
    },

    // Clinic Config
    clinicName: {
      type: String,
      trim: true,
    },
    logo: {
      type: String,
      trim: true,
    },
    contactNumber: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },
    address: {
      street:  { type: String, trim: true },
      city:    { type: String, trim: true },
      state:   { type: String, trim: true },
      country: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    // Business Rules
    workingHours: {
      start: { type: String, trim: true },
      end:   { type: String, trim: true },
    },
    appointmentDuration: {
      type: Number, // minutes
      default: 30,
      min: [1, 'Appointment duration must be at least 1 minute'],
    },

    // Billing
    taxPercentage: {
      type: Number,
      default: 0,
      min: [0, 'Tax percentage cannot be negative'],
    },
    currency: {
      type: String,
      trim: true,
      default: 'INR',
    },

    // Notifications
    emailEnabled:    { type: Boolean, default: true },
    smsEnabled:      { type: Boolean, default: false },
    whatsappEnabled: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Settings indexes
// (clinicId already has `unique: true` on the field above — no separate index needed)

// Hot-reload safe export
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema, 'settings');

/* ---------- PERMISSION SCHEMA (Phase 13.0) ----------
   One document per clinic. Stores the full role permission matrix:
   PERMISSION_ROLES × PERMISSION_MODULES × PERMISSION_ACTIONS.
   Foundation only — nothing in this phase enforces these values
   against menus, pages, or other API routes. That is future work. */

// The 4 clinic-scoped roles this matrix applies to. super_admin is a
// platform-level role with no clinic context (see tenantScope) and is
// intentionally excluded from the matrix — it isn't a per-clinic role.
const PERMISSION_ROLES = ['clinic_admin', 'doctor', 'receptionist', 'billing_staff'];

// Phase 13.0 defined the original 8 modules (dashboard..settings).
// Phase 13.1's enforcement doc explicitly lists two more enforcement
// targets alongside those 8: "Staff Management" and "Department
// Management" — both are real routers (staffRouter, departmentRouter)
// that were previously gated by hardcoded authorize(role) lists and
// have no natural home inside the original 8 (Staff and Departments
// each have their own distinct per-role read/write pattern that
// doesn't match Settings'). Adding them here, so every protected
// route in the app maps to a real permission module — none are left
// enforced by leftover hardcoded role checks.
const PERMISSION_MODULES = [
  'dashboard',
  'appointments',
  'patients',
  'doctors',
  'calendar',
  'billing',
  'reports',
  'settings',
  'staff',
  'departments',
];

const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'manage'];

// Builds a { view:false, create:false, ... } object for one module,
// used both as a Mongoose sub-schema shape and to construct defaults.
const buildActionsSchemaDef = () => {
  const def = {};
  for (const action of PERMISSION_ACTIONS) {
    def[action] = { type: Boolean, default: false };
  }
  return def;
};

const permissionModuleSchema = new Schema(buildActionsSchemaDef(), { _id: false });

const buildModulesSchemaDef = () => {
  const def = {};
  for (const mod of PERMISSION_MODULES) {
    def[mod] = { type: permissionModuleSchema, default: () => ({}) };
  }
  return def;
};

const permissionRoleSchema = new Schema(buildModulesSchemaDef(), { _id: false });

const buildRolesSchemaDef = () => {
  const def = {};
  for (const role of PERMISSION_ROLES) {
    def[role] = { type: permissionRoleSchema, default: () => ({}) };
  }
  return def;
};

const permissionSchema = new Schema(
  {
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
      unique: true,
    },
    matrix: {
      type: new Schema(buildRolesSchemaDef(), { _id: false }),
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// clinicId already has `unique: true` on the field above.

// Hot-reload safe export
const Permission = mongoose.models.Permission || mongoose.model('Permission', permissionSchema, 'permissions');

// ---------- Default Permission Matrix ----------
// Builds a fresh { view:false, create:false, ... } object with the
// given actions set to true. Every call returns a new object so
// multiple roles/modules never share (and accidentally mutate) the
// same nested object reference.
const grant = (...actions) => {
  const out = {};
  for (const action of PERMISSION_ACTIONS) out[action] = actions.includes(action);
  return out;
};

const NO_ACCESS = () => grant();
const FULL_ACCESS = () => grant(...PERMISSION_ACTIONS);
const VIEW_ONLY = () => grant('view');

// Phase 13.1 note: this matrix was audited against every authorize()
// role-list that existed on each route before Phase 13.1 replaced
// them with requirePermission(). Where the old system's role list
// was finer than a single per-module flag can express (e.g. Reports
// had 7 different role-lists across 7 sub-routes), the broadest
// previously-granted access for that role is preserved here — no
// role loses an ability it had before enforcement went live. Three
// gaps were found and fixed vs. the original Phase 13.0 defaults:
//   - doctors module:  billing_staff was NO_ACCESS but could always
//     GET /api/doctors (needed consultationFee for invoicing) -> view
//   - billing module:  doctor and receptionist were NO_ACCESS but
//     could both read invoices, and receptionist could also create/
//     edit them (front-desk billing entry) -> view / view+create+edit
//   - reports module:  doctor and receptionist were NO_ACCESS but
//     could both read the appointments report; receptionist could
//     also read the patient-growth report -> view for both
// patients module: doctor was VIEW+EDIT in the original Phase 13.0
// draft, but the actual PUT /api/patients/:id route was always
// clinic_admin + receptionist only — doctor never had edit. Fixed
// to VIEW_ONLY here.
const buildDefaultMatrix = () => ({
  clinic_admin: {
    dashboard:    FULL_ACCESS(),
    appointments: FULL_ACCESS(),
    patients:     FULL_ACCESS(),
    doctors:      FULL_ACCESS(),
    calendar:     FULL_ACCESS(),
    billing:      FULL_ACCESS(),
    reports:      FULL_ACCESS(),
    settings:     FULL_ACCESS(),
    staff:        FULL_ACCESS(),
    departments:  FULL_ACCESS(),
  },
  doctor: {
    dashboard:    VIEW_ONLY(),
    appointments: grant('view', 'edit'),   // edit covers PATCH /:id/status (confirm/start/complete/no-show)
    patients:     VIEW_ONLY(),
    doctors:      VIEW_ONLY(),
    calendar:     VIEW_ONLY(),
    billing:      VIEW_ONLY(),             // could always GET invoices + patient billing history
    reports:      VIEW_ONLY(),             // could always GET the appointments report
    settings:     NO_ACCESS(),
    staff:        NO_ACCESS(),
    departments:  VIEW_ONLY(),
  },
  receptionist: {
    dashboard:    VIEW_ONLY(),
    appointments: grant('view', 'create', 'edit'),
    patients:     grant('view', 'create', 'edit'),
    doctors:      VIEW_ONLY(),
    calendar:     grant('view', 'edit'),
    billing:      grant('view', 'create', 'edit'),   // could create/view/edit invoices; never payment/cancel
    reports:      VIEW_ONLY(),                        // could always GET appointments + patient-growth reports
    settings:     NO_ACCESS(),
    staff:        NO_ACCESS(),
    departments:  VIEW_ONLY(),
  },
  billing_staff: {
    dashboard:    VIEW_ONLY(),
    appointments: NO_ACCESS(),
    patients:     VIEW_ONLY(),
    doctors:      VIEW_ONLY(),             // could always GET /api/doctors (consultationFee for invoicing)
    calendar:     NO_ACCESS(),
    billing:      grant('view', 'create', 'edit', 'export', 'manage'),
    reports:      grant('view', 'export'),
    settings:     NO_ACCESS(),
    staff:        NO_ACCESS(),
    departments:  VIEW_ONLY(),
  },
});

/* ---------- NOTIFICATION SCHEMA ---------- */

const notificationSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    // Target
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },

    // Content
    title: {
      type: String,
      required: [true, 'Notification title is required'],
      trim: true,
    },
    message: {
      type: String,
      required: [true, 'Notification message is required'],
      trim: true,
    },
    type: {
      type: String,
      trim: true,
    },

    // Status
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },

    // Delivery
    channel: {
      type: String,
      enum: {
        values: ['system', 'email', 'sms', 'whatsapp'],
        message: '{VALUE} is not a valid notification channel',
      },
      default: 'system',
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Notification indexes
notificationSchema.index({ clinicId: 1, userId: 1 });
notificationSchema.index({ clinicId: 1, isRead: 1 });

// Hot-reload safe export
const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema, 'notifications');

/* ---------- AUDIT LOG SCHEMA ---------- */

const auditLogSchema = new Schema(
  {
    // Ownership
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: 'Clinic',
      required: [true, 'clinicId is required'],
    },

    // Actor
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },

    // Event
    action: {
      type: String,
      required: [true, 'action is required'],
      trim: true,
      // Examples: PATIENT_CREATED, PATIENT_UPDATED, APPOINTMENT_BOOKED, INVOICE_CREATED
    },
    entityType: {
      type: String,
      required: [true, 'entityType is required'],
      trim: true,
    },
    entityId: {
      type: Schema.Types.ObjectId,
    },

    // Metadata
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },

    // Phase 13.1 — optional structured context for entries that need
    // more than entityType/entityId can express, e.g. PERMISSION_DENIED
    // stores { role, module, action, route, method }. Every audit call
    // that existed before Phase 13.1 omits this field entirely and is
    // unaffected — it has no default and isn't required.
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    // createdAt only — audit logs are immutable, no updatedAt needed
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// Audit log indexes
auditLogSchema.index({ clinicId: 1, action: 1 });
auditLogSchema.index({ clinicId: 1, entityType: 1 });
auditLogSchema.index({ clinicId: 1, createdAt: 1 });

// Hot-reload safe export
const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema, 'audit_logs');

/* ============================================================
   2. DATABASE CONNECTION
   ============================================================ */

const connectDB = async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  console.log(`✅  MongoDB connected: ${mongoose.connection.host}`);
};

mongoose.connection.on('connected',    () => console.log('📗  Mongoose: connected'));
mongoose.connection.on('disconnected', () => console.warn('📙  Mongoose: disconnected'));
mongoose.connection.on('reconnected',  () => console.log('📗  Mongoose: reconnected'));
mongoose.connection.on('error',  (err) => console.error('❌  Mongoose error:', err.message));

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n⚠️   ${signal} — closing MongoDB...`);
  await mongoose.connection.close();
  console.log('📕  MongoDB closed. Goodbye.');
  process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ============================================================
   3. EXPRESS APP
   ============================================================ */

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src-attr": ["'unsafe-inline'"],
      "script-src":  ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "style-src":   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src":    ["'self'", "https://fonts.gstatic.com"],
      // Fix: allow fetch() calls from the frontend (dashboard.js, api.js)
      // to reach the local API and any CDN source maps.
      "connect-src": ["'self'", `http://localhost:${PORT}`, "https://cdn.jsdelivr.net"],
      // Fix: allow data: URIs used by Chart.js for canvas rendering
      "img-src":     ["'self'", "data:"],
    },
  },
}));

if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS) {
  console.warn('⚠️   ALLOWED_ORIGINS not set in production — all cross-origin requests will be blocked.');
}
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGINS?.split(',') || []
    : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false }));
app.use(mongoSanitize());      // NoSQL injection protection
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

/* ============================================================
   3B. STATIC FRONTEND
   The frontend (index.html, dashboard.html, css/, js/) lives one
   directory above this file: clinic-management/ — server.js sits
   in clinic-management/server/. FRONTEND_ROOT can be overridden
   via env var if the folder layout ever changes.
   ============================================================ */

const FRONTEND_ROOT = process.env.FRONTEND_ROOT
  ? path.resolve(process.env.FRONTEND_ROOT)
  : path.join(__dirname, '..');

app.use(express.static(FRONTEND_ROOT));

/* ============================================================
   4. ROUTES
   ============================================================ */

// Health check — modular route (controllers/health.controller.js, routes/health.routes.js)
app.use('/api/health', require('../routes/health.routes'));

/* ============================================================
   4B. AUTHENTICATION & RBAC (Phase 4.0)
   Inlined here per project convention — kept lightweight,
   no repository/DTO pattern, no separate files.
   ============================================================ */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const SALT_ROUNDS       = 12;
const JWT_EXPIRES_IN    = process.env.JWT_EXPIRES_IN || '8h';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS   = 15 * 60 * 1000; // 15 minutes

// Task 07 (Phase 4.2) — lightweight security event logging.
// NEVER pass passwords, tokens, or secrets into this. Only safe,
// non-sensitive identifiers (email, userId, role, IP, route).
const logSecurityEvent = (event, details = {}) => {
  console.warn(`🔒  [SECURITY] ${event}`, {
    ...details,
    timestamp: new Date().toISOString(),
  });
};

/* ---------- password helpers ---------- */

const hashPassword = (plainPassword) => bcrypt.hash(plainPassword, SALT_ROUNDS);
const comparePassword = (plainPassword, passwordHash) => bcrypt.compare(plainPassword, passwordHash);

/* ---------- jwt helpers ---------- */

const signToken = ({ userId, clinicId, role }) =>
  jwt.sign({ userId, clinicId, role }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });

// Task 02 (Phase 4.2) — explicit algorithm allow-list. Rejects any token
// signed with an unexpected algorithm (including "none"), rather than
// relying on jsonwebtoken's default behavior.
const verifyJwt = (token) => jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

/* ---------- response sanitization ---------- */

// Strips fields that must never leave the API, beyond what the
// User schema's toJSON transform already removes (passwordHash, __v).
const sanitizeUser = (userDoc) => {
  const safe = userDoc.toJSON();
  delete safe.loginAttempts;
  delete safe.lockUntil;
  return safe;
};

/* ---------- authenticate() ----------
   Reads JWT, verifies it, loads the user, attaches req.user.
   req.user.clinicId always comes from the verified JWT — never
   from request body, query params, or any frontend-supplied value. */

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    // Task 05 — single generic message for every authentication failure
    // mode (missing/invalid/expired/malformed token). Status code still
    // distinguishes cases internally for logging, but the client-facing
    // message never reveals which specific check failed.
    const authFailedError = (statusCode = 401) => {
      const error = new Error('Authentication failed');
      error.statusCode = statusCode;
      return error;
    };

    if (scheme !== 'Bearer' || !token) {
      throw authFailedError(401);
    }

    let decoded;
    try {
      decoded = verifyJwt(token);
    } catch (err) {
      // Task 07 — log the real reason internally without leaking it to the client
      logSecurityEvent('Invalid JWT', { reason: err.name, route: req.originalUrl });
      throw authFailedError(401);
    }

    // Task 06 — validate the token's userId is a well-formed ObjectId
    // before querying, so a malformed/tampered id returns 401, not a
    // 500 CastError.
    if (!mongoose.Types.ObjectId.isValid(decoded.userId)) {
      logSecurityEvent('Invalid JWT', { reason: 'Malformed userId claim', route: req.originalUrl });
      throw authFailedError(401);
    }

    const user = await User.findById(decoded.userId);

    if (!user) {
      throw authFailedError(401);
    }
    if (!user.isActive) {
      logSecurityEvent('Unauthorized access attempt', { userId: String(user._id), reason: 'Account suspended', route: req.originalUrl });
      throw authFailedError(403);
    }
    if (user.lockUntil && user.lockUntil > new Date()) {
      logSecurityEvent('Unauthorized access attempt', { userId: String(user._id), reason: 'Account locked', route: req.originalUrl });
      throw authFailedError(403);
    }

    // Phase 14.2 (Visibility Engine Improvements) — Goal 1: enrich
    // req.user with doctorId so the Visibility Engine never needs a
    // second DB lookup to identify "the current doctor". `user` is
    // already fetched above for the isActive/lockUntil checks, so
    // this reads off the same document instead of querying again.
    // null for every non-doctor role (and for a doctor-role account
    // that was never linked to a Doctor record) — never omitted, so
    // downstream code can rely on the key always being present.
    req.user = {
      userId: String(user._id),
      clinicId: decoded.clinicId,
      role: decoded.role,
      doctorId: user.doctorId ? String(user.doctorId) : null,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/* ---------- authorize() — RBAC ----------
   Must run after authenticate(). */

const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    const error = new Error('Authentication failed');
    error.statusCode = 401;
    return next(error);
  }
  if (!allowedRoles.includes(req.user.role)) {
    logSecurityEvent('Unauthorized access attempt', {
      userId: req.user.userId,
      role: req.user.role,
      requiredRoles: allowedRoles,
      route: req.originalUrl,
    });
    const error = new Error('You do not have permission to perform this action');
    error.statusCode = 403;
    return next(error);
  }
  next();
};

/* ---------- tenantScope() — tenant isolation foundation ----------
   Must run after authenticate(). Critical security rule: req.clinicId
   is derived only from the JWT, never from body/query/frontend. */

const tenantScope = (req, res, next) => {
  if (!req.user) {
    const error = new Error('Authentication failed');
    error.statusCode = 401;
    return next(error);
  }
  if (req.user.role === 'super_admin') {
    req.clinicId = null;
    return next();
  }
  if (!req.user.clinicId) {
    const error = new Error('No clinic associated with this account');
    error.statusCode = 403;
    return next(error);
  }
  req.clinicId = req.user.clinicId;
  next();
};

/* ---------- route handlers ---------- */

const handleLogin = async (req, res, next) => {
  try {
    const { email, username, password } = req.body;

    // Phase 14.0 (Staff Management) — staff accounts (doctor/
    // receptionist) log in with `username`; admin accounts keep using
    // `email` exactly as before (index.html's login form is UNCHANGED
    // and only ever sends `email`, so this branch never executes for
    // existing admin logins). Lockout/lock-duration/rate-limit logic
    // below is identical for both — only the lookup field differs.
    const usingUsername = !!username;
    const identifierValue = usingUsername ? username : email;

    if (!identifierValue || !password) {
      const error = new Error(`${usingUsername ? 'Username' : 'Email'} and password are required`);
      error.statusCode = 400;
      throw error;
    }

    const user = usingUsername
      ? await User.findOne({ username: String(username).toLowerCase().trim() })
      : await User.findOne({ email: String(email).toLowerCase().trim() });

    const invalidCredentialsError = () => {
      const error = new Error(usingUsername ? 'Invalid username or password' : 'Invalid email or password');
      error.statusCode = 401;
      return error;
    };

    if (!user) {
      logSecurityEvent('Failed login', { reason: usingUsername ? 'Unknown username' : 'Unknown email' });
      throw invalidCredentialsError();
    }

    if (user.lockUntil && user.lockUntil > new Date()) {
      logSecurityEvent('Unauthorized access attempt', { userId: String(user._id), reason: 'Login while locked' });
      const error = new Error('Account temporarily locked due to repeated failed login attempts');
      error.statusCode = 403;
      throw error;
    }
    if (!user.isActive) {
      logSecurityEvent('Unauthorized access attempt', { userId: String(user._id), reason: 'Login while suspended' });
      const error = new Error('Account is suspended. Contact your administrator.');
      error.statusCode = 403;
      throw error;
    }

    const passwordValid = await comparePassword(password, user.passwordHash);

    if (!passwordValid) {
      user.loginAttempts += 1;
      if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        user.lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
        user.loginAttempts = 0;
        logSecurityEvent('Account lock', { userId: String(user._id), reason: 'Max failed attempts reached' });
      } else {
        logSecurityEvent('Failed login', { userId: String(user._id), reason: 'Wrong password', attempts: user.loginAttempts });
      }
      await user.save();
      throw invalidCredentialsError();
    }

    user.loginAttempts = 0;
    user.lockUntil = null;
    user.lastLoginAt = new Date();
    await user.save();

    const token = signToken({
      userId: String(user._id),
      clinicId: user.clinicId ? String(user.clinicId) : null,
      role: user.role,
    });

    res.status(200).json({ success: true, token, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
};

const handleMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      const error = new Error('User no longer exists');
      error.statusCode = 401;
      throw error;
    }
    res.status(200).json({ success: true, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
};

/* ---------- auth routes ---------- */

// Task 01 (Phase 4.2) — stricter, login-specific rate limiter, separate
// from the global API limiter. Keyed by IP (express-rate-limit default).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in a few minutes.' },
  handler: (req, res /*, next, options */) => {
    res.status(429).json({ success: false, message: 'Too many login attempts. Please try again in a few minutes.' });
  },
});

const authRouter = express.Router();
authRouter.post('/login', loginLimiter, handleLogin);
authRouter.get('/me', authenticate, handleMe);
app.use('/api/auth', authRouter);

/* ---------- temporary RBAC test routes (Task 12, Phase 4.0) ----------
   Development-only — remove once Phase 5.0 business routes
   exist and have been manually confirmed to enforce roles.

   Task 04 (Phase 4.2) — disabled in production. */

const blockInProduction = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, message: 'Route unavailable' });
  }
  next();
};

const testRouter = express.Router();
testRouter.use(blockInProduction);
testRouter.get('/admin', authenticate, authorize('super_admin', 'clinic_admin'), (req, res) => {
  res.status(200).json({ success: true, message: 'Admin access confirmed', user: req.user });
});
testRouter.get('/doctor', authenticate, authorize('doctor'), (req, res) => {
  res.status(200).json({ success: true, message: 'Doctor access confirmed', user: req.user });
});
app.use('/api/test', testRouter);

/* ============================================================
   4C. VALIDATION HELPERS (Phase 5.0A — Task 09)
   Used by the Clinic & Settings update endpoints below.
   ============================================================ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // same pattern used by Clinic/User/Patient schemas
const PHONE_RE = /^[+]?[\d\s-]{7,20}$/;

const isValidEmail = (value) => typeof value === 'string' && EMAIL_RE.test(value.trim());
const isValidPhone = (value) => typeof value === 'string' && PHONE_RE.test(value.trim());

const isValidUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const isValidTaxPercentage = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

const isValidAppointmentDuration = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 480; // 8 hours — sanity cap

/* ============================================================
   4C-2. INITIAL ADMIN SETUP (Phase 11.6)
   One-time, self-bootstrapping setup for the very first clinic
   administrator on a fresh install. No setup flags are stored
   anywhere — User.countDocuments() === 0 is the only source of
   truth for "setup required". Once any user exists, the creation
   endpoint is permanently disabled (403). Reuses existing User/
   Clinic/Settings schemas, password hashing, validation helpers,
   and AuditLog — no new layers, no new files.
   ============================================================ */

// Slug helper for the auto-created Clinic record. Lowercases,
// strips non-alphanumerics to hyphens, then appends a short random
// suffix so two clinics with similar names never collide on the
// unique `slug` index.
const slugify = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'clinic';

const generateClinicSlug = (clinicName) => {
  const base = slugify(clinicName);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
};

const isStrongEnoughPassword = (value) =>
  typeof value === 'string' && value.length >= 8;

// Setup-specific limiter — separate from loginLimiter. This route
// only ever does meaningful work once per install (first call wins),
// but keeps brute-force/spam attempts from hammering bcrypt hashing.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many setup attempts. Please try again in a few minutes.' },
  handler: (req, res /*, next, options */) => {
    res.status(429).json({ success: false, message: 'Too many setup attempts. Please try again in a few minutes.' });
  },
});

// GET /api/setup/status — setupRequired is derived live from
// User.countDocuments() on every call. Never cached, never stored.
const getSetupStatus = async (req, res, next) => {
  try {
    const userCount = await User.countDocuments();
    res.status(200).json({ success: true, setupRequired: userCount === 0 });
  } catch (err) {
    next(err);
  }
};

// POST /api/setup/initial-admin — allowed ONLY while User.countDocuments() === 0.
// Creates Clinic + Settings + the first User (role: clinic_admin) in one flow.
const createInitialAdmin = async (req, res, next) => {
  try {
    // Security rule: never allow a second initial admin. Re-check
    // immediately before writing anything, so this stays the single
    // source of truth even under concurrent requests on a fresh install.
    const existingUserCount = await User.countDocuments();
    if (existingUserCount > 0) {
      logSecurityEvent('Unauthorized access attempt', { reason: 'Initial admin setup attempted after setup complete', route: req.originalUrl });
      const error = new Error('Setup has already been completed');
      error.statusCode = 403;
      throw error;
    }

    const body = req.body || {};
    const { clinicName, ownerName, email, password, confirmPassword } = body;

    if (typeof clinicName !== 'string' || !clinicName.trim()) {
      const error = new Error('Clinic name is required');
      error.statusCode = 400;
      throw error;
    }
    if (typeof ownerName !== 'string' || !ownerName.trim()) {
      const error = new Error('Owner name is required');
      error.statusCode = 400;
      throw error;
    }
    if (!isValidEmail(email)) {
      const error = new Error('A valid email address is required');
      error.statusCode = 400;
      throw error;
    }
    if (!isStrongEnoughPassword(password)) {
      const error = new Error('Password must be at least 8 characters long');
      error.statusCode = 400;
      throw error;
    }
    if (password !== confirmPassword) {
      const error = new Error('Password and confirmation do not match');
      error.statusCode = 400;
      throw error;
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Create Clinic, then Settings (reusing DEFAULT_SETTINGS — same
    // defaults getOrCreateSettings would apply), then the clinic_admin
    // User. Clinic must exist first since both Settings and User
    // reference clinicId.
    const clinic = await Clinic.create({
      name: clinicName.trim(),
      slug: generateClinicSlug(clinicName),
      ownerEmail: normalizedEmail,
      status: 'active',
    });

    const settings = await Setting.create({
      clinicId: clinic._id,
      ...DEFAULT_SETTINGS,
    });

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await User.create({
        clinicId: clinic._id,
        name: ownerName.trim(),
        email: normalizedEmail,
        passwordHash,
        role: 'clinic_admin',
        isActive: true,
      });
    } catch (userErr) {
      // Roll back the clinic/settings if user creation fails (e.g. a
      // race lost to another concurrent setup request), so a fresh
      // install never ends up with an orphaned Clinic and no admin.
      await Clinic.findByIdAndDelete(clinic._id).catch(() => {});
      await Setting.findByIdAndDelete(settings._id).catch(() => {});
      throw userErr;
    }

    await AuditLog.create({
      clinicId: clinic._id,
      userId: user._id,
      action: 'INITIAL_ADMIN_CREATED',
      entityType: 'User',
      entityId: user._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const token = signToken({
      userId: String(user._id),
      clinicId: String(clinic._id),
      role: user.role,
    });

    res.status(201).json({
      success: true,
      message: 'Initial administrator created successfully',
      token,
      user: sanitizeUser(user),
      clinic,
    });
  } catch (err) {
    next(err);
  }
};

const setupRouter = express.Router();
setupRouter.get('/status', getSetupStatus);
setupRouter.post('/initial-admin', setupLimiter, createInitialAdmin);
app.use('/api/setup', setupRouter);

/* ============================================================
   4D. CLINIC MANAGEMENT (Phase 5.0A — Tasks 01, 02)
   Inlined per project convention (see Phase 4.0 auth section
   above). req.clinicId is sourced ONLY from tenantScope(), which
   itself reads only the verified JWT — never req.body / req.query
   / req.params. See Task 07 (Tenant Isolation).
   ============================================================ */

// super_admin has no single clinicId (tenantScope sets it to null
// for that role). These endpoints always mean "my clinic" — a
// super_admin has no "my clinic" and must be blocked here rather
// than silently querying with a null id.
const requireClinicContext = (req, res, next) => {
  if (!req.clinicId) {
    const error = new Error('This endpoint requires an account scoped to a clinic');
    error.statusCode = 400;
    return next(error);
  }
  next();
};

/* ============================================================
   requirePermission(module, action) — Permission Engine enforcement
   (Phase 13.1)

   Must run after authenticate() + tenantScope() + requireClinicContext()
   — it needs both req.user.role and a real req.clinicId. This is the
   single, reusable enforcement point for every protected route in the
   app: no endpoint hand-rolls its own role check, and this function
   contains zero hardcoded role names (no `if (role === 'clinic_admin')`
   anywhere below). Every allow/deny decision is a lookup against the
   Permission document stored in MongoDB for req.clinicId — the exact
   same matrix Settings > Role Permissions reads and writes in Phase
   13.0. Editing that matrix takes effect on the very next request,
   with no code change and no restart.

   Usage: requirePermission('patients', 'view')
          requirePermission('settings', 'manage')

   Deliberately does NOT special-case clinic_admin. clinic_admin
   passes because buildDefaultMatrix() grants it FULL_ACCESS() on
   every module — i.e. admin authority lives in the data, not in
   this function. If a clinic_admin's own matrix entry were ever
   edited down, this function would enforce that too; nothing here
   silently overrides the stored matrix for any role.

   Performance: the Permission doc is small (one document per
   clinic) and is fetched at most once per request — see
   loadPermissionMatrixOnce() below, which memoizes the lookup on
   req for the lifetime of a single request so a route that chains
   multiple requirePermission() calls (rare, but not disallowed)
   never queries MongoDB twice for the same request. */

// Loads (and request-memoizes) the clinic's permission matrix. Reuses
// the same auto-create-on-missing behavior as Phase 13.0's
// getOrCreatePermissions, so a clinic with no Permission document yet
// still gets sensible defaults instead of every action being denied.
const loadPermissionMatrixOnce = async (req) => {
  if (req._permissionMatrix) return req._permissionMatrix;
  let perm = await Permission.findOne({ clinicId: req.clinicId }).lean();
  if (!perm) {
    perm = await Permission.create({ clinicId: req.clinicId, matrix: buildDefaultMatrix() });
    perm = perm.toObject();
  }
  req._permissionMatrix = perm.matrix || {};
  return req._permissionMatrix;
};

const requirePermission = (moduleName, actionName) => async (req, res, next) => {
  try {
    if (!req.user) {
      const error = new Error('Authentication failed');
      error.statusCode = 401;
      return next(error);
    }
    if (!req.clinicId) {
      const error = new Error('This endpoint requires an account scoped to a clinic');
      error.statusCode = 400;
      return next(error);
    }

    const role = req.user.role;

    // A role that isn't one of the 4 clinic-scoped permission roles
    // (i.e. super_admin, or anything unrecognized) has no matrix entry
    // and is denied — this function only grants access that the
    // stored matrix explicitly grants, never by omission.
    const matrix = await loadPermissionMatrixOnce(req);
    const allowed = Boolean(matrix?.[role]?.[moduleName]?.[actionName]);

    if (!allowed) {
      // Doc: "Log permission failures... Do NOT log successful
      // permission checks." Fire-and-forget — a logging failure must
      // never block or alter the 403 response.
      AuditLog.create({
        clinicId: req.clinicId,
        userId: req.user.userId,
        action: 'PERMISSION_DENIED',
        entityType: 'Permission',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { role, module: moduleName, action: actionName, route: req.originalUrl, method: req.method },
      }).catch((logErr) => {
        console.error('Failed to write PERMISSION_DENIED audit log:', logErr);
      });

      logSecurityEvent('Permission denied', {
        userId: req.user.userId,
        role,
        module: moduleName,
        action: actionName,
        route: req.originalUrl,
      });

      const error = new Error('You do not have permission to perform this action.');
      error.statusCode = 403;
      return next(error);
    }

    next();
  } catch (err) {
    next(err);
  }
};

const getClinic = async (req, res, next) => {
  try {
    const clinic = await Clinic.findById(req.clinicId);
    if (!clinic) {
      const error = new Error('Clinic not found');
      error.statusCode = 404;
      throw error;
    }
    res.status(200).json({ success: true, data: clinic });
  } catch (err) {
    next(err);
  }
};

const updateClinic = async (req, res, next) => {
  try {
    const body = req.body || {};

    // Task 02 — explicit whitelist. Anything not listed here
    // (including clinicId, subscription, plan, status) is silently
    // dropped, never merged in, no matter what the client sends.
    const updates = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        const error = new Error('Clinic name must be a non-empty string');
        error.statusCode = 400;
        throw error;
      }
      updates.name = body.name.trim();
    }

    if (body.phone !== undefined) {
      if (!isValidPhone(body.phone)) {
        const error = new Error('Invalid phone number');
        error.statusCode = 400;
        throw error;
      }
      updates.phone = body.phone.trim();
    }

    if (body.email !== undefined) {
      if (!isValidEmail(body.email)) {
        const error = new Error('Invalid email address');
        error.statusCode = 400;
        throw error;
      }
      updates.ownerEmail = body.email.trim().toLowerCase();
    }

    // Address sub-fields are set with dot-notation so a partial
    // address update (e.g. only `city`) never wipes the other
    // address fields already stored on the document.
    if (body.address !== undefined) {
      if (typeof body.address !== 'object' || body.address === null || Array.isArray(body.address)) {
        const error = new Error('Address must be an object');
        error.statusCode = 400;
        throw error;
      }
      const { street, city, state, country, pincode } = body.address;
      if (street  !== undefined) updates['address.street']  = String(street).trim();
      if (city    !== undefined) updates['address.city']    = String(city).trim();
      if (state   !== undefined) updates['address.state']   = String(state).trim();
      if (country !== undefined) updates['address.country'] = String(country).trim();
      if (pincode !== undefined) updates['address.pincode'] = String(pincode).trim();
    }

    if (body.website !== undefined) {
      if (!isValidUrl(body.website)) {
        const error = new Error('Invalid website URL (must include http:// or https://)');
        error.statusCode = 400;
        throw error;
      }
      updates['branding.website'] = body.website.trim();
    }

    if (body.logo !== undefined) {
      if (typeof body.logo !== 'string' || !body.logo.trim()) {
        const error = new Error('Logo must be a non-empty string (URL)');
        error.statusCode = 400;
        throw error;
      }
      updates['branding.logo'] = body.logo.trim();
    }

    if (body.tagline !== undefined) {
      if (typeof body.tagline !== 'string') {
        const error = new Error('Tagline must be a string');
        error.statusCode = 400;
        throw error;
      }
      updates['branding.tagline'] = body.tagline.trim();
    }

    if (Object.keys(updates).length === 0) {
      const error = new Error('No valid fields provided to update');
      error.statusCode = 400;
      throw error;
    }

    const clinic = await Clinic.findByIdAndUpdate(
      req.clinicId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!clinic) {
      const error = new Error('Clinic not found');
      error.statusCode = 404;
      throw error;
    }

    // Task 08 — audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'CLINIC_UPDATED',
      entityType: 'Clinic',
      entityId: clinic._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: clinic });
  } catch (err) {
    next(err);
  }
};

// Task 06 — RBAC: all 5 roles can read, only super_admin/clinic_admin can write.
const clinicRouter = express.Router();
clinicRouter.get('/', authenticate, tenantScope, requireClinicContext, getClinic);
clinicRouter.put('/', authenticate, tenantScope, requireClinicContext, requirePermission('settings', 'manage'), updateClinic);
app.use('/api/clinic', clinicRouter);

/* ============================================================
   4E. SETTINGS MANAGEMENT (Phase 5.0A — Tasks 03, 04, 05)
   One Settings document per clinic. Auto-created with sane
   defaults on first read or first write if it doesn't exist yet.
   ============================================================ */

const DEFAULT_SETTINGS = {
  appointmentDuration: 30,
  currency: 'INR',
  taxPercentage: 0,
};

// Task 05 — settings auto-creation, shared by GET.
const getOrCreateSettings = async (clinicId) => {
  let settings = await Setting.findOne({ clinicId });
  if (!settings) {
    settings = await Setting.create({ clinicId, ...DEFAULT_SETTINGS });
  }
  return settings;
};

const getSettings = async (req, res, next) => {
  try {
    const settings = await getOrCreateSettings(req.clinicId);
    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
};

const updateSettings = async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.workingHours !== undefined) {
      if (typeof body.workingHours !== 'object' || body.workingHours === null || Array.isArray(body.workingHours)) {
        const error = new Error('workingHours must be an object with start/end');
        error.statusCode = 400;
        throw error;
      }
      const { start, end } = body.workingHours;
      if (start !== undefined) updates['workingHours.start'] = String(start).trim();
      if (end   !== undefined) updates['workingHours.end']   = String(end).trim();
    }

    if (body.appointmentDuration !== undefined) {
      if (!isValidAppointmentDuration(body.appointmentDuration)) {
        const error = new Error('appointmentDuration must be an integer between 1 and 480 minutes');
        error.statusCode = 400;
        throw error;
      }
      updates.appointmentDuration = body.appointmentDuration;
    }

    if (body.currency !== undefined) {
      if (typeof body.currency !== 'string' || !body.currency.trim()) {
        const error = new Error('currency must be a non-empty string');
        error.statusCode = 400;
        throw error;
      }
      updates.currency = body.currency.trim().toUpperCase();
    }

    if (body.taxPercentage !== undefined) {
      if (!isValidTaxPercentage(body.taxPercentage)) {
        const error = new Error('taxPercentage must be a number between 0 and 100');
        error.statusCode = 400;
        throw error;
      }
      updates.taxPercentage = body.taxPercentage;
    }

    if (body.emailEnabled !== undefined) {
      if (typeof body.emailEnabled !== 'boolean') {
        const error = new Error('emailEnabled must be a boolean');
        error.statusCode = 400;
        throw error;
      }
      updates.emailEnabled = body.emailEnabled;
    }
    if (body.smsEnabled !== undefined) {
      if (typeof body.smsEnabled !== 'boolean') {
        const error = new Error('smsEnabled must be a boolean');
        error.statusCode = 400;
        throw error;
      }
      updates.smsEnabled = body.smsEnabled;
    }
    if (body.whatsappEnabled !== undefined) {
      if (typeof body.whatsappEnabled !== 'boolean') {
        const error = new Error('whatsappEnabled must be a boolean');
        error.statusCode = 400;
        throw error;
      }
      updates.whatsappEnabled = body.whatsappEnabled;
    }

    if (Object.keys(updates).length === 0) {
      const error = new Error('No valid fields provided to update');
      error.statusCode = 400;
      throw error;
    }

    // Task 04 + 05 combined — upsert so a missing settings doc is
    // created correctly even if PUT is called before any GET.
    // $setOnInsert only fills defaults for keys NOT already present
    // in `updates`, since Mongo rejects $set and $setOnInsert
    // touching the same path in one update.
    const setOnInsert = { clinicId: req.clinicId };
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in updates)) setOnInsert[key] = val;
    }

    const settings = await Setting.findOneAndUpdate(
      { clinicId: req.clinicId },
      { $set: updates, $setOnInsert: setOnInsert },
      { new: true, upsert: true, runValidators: true }
    );

    // Task 08 — audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'SETTINGS_UPDATED',
      entityType: 'Setting',
      entityId: settings._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
};

// Task 06 — RBAC: all 5 roles can read, only super_admin/clinic_admin can write.
const settingsRouter = express.Router();
settingsRouter.get('/', authenticate, tenantScope, requireClinicContext, getSettings);
settingsRouter.put('/', authenticate, tenantScope, requireClinicContext, requirePermission('settings', 'manage'), updateSettings);
app.use('/api/settings', settingsRouter);

/* ============================================================
   4E.1 PERMISSION ENGINE (Phase 13.0 — foundation only)
   One Permission document per clinic, auto-created with the
   default matrix on first read or first write if missing —
   same pattern as 4E Settings above. No enforcement here: this
   only loads, updates, and resets the stored matrix.
   ============================================================ */

// Task — auto-creation, shared by GET and reset.
const getOrCreatePermissions = async (clinicId) => {
  let perm = await Permission.findOne({ clinicId }).lean();
  if (!perm) {
    perm = await Permission.create({ clinicId, matrix: buildDefaultMatrix() });
    perm = perm.toObject();
  }
  return perm;
};

const getPermissions = async (req, res, next) => {
  try {
    const perm = await getOrCreatePermissions(req.clinicId);
    res.status(200).json({ success: true, data: perm });
  } catch (err) {
    next(err);
  }
};

// Validates the incoming matrix shape before it ever reaches Mongo:
// only known roles, only known modules, only known actions, and
// every action value must be a boolean. Anything else is a 400 —
// per doc: "Reject unknown roles. Reject unknown permission names.
// Reject malformed payloads."
const validatePermissionMatrix = (matrix) => {
  if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix)) {
    return 'matrix must be an object';
  }
  for (const roleKey of Object.keys(matrix)) {
    if (!PERMISSION_ROLES.includes(roleKey)) {
      return `Unknown role: ${roleKey}`;
    }
    const roleVal = matrix[roleKey];
    if (typeof roleVal !== 'object' || roleVal === null || Array.isArray(roleVal)) {
      return `matrix.${roleKey} must be an object`;
    }
    for (const moduleKey of Object.keys(roleVal)) {
      if (!PERMISSION_MODULES.includes(moduleKey)) {
        return `Unknown permission module: ${moduleKey}`;
      }
      const moduleVal = roleVal[moduleKey];
      if (typeof moduleVal !== 'object' || moduleVal === null || Array.isArray(moduleVal)) {
        return `matrix.${roleKey}.${moduleKey} must be an object`;
      }
      for (const actionKey of Object.keys(moduleVal)) {
        if (!PERMISSION_ACTIONS.includes(actionKey)) {
          return `Unknown permission action: ${actionKey}`;
        }
        if (typeof moduleVal[actionKey] !== 'boolean') {
          return `matrix.${roleKey}.${moduleKey}.${actionKey} must be a boolean`;
        }
      }
    }
  }
  return null;
};

const updatePermissions = async (req, res, next) => {
  try {
    const { matrix } = req.body || {};

    if (matrix === undefined) {
      const error = new Error('matrix is required');
      error.statusCode = 400;
      throw error;
    }

    const validationError = validatePermissionMatrix(matrix);
    if (validationError) {
      const error = new Error(validationError);
      error.statusCode = 400;
      throw error;
    }

    // Ensure a document exists first so a partial payload (e.g. only
    // "doctor" included) merges into existing/default data instead of
    // wiping out the roles that were omitted from the request body.
    await getOrCreatePermissions(req.clinicId);

    const setOps = {};
    for (const [roleKey, roleVal] of Object.entries(matrix)) {
      for (const [moduleKey, moduleVal] of Object.entries(roleVal)) {
        for (const [actionKey, actionBool] of Object.entries(moduleVal)) {
          setOps[`matrix.${roleKey}.${moduleKey}.${actionKey}`] = actionBool;
        }
      }
    }

    const updated = await Permission.findOneAndUpdate(
      { clinicId: req.clinicId },
      { $set: setOps },
      { new: true, runValidators: true }
    ).lean();

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'PERMISSIONS_UPDATED',
      entityType: 'Permission',
      entityId: updated._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

const resetPermissions = async (req, res, next) => {
  try {
    const defaults = buildDefaultMatrix();

    const updated = await Permission.findOneAndUpdate(
      { clinicId: req.clinicId },
      { $set: { matrix: defaults } },
      { new: true, upsert: true, runValidators: true }
    ).lean();

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'PERMISSIONS_RESET',
      entityType: 'Permission',
      entityId: updated._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// RBAC: any authenticated clinic-scoped role may load permissions
// (doc: "Other users may load permissions if needed"). Only
// clinic_admin may update or reset them (doc: "Only clinic_admin
// can modify permissions"). super_admin has no clinicId and is
// blocked by requireClinicContext, same as Clinic/Settings above.
const permissionRouter = express.Router();
permissionRouter.get('/', authenticate, tenantScope, requireClinicContext, getPermissions);
permissionRouter.put('/', authenticate, tenantScope, requireClinicContext, requirePermission('settings', 'manage'), updatePermissions);
permissionRouter.post('/reset', authenticate, tenantScope, requireClinicContext, requirePermission('settings', 'manage'), resetPermissions);
app.use('/api/permissions', permissionRouter);

/* ============================================================
   4F. PATIENT MANAGEMENT (Phase 6.0A — Tasks 01–10)
   Inlined per project convention (see 4D/4E above). Patient
   schema already exists (section 1C) — reused as-is, not
   redefined here.

   CRITICAL SECURITY RULE: every Patient query below filters on
   clinicId, sourced only from tenantScope() (i.e. only from the
   verified JWT). super_admin has no single clinic (tenantScope
   sets req.clinicId = null for that role) and is blocked by
   requireClinicContext, same as Clinic/Settings above — see
   Task 10 RBAC note below for why.
   ============================================================ */

const GENDER_VALUES      = ['Male', 'Female', 'Other'];
const BLOOD_GROUP_VALUES = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const SOURCE_VALUES      = ['Walk-In', 'Website', 'WhatsApp', 'Referral', 'Google Ads', 'Facebook Ads', 'Other'];

const MAX_NAME_LENGTH  = 120;
const MAX_NOTES_LENGTH = 2000;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const isValidGender = (value) => GENDER_VALUES.includes(value);
const isValidBloodGroup = (value) => BLOOD_GROUP_VALUES.includes(value);
const isValidSource = (value) => SOURCE_VALUES.includes(value);

const badRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

/* ---------- patientId generation (Task 06) ----------
   Format: PAT-000001, scoped per clinic, zero-padded to 6 digits.
   Generated from a count of existing patients in the clinic, with
   a small retry loop on collision — the unique compound index
   {clinicId, patientId} (section 1C) is the actual source of
   truth/safety net; the retry just makes concurrent registrations
   not fail outright under rare race conditions. */

const generatePatientId = async (clinicId) => {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const count = await Patient.countDocuments({ clinicId });
    const candidate = `PAT-${String(count + 1 + attempt).padStart(6, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const existing = await Patient.findOne({ clinicId, patientId: candidate }).select('_id').lean();
    if (!existing) return candidate;
  }
  // Extremely unlikely fallback — timestamp suffix guarantees uniqueness.
  return `PAT-${String(Date.now()).slice(-6)}`;
};

/* ---------- shared validation (Tasks 01, 04, 09) ---------- */

// Validates fields common to create + update. `requireCore` controls
// whether fullName/phone/gender are mandatory (true on create) or
// merely validated-if-present (false on update).
const validatePatientFields = (body, { requireCore }) => {
  const errors = [];

  if (requireCore || body.fullName !== undefined) {
    if (!isNonEmptyString(body.fullName)) {
      errors.push('fullName is required and must be a non-empty string');
    } else if (body.fullName.trim().length > MAX_NAME_LENGTH) {
      errors.push(`fullName must be ${MAX_NAME_LENGTH} characters or fewer`);
    }
  }

  if (requireCore || body.phone !== undefined) {
    if (!isValidPhone(body.phone)) {
      errors.push('phone is required and must be a valid phone number');
    }
  }

  if (requireCore || body.gender !== undefined) {
    if (!isValidGender(body.gender)) {
      errors.push(`gender must be one of: ${GENDER_VALUES.join(', ')}`);
    }
  }

  if (body.email !== undefined && body.email !== '' && body.email !== null) {
    if (!isValidEmail(body.email)) errors.push('email must be a valid email address');
  }

  if (body.bloodGroup !== undefined && body.bloodGroup !== '' && body.bloodGroup !== null) {
    if (!isValidBloodGroup(body.bloodGroup)) errors.push(`bloodGroup must be one of: ${BLOOD_GROUP_VALUES.join(', ')}`);
  }

  if (body.source !== undefined) {
    if (!isValidSource(body.source)) errors.push(`source must be one of: ${SOURCE_VALUES.join(', ')}`);
  }

  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') errors.push('notes must be a string');
    else if (body.notes.length > MAX_NOTES_LENGTH) errors.push(`notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
  }

  if (body.dateOfBirth !== undefined && body.dateOfBirth !== null && body.dateOfBirth !== '') {
    if (Number.isNaN(Date.parse(body.dateOfBirth))) errors.push('dateOfBirth must be a valid date');
  }

  if (body.allergies !== undefined && body.allergies !== null) {
    if (!Array.isArray(body.allergies) || !body.allergies.every((a) => typeof a === 'string')) {
      errors.push('allergies must be an array of strings');
    }
  }

  if (body.medicalConditions !== undefined && body.medicalConditions !== null) {
    if (!Array.isArray(body.medicalConditions) || !body.medicalConditions.every((c) => typeof c === 'string')) {
      errors.push('medicalConditions must be an array of strings');
    }
  }

  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== 'object' || Array.isArray(body.address)) {
      errors.push('address must be an object');
    }
  }

  return errors;
};

/* ---------- TASK 01 — CREATE PATIENT ---------- */

const createPatient = async (req, res, next) => {
  try {
    const body = req.body || {};

    const errors = validatePatientFields(body, { requireCore: true });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    // Task 07 — duplicate detection: same clinic + same phone +
    // active patient is blocked. Different clinics, or an inactive
    // record in the same clinic, are both allowed.
    const duplicate = await Patient.findOne({
      clinicId: req.clinicId,
      phone: body.phone.trim(),
      isActive: true,
    }).select('_id fullName').lean();

    if (duplicate) {
      throw badRequest(`An active patient with this phone number already exists (${duplicate.fullName})`);
    }

    const patientId = await generatePatientId(req.clinicId);

    const patient = await Patient.create({
      clinicId: req.clinicId,
      patientId,
      fullName: body.fullName.trim(),
      phone: body.phone.trim(),
      gender: body.gender,
      email: body.email ? body.email.trim().toLowerCase() : undefined,
      dateOfBirth: body.dateOfBirth || undefined,
      address: body.address || undefined,
      bloodGroup: body.bloodGroup || undefined,
      allergies: body.allergies || [],
      medicalConditions: body.medicalConditions || [],
      notes: body.notes ? body.notes.trim() : undefined,
      source: body.source || 'Walk-In',
      createdBy: req.user.userId,
    });

    // Task 08 — audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'PATIENT_CREATED',
      entityType: 'Patient',
      entityId: patient._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ success: true, data: patient });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 02 — LIST PATIENTS ---------- */

const ALLOWED_SORT_FIELDS = ['fullName', 'createdAt', 'lastVisit', 'patientId'];

const listPatients = async (req, res, next) => {
  try {
    const query = req.query || {};

    // Pagination
    const page  = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    // Phase 14.5 — Visibility Engine integration. Query order per
    // spec: Tenant Scope -> Visibility Scope -> Search -> Filters ->
    // Sorting -> Pagination (mirrors listAppointments, Phase 14.4).
    // 'patients' OWN_DATA (doctor role) can't be expressed as a flat
    // filter — Patient has no doctorId field — so getVisiblePatients()
    // performs the Appointment-join lookup and returns either {} (full/
    // operational scope), { _id: { $in: [...] } } (doctor's own
    // patients), or the deny sentinel (e.g. billing_staff, who reach
    // patient data through the Billing module instead — see
    // visibilityEngine.js VISIBILITY_MATRIX).
    const visibility = visibilityEngine.getRequestVisibility(req, 'patients');
    const visibilityFilter = visibility.scope === visibilityEngine.SCOPE_KINDS.OWN_DATA
      ? await visibilityEngine.getVisiblePatients(req.user, { Appointment })
      : visibility.mongoFilter;

    if (visibilityEngine.isDenied(visibilityFilter)) {
      // Deny-by-default reads as an empty result, not an error — same
      // convention as listAppointments (Phase 14.4).
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 1 },
      });
    }

    // Tenant filter — always present, never overridable by query
    // params — with the Visibility Engine's scope ANDed in immediately
    // after. Every filter/search added below only ever narrows an
    // already-visibility-scoped query; it can never widen it back out.
    const filter = { clinicId: req.clinicId, ...visibilityFilter };

    // Search — fullName, phone, patientId (Task 02)
    if (isNonEmptyString(query.search)) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
      const regex = new RegExp(term, 'i');
      filter.$or = [{ fullName: regex }, { phone: regex }, { patientId: regex }];
    }

    // Filters — isActive, gender, source (Task 02)
    if (query.isActive !== undefined) {
      if (query.isActive === 'true') filter.isActive = true;
      else if (query.isActive === 'false') filter.isActive = false;
    }
    if (isNonEmptyString(query.gender)) {
      if (!isValidGender(query.gender)) throw badRequest(`gender filter must be one of: ${GENDER_VALUES.join(', ')}`);
      filter.gender = query.gender;
    }
    if (isNonEmptyString(query.source)) {
      if (!isValidSource(query.source)) throw badRequest(`source filter must be one of: ${SOURCE_VALUES.join(', ')}`);
      filter.source = query.source;
    }

    // Sorting
    let sortField = 'createdAt';
    if (isNonEmptyString(query.sortBy)) {
      if (!ALLOWED_SORT_FIELDS.includes(query.sortBy)) {
        throw badRequest(`sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`);
      }
      sortField = query.sortBy;
    }
    const sortDir = query.sortOrder === 'asc' ? 1 : -1;

    // Task 10 — list responses return only fields needed for a list
    // view. Full record (notes, address, emergency contact, etc.) is
    // fetched via GET /:id when a specific patient is opened.
    const LIST_PROJECTION =
      'patientId fullName gender age phone email ' +
      'bloodGroup isActive source createdAt lastVisitAt totalVisits';

    const [patients, total] = await Promise.all([
      Patient.find(filter)
        .select(LIST_PROJECTION)
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(limit)
        .lean(), // Task 03 — list is read-only, skip document hydration
      Patient.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: patients,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 03 — PATIENT DETAILS ---------- */

const getPatient = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid patient id');
    }

    // Phase 14.5 — same visibility filter as listPatients, applied to
    // a single-document lookup. A doctor opening a patient that
    // belongs only to another doctor gets exactly the same 404 as a
    // nonexistent id — never a 403, which would confirm the id is
    // real and just off-limits (mirrors getAppointment, Phase 14.4).
    const visibility = visibilityEngine.getRequestVisibility(req, 'patients');
    const visibilityFilter = visibility.scope === visibilityEngine.SCOPE_KINDS.OWN_DATA
      ? await visibilityEngine.getVisiblePatients(req.user, { Appointment })
      : visibility.mongoFilter;

    if (visibilityEngine.isDenied(visibilityFilter)) {
      const error = new Error('Patient not found');
      error.statusCode = 404;
      throw error;
    }

    // Tenant scoped — _id + clinicId together (Critical Security Rule) —
    // with the Visibility Engine's scope ANDed in.
    const patient = await Patient.findOne({
      _id: req.params.id,
      clinicId: req.clinicId,
      ...visibilityFilter,
    }).lean();

    if (!patient) {
      const error = new Error('Patient not found');
      error.statusCode = 404;
      throw error;
    }

    res.status(200).json({ success: true, data: patient });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 04 — UPDATE PATIENT ---------- */

// Explicit whitelist — patientId, clinicId, createdBy can never be
// touched here regardless of what the client sends (Task 04 "Protected").
const updatePatient = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid patient id');
    }

    const body = req.body || {};
    const errors = validatePatientFields(body, { requireCore: false });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    const updates = {};

    // Contact information
    if (body.fullName !== undefined) updates.fullName = body.fullName.trim();
    if (body.phone !== undefined) updates.phone = body.phone.trim();
    if (body.email !== undefined) updates.email = body.email ? body.email.trim().toLowerCase() : null;

    // Address — dot-notation so a partial update doesn't wipe other fields.
    if (body.address !== undefined && body.address !== null) {
      const { street, city, state, country, pincode } = body.address;
      if (street  !== undefined) updates['address.street']  = String(street).trim();
      if (city    !== undefined) updates['address.city']    = String(city).trim();
      if (state   !== undefined) updates['address.state']   = String(state).trim();
      if (country !== undefined) updates['address.country'] = String(country).trim();
      if (pincode !== undefined) updates['address.pincode'] = String(pincode).trim();
    }

    // Medical information
    if (body.gender !== undefined) updates.gender = body.gender;
    if (body.dateOfBirth !== undefined) updates.dateOfBirth = body.dateOfBirth || null;
    if (body.bloodGroup !== undefined) updates.bloodGroup = body.bloodGroup || null;
    if (body.allergies !== undefined) updates.allergies = body.allergies || [];
    if (body.medicalConditions !== undefined) updates.medicalConditions = body.medicalConditions || [];
    if (body.source !== undefined) updates.source = body.source;

    // Notes
    if (body.notes !== undefined) updates.notes = body.notes ? body.notes.trim() : '';

    if (Object.keys(updates).length === 0) {
      throw badRequest('No valid fields provided to update');
    }

    updates.updatedBy = req.user.userId;

    // Tenant scoped — _id + clinicId together (Critical Security Rule).
    const patient = await Patient.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!patient) {
      const error = new Error('Patient not found');
      error.statusCode = 404;
      throw error;
    }

    // Task 08 — audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'PATIENT_UPDATED',
      entityType: 'Patient',
      entityId: patient._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: patient });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 05 — DEACTIVATE PATIENT ---------- */

// Soft delete only — sets isActive:false. Never physically deletes
// patient records. PATCH .../status also allows reactivation
// (isActive:true) since the schema/route is symmetric and the spec
// only forbids hard deletes, not reactivation.
const updatePatientStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid patient id');
    }

    const body = req.body || {};
    if (typeof body.isActive !== 'boolean') {
      throw badRequest('isActive must be a boolean');
    }

    // Tenant scoped — _id + clinicId together (Critical Security Rule).
    const patient = await Patient.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId },
      { $set: { isActive: body.isActive, updatedBy: req.user.userId } },
      { new: true, runValidators: true }
    );

    if (!patient) {
      const error = new Error('Patient not found');
      error.statusCode = 404;
      throw error;
    }

    // Task 08 — audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: body.isActive ? 'PATIENT_REACTIVATED' : 'PATIENT_DEACTIVATED',
      entityType: 'Patient',
      entityId: patient._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: patient });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 10 — RBAC ----------
   clinic_admin:    full access (create, read, update, deactivate)
   receptionist:    create, read, update (no deactivate — only
                     clinic_admin can deactivate a patient record)
   doctor:          read only
   billing_staff:   read only
   super_admin:     no clinic context (tenantScope sets req.clinicId
                     to null) — blocked by requireClinicContext on
                     every route below, same as Clinic/Settings
                     modules above. A super_admin must impersonate
                     or otherwise act within a specific clinic
                     context to manage patients; no cross-clinic
                     patient access exists anywhere in this module. */

const patientRouter = express.Router();

patientRouter.post(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('patients', 'create'),
  createPatient
);

patientRouter.get(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('patients', 'view'),
  listPatients
);

patientRouter.get(
  '/:id',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('patients', 'view'),
  getPatient
);

patientRouter.put(
  '/:id',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('patients', 'edit'),
  updatePatient
);

patientRouter.patch(
  '/:id/status',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('patients', 'delete'),
  updatePatientStatus
);

app.use('/api/patients', patientRouter);

/* ============================================================
   4G. DOCTOR MANAGEMENT (Phase 7.0 — Tasks 01–10)
   Inlined per project convention (see 4D/4E/4F above). Doctor
   schema already exists (section 1C) — reused as-is. Mirrors the
   Patient module's structure 1:1 so the two modules stay easy to
   reason about side by side.

   CRITICAL SECURITY RULE: every Doctor query below filters on
   clinicId, sourced only from tenantScope() (i.e. only from the
   verified JWT). super_admin has no single clinic and is blocked
   by requireClinicContext, same as every module above.
   ============================================================ */

const DAY_VALUES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_RE    = /^([01]\d|2[0-3]):([0-5]\d)$/; // "HH:MM", 24hr

const isValidDay = (value) => DAY_VALUES.includes(value);
const isValidTime = (value) => typeof value === 'string' && TIME_RE.test(value.trim());

const MAX_SPEC_LENGTH  = 100;
const MAX_QUAL_LENGTH  = 200;
const MAX_LICENSE_LENGTH = 50;

/* ---------- doctorId generation (Task 06) ----------
   Format: DOC-000001, scoped per clinic, zero-padded to 6 digits.
   Same approach as generatePatientId — count-based with a small
   retry loop; the unique compound index {clinicId, doctorId} is
   the real safety net against races. */

const generateDoctorId = async (clinicId) => {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const count = await Doctor.countDocuments({ clinicId });
    const candidate = `DOC-${String(count + 1 + attempt).padStart(6, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const existing = await Doctor.findOne({ clinicId, doctorId: candidate }).select('_id').lean();
    if (!existing) return candidate;
  }
  return `DOC-${String(Date.now()).slice(-6)}`;
};

/* ---------- weeklyAvailability helpers ----------
   Normalizes client input into exactly 7 entries (Mon..Sun), so
   partial input (e.g. only listing the days that changed) never
   leaves gaps and array order is always predictable for callers
   like the future Appointment Engine. */

const DEFAULT_WEEKLY_AVAILABILITY = DAY_VALUES.map((day) => ({
  day, isAvailable: false, startTime: undefined, endTime: undefined,
}));

const validateWeeklyAvailability = (value) => {
  const errors = [];
  if (!Array.isArray(value)) {
    errors.push('weeklyAvailability must be an array');
    return errors;
  }
  const seenDays = new Set();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      errors.push('each weeklyAvailability entry must be an object');
      continue;
    }
    if (!isValidDay(entry.day)) {
      errors.push(`weeklyAvailability.day must be one of: ${DAY_VALUES.join(', ')}`);
      continue;
    }
    if (seenDays.has(entry.day)) {
      errors.push(`weeklyAvailability has a duplicate entry for ${entry.day}`);
      continue;
    }
    seenDays.add(entry.day);
    if (entry.isAvailable !== undefined && typeof entry.isAvailable !== 'boolean') {
      errors.push(`weeklyAvailability.isAvailable for ${entry.day} must be a boolean`);
    }
    if (entry.isAvailable) {
      if (!isValidTime(entry.startTime) || !isValidTime(entry.endTime)) {
        errors.push(`weeklyAvailability for ${entry.day} requires valid startTime and endTime ("HH:MM") when isAvailable is true`);
      } else if (entry.startTime >= entry.endTime) {
        errors.push(`weeklyAvailability for ${entry.day}: startTime must be before endTime`);
      }
    }
  }
  return errors;
};

// Merges partial input on top of the 7-day default (create) or the
// doctor's existing array (update), keyed by day — never drops days
// the client didn't mention.
const mergeWeeklyAvailability = (base, incoming) => {
  const byDay = new Map(base.map((e) => [e.day, e]));
  for (const entry of incoming) {
    byDay.set(entry.day, {
      day: entry.day,
      isAvailable: entry.isAvailable ?? false,
      startTime: entry.isAvailable ? entry.startTime.trim() : undefined,
      endTime: entry.isAvailable ? entry.endTime.trim() : undefined,
    });
  }
  return DAY_VALUES.map((day) => byDay.get(day));
};

/* ---------- shared validation (Tasks 01, 04, 09) ----------
   `requireCore` controls whether fullName/phone/specialization are
   mandatory (true on create) or merely validated-if-present (false
   on update) — same convention as validatePatientFields. */

const validateDoctorFields = (body, { requireCore }) => {
  const errors = [];

  if (requireCore || body.fullName !== undefined) {
    if (!isNonEmptyString(body.fullName)) {
      errors.push('fullName is required and must be a non-empty string');
    } else if (body.fullName.trim().length > MAX_NAME_LENGTH) {
      errors.push(`fullName must be ${MAX_NAME_LENGTH} characters or fewer`);
    }
  }

  if (requireCore || body.phone !== undefined) {
    if (!isValidPhone(body.phone)) {
      errors.push('phone is required and must be a valid phone number');
    }
  }

  if (requireCore || body.specialization !== undefined) {
    if (!isNonEmptyString(body.specialization)) {
      errors.push('specialization is required and must be a non-empty string');
    } else if (body.specialization.trim().length > MAX_SPEC_LENGTH) {
      errors.push(`specialization must be ${MAX_SPEC_LENGTH} characters or fewer`);
    }
  }

  if (body.email !== undefined && body.email !== '' && body.email !== null) {
    if (!isValidEmail(body.email)) errors.push('email must be a valid email address');
  }

  if (body.qualification !== undefined && body.qualification !== null) {
    if (typeof body.qualification !== 'string') errors.push('qualification must be a string');
    else if (body.qualification.length > MAX_QUAL_LENGTH) errors.push(`qualification must be ${MAX_QUAL_LENGTH} characters or fewer`);
  }

  if (body.licenseNumber !== undefined && body.licenseNumber !== null) {
    if (typeof body.licenseNumber !== 'string') errors.push('licenseNumber must be a string');
    else if (body.licenseNumber.length > MAX_LICENSE_LENGTH) errors.push(`licenseNumber must be ${MAX_LICENSE_LENGTH} characters or fewer`);
  }

  if (body.experienceYears !== undefined && body.experienceYears !== null) {
    if (typeof body.experienceYears !== 'number' || !Number.isFinite(body.experienceYears) || body.experienceYears < 0) {
      errors.push('experienceYears must be a non-negative number');
    }
  }

  if (body.consultationFee !== undefined && body.consultationFee !== null) {
    if (typeof body.consultationFee !== 'number' || !Number.isFinite(body.consultationFee) || body.consultationFee < 0) {
      errors.push('consultationFee must be a non-negative number');
    }
  }

  if (body.defaultSlotDurationMinutes !== undefined && body.defaultSlotDurationMinutes !== null) {
    if (!Number.isInteger(body.defaultSlotDurationMinutes) || body.defaultSlotDurationMinutes < 1) {
      errors.push('defaultSlotDurationMinutes must be a positive integer');
    }
  }

  if (body.weeklyAvailability !== undefined) {
    errors.push(...validateWeeklyAvailability(body.weeklyAvailability));
  }

  return errors;
};

/* ---------- TASK 01 — REGISTER DOCTOR ---------- */

/* ---------- Phase 12.5 — department assignment guard ----------
   specialization stays a free-text string on Doctor (no schema/FK
   change — see Phase 12.5 scoping note), but its *value* must come
   from the clinic's Department collection: it must name an ACTIVE
   department. Existing doctors already assigned to a since-deactivated
   (or since-removed) department keep their value untouched — this
   check only runs when a specialization is actually being set/changed,
   i.e. doctor creation and doctor edits that touch the field. */
const assertActiveDepartment = async (clinicId, specializationName) => {
  const match = await Department.findOne({
    clinicId,
    name: specializationName.trim(),
    isActive: true,
  })
    .collation({ locale: 'en', strength: 2 })
    .select('_id')
    .lean();
  if (!match) {
    throw badRequest(
      `"${specializationName.trim()}" is not an active department for this clinic. Choose a department from Settings > Departments.`
    );
  }
};

const createDoctor = async (req, res, next) => {
  try {
    const body = req.body || {};

    const errors = validateDoctorFields(body, { requireCore: true });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    // Duplicate detection — same clinic + same phone or email +
    // active doctor is blocked. Mirrors Patient module Task 07.
    const dupFilter = { clinicId: req.clinicId, isActive: true, $or: [{ phone: body.phone.trim() }] };
    if (body.email) dupFilter.$or.push({ email: body.email.trim().toLowerCase() });

    const duplicate = await Doctor.findOne(dupFilter).select('_id fullName').lean();
    if (duplicate) {
      throw badRequest(`An active doctor with this phone or email already exists (${duplicate.fullName})`);
    }

    // Phase 12.5 — new doctors must be assigned to an active department.
    await assertActiveDepartment(req.clinicId, body.specialization);

    const doctorId = await generateDoctorId(req.clinicId);

    const initials = body.fullName.trim().split(/\s+/).filter(Boolean)
      .map((w) => w[0]).join('').slice(0, 3).toUpperCase();

    const weeklyAvailability = body.weeklyAvailability
      ? mergeWeeklyAvailability(DEFAULT_WEEKLY_AVAILABILITY, body.weeklyAvailability)
      : DEFAULT_WEEKLY_AVAILABILITY;

    const doctor = await Doctor.create({
      clinicId: req.clinicId,
      doctorId,
      fullName: body.fullName.trim(),
      initials: body.initials ? body.initials.trim() : initials,
      avatarColor: body.avatarColor || 'av-1',
      phone: body.phone.trim(),
      email: body.email ? body.email.trim().toLowerCase() : undefined,
      specialization: body.specialization.trim(),
      qualification: body.qualification ? body.qualification.trim() : undefined,
      licenseNumber: body.licenseNumber ? body.licenseNumber.trim() : undefined,
      experienceYears: body.experienceYears ?? undefined,
      consultationFee: body.consultationFee ?? undefined,
      defaultSlotDurationMinutes: body.defaultSlotDurationMinutes ?? null,
      weeklyAvailability,
      createdBy: req.user.userId,
    });

    // Audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'DOCTOR_CREATED',
      entityType: 'Doctor',
      entityId: doctor._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ success: true, data: doctor });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 02 — LIST / SEARCH DOCTORS ---------- */

const DOCTOR_SORT_FIELDS = ['fullName', 'createdAt', 'specialization', 'experienceYears', 'consultationFee'];

const listDoctors = async (req, res, next) => {
  try {
    const query = req.query || {};

    const page  = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    // Tenant filter — always present, never overridable by query params.
    const filter = { clinicId: req.clinicId };

    // Search — fullName, specialization, doctorId, phone
    if (isNonEmptyString(query.search)) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(term, 'i');
      filter.$or = [{ fullName: regex }, { specialization: regex }, { doctorId: regex }, { phone: regex }];
    }

    if (isNonEmptyString(query.specialization)) {
      filter.specialization = new RegExp(query.specialization.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    if (query.isActive !== undefined) {
      if (query.isActive === 'true') filter.isActive = true;
      else if (query.isActive === 'false') filter.isActive = false;
    }
    if (query.isAvailable !== undefined) {
      if (query.isAvailable === 'true') filter.isAvailable = true;
      else if (query.isAvailable === 'false') filter.isAvailable = false;
    }

    let sortField = 'fullName';
    if (isNonEmptyString(query.sortBy)) {
      if (!DOCTOR_SORT_FIELDS.includes(query.sortBy)) {
        throw badRequest(`sortBy must be one of: ${DOCTOR_SORT_FIELDS.join(', ')}`);
      }
      sortField = query.sortBy;
    }
    const sortDir = query.sortOrder === 'asc' ? 1 : -1;

    // List view returns a lean projection; full record (qualification,
    // license, full weeklyAvailability) is fetched via GET /:id.
    const LIST_PROJECTION =
      'doctorId fullName initials avatarColor specialization experienceYears ' +
      'phone email consultationFee isActive isAvailable createdAt';

    const [doctors, total] = await Promise.all([
      Doctor.find(filter)
        .select(LIST_PROJECTION)
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(limit)
        .lean(),
      Doctor.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: doctors,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 03 — DOCTOR PROFILE ---------- */

const getDoctor = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid doctor id');
    }

    // Tenant scoped — _id + clinicId together (Critical Security Rule).
    const doctor = await Doctor.findOne({ _id: req.params.id, clinicId: req.clinicId }).lean();

    if (!doctor) {
      const error = new Error('Doctor not found');
      error.statusCode = 404;
      throw error;
    }

    res.status(200).json({ success: true, data: doctor });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 04 — UPDATE DOCTOR PROFILE ---------- */

// Explicit whitelist — doctorId, clinicId, createdBy can never be
// touched here regardless of what the client sends.
const updateDoctor = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid doctor id');
    }

    const body = req.body || {};
    const errors = validateDoctorFields(body, { requireCore: false });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    const existing = await Doctor.findOne({ _id: req.params.id, clinicId: req.clinicId })
      .select('weeklyAvailability')
      .lean();
    if (!existing) {
      const error = new Error('Doctor not found');
      error.statusCode = 404;
      throw error;
    }

    const updates = {};

    if (body.fullName !== undefined) updates.fullName = body.fullName.trim();
    if (body.phone !== undefined) updates.phone = body.phone.trim();
    if (body.email !== undefined) updates.email = body.email ? body.email.trim().toLowerCase() : null;
    if (body.initials !== undefined) updates.initials = body.initials ? body.initials.trim().toUpperCase() : null;
    if (body.avatarColor !== undefined) updates.avatarColor = body.avatarColor;

    if (body.specialization !== undefined) {
      // Phase 12.5 — only enforced when specialization is actually being
      // changed here, so editing an unrelated field (phone, fee, etc.)
      // never gets blocked by a doctor's own already-stale department.
      await assertActiveDepartment(req.clinicId, body.specialization);
      updates.specialization = body.specialization.trim();
    }
    if (body.qualification !== undefined) updates.qualification = body.qualification ? body.qualification.trim() : '';
    if (body.licenseNumber !== undefined) updates.licenseNumber = body.licenseNumber ? body.licenseNumber.trim() : '';
    if (body.experienceYears !== undefined) updates.experienceYears = body.experienceYears;

    // Fee management (Task 07) — current-value only, no separate
    // history collection (see Phase 7.0 scoping note). The change
    // itself is fully traceable via the audit log entry below,
    // which records who changed it and when.
    if (body.consultationFee !== undefined) updates.consultationFee = body.consultationFee;

    if (body.defaultSlotDurationMinutes !== undefined) updates.defaultSlotDurationMinutes = body.defaultSlotDurationMinutes;

    // Availability configuration (Task 08) — merge onto existing
    // 7-day array so a partial update (e.g. just changing Monday)
    // never wipes the other six days.
    if (body.weeklyAvailability !== undefined) {
      updates.weeklyAvailability = mergeWeeklyAvailability(existing.weeklyAvailability, body.weeklyAvailability);
    }

    if (Object.keys(updates).length === 0) {
      throw badRequest('No valid fields provided to update');
    }

    updates.updatedBy = req.user.userId;

    const doctor = await Doctor.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!doctor) {
      const error = new Error('Doctor not found');
      error.statusCode = 404;
      throw error;
    }

    // Audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'DOCTOR_UPDATED',
      entityType: 'Doctor',
      entityId: doctor._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: doctor });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 05 — DOCTOR STATUS (active/inactive + availability) ----------
   Soft delete only — sets isActive:false. Never physically deletes
   doctor records (their history is referenced by Appointments/
   Invoices). Also supports the day-to-day isAvailable toggle (e.g.
   "on leave today") via the same endpoint, since both are simple
   boolean flips with identical RBAC and audit needs. */

const updateDoctorStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid doctor id');
    }

    const body = req.body || {};
    if (body.isActive === undefined && body.isAvailable === undefined) {
      throw badRequest('Provide isActive and/or isAvailable (boolean)');
    }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      throw badRequest('isActive must be a boolean');
    }
    if (body.isAvailable !== undefined && typeof body.isAvailable !== 'boolean') {
      throw badRequest('isAvailable must be a boolean');
    }

    const updates = { updatedBy: req.user.userId };
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.isAvailable !== undefined) updates.isAvailable = body.isAvailable;

    // Tenant scoped — _id + clinicId together (Critical Security Rule).
    const doctor = await Doctor.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!doctor) {
      const error = new Error('Doctor not found');
      error.statusCode = 404;
      throw error;
    }

    let action = 'DOCTOR_STATUS_UPDATED';
    if (body.isActive !== undefined) action = body.isActive ? 'DOCTOR_REACTIVATED' : 'DOCTOR_DEACTIVATED';

    // Audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action,
      entityType: 'Doctor',
      entityId: doctor._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: doctor });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 10 — RBAC ----------
   clinic_admin:    full access (register, read, update, deactivate,
                     availability, fee)
   receptionist:    read only (needs doctor list/profile to book
                     appointments, but cannot edit doctor records)
   doctor:          read only (their own and colleagues' public
                     profiles — fine-grained "self vs all" scoping
                     is left to the Appointment module per the
                     project's "no unnecessary architecture" brief;
                     can be tightened later if a doctor-self-service
                     "edit my own availability" flow is added)
   billing_staff:   read only (needs consultationFee for invoicing)
   super_admin:     no clinic context — blocked by requireClinicContext,
                     same as every module above. */

const doctorRouter = express.Router();

doctorRouter.post(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('doctors', 'create'),
  createDoctor
);

doctorRouter.get(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('doctors', 'view'),
  listDoctors
);

doctorRouter.get(
  '/:id',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('doctors', 'view'),
  getDoctor
);

doctorRouter.put(
  '/:id',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('doctors', 'edit'),
  updateDoctor
);

doctorRouter.patch(
  '/:id/status',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('doctors', 'delete'),
  updateDoctorStatus
);

app.use('/api/doctors', doctorRouter);

/* ============================================================
   4G-2. DEPARTMENT MANAGEMENT (Phase 12.5)
   Single source of truth for every department used anywhere in the
   app. MongoDB only — no hardcoded department arrays, no fallback
   lists. If a clinic has zero departments, callers get an empty
   array/"No departments found", never fabricated data.
   ============================================================ */

const MAX_DEPT_NAME_LENGTH = 100;
const MAX_DEPT_DESC_LENGTH = 500;

// Rejects empty strings, whitespace-only strings, and strings made up
// entirely of special characters (e.g. "---", "!!!", "///"). A valid
// department name must contain at least one letter or digit.
const isValidDepartmentName = (value) => {
  if (!isNonEmptyString(value)) return false;
  const trimmed = value.trim();
  if (trimmed.length > MAX_DEPT_NAME_LENGTH) return false;
  return /[a-zA-Z0-9]/.test(trimmed);
};

const validateDepartmentFields = (body, { requireCore }) => {
  const errors = [];

  if (requireCore || body.name !== undefined) {
    if (!isNonEmptyString(body.name)) {
      errors.push('name is required and must be a non-empty string');
    } else if (body.name.trim().length > MAX_DEPT_NAME_LENGTH) {
      errors.push(`name must be ${MAX_DEPT_NAME_LENGTH} characters or fewer`);
    } else if (!isValidDepartmentName(body.name)) {
      errors.push('name cannot consist only of special characters');
    }
  }

  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') errors.push('description must be a string');
    else if (body.description.length > MAX_DEPT_DESC_LENGTH) errors.push(`description must be ${MAX_DEPT_DESC_LENGTH} characters or fewer`);
  }

  if (body.color !== undefined && body.color !== null) {
    if (typeof body.color !== 'string') errors.push('color must be a string');
  }

  if (body.displayOrder !== undefined && body.displayOrder !== null) {
    if (typeof body.displayOrder !== 'number' || !Number.isFinite(body.displayOrder)) {
      errors.push('displayOrder must be a number');
    }
  }

  return errors;
};

/* ---------- departmentId generation ----------
   Format: DEPT-000001, scoped per clinic, zero-padded to 6 digits.
   Same count-based + retry approach as generatePatientId/generateDoctorId;
   the unique compound index {clinicId, departmentId} is the real
   safety net against races. */

const generateDepartmentId = async (clinicId) => {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const count = await Department.countDocuments({ clinicId });
    const candidate = `DEPT-${String(count + 1 + attempt).padStart(6, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const existing = await Department.findOne({ clinicId, departmentId: candidate }).select('_id').lean();
    if (!existing) return candidate;
  }
  return `DEPT-${String(Date.now()).slice(-6)}`;
};

/* ---------- CREATE DEPARTMENT ---------- */

const createDepartment = async (req, res, next) => {
  try {
    const body = req.body || {};

    const errors = validateDepartmentFields(body, { requireCore: true });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    // Duplicate name check — case-insensitive, scoped to this clinic.
    // Uses the same collation as the unique index so this pre-check
    // and the index agree on what counts as a duplicate.
    const duplicate = await Department.findOne({ clinicId: req.clinicId, name: body.name.trim() })
      .collation({ locale: 'en', strength: 2 })
      .select('_id')
      .lean();
    if (duplicate) {
      throw badRequest(`A department named "${body.name.trim()}" already exists in this clinic`);
    }

    const departmentId = await generateDepartmentId(req.clinicId);

    // New departments default to the end of the display order unless
    // the client explicitly provided one.
    let displayOrder = body.displayOrder;
    if (displayOrder === undefined || displayOrder === null) {
      const last = await Department.findOne({ clinicId: req.clinicId }).sort({ displayOrder: -1 }).select('displayOrder').lean();
      displayOrder = last ? last.displayOrder + 1 : 0;
    }

    const department = await Department.create({
      clinicId: req.clinicId,
      departmentId,
      name: body.name.trim(),
      description: body.description ? body.description.trim() : undefined,
      color: body.color ? body.color.trim() : undefined,
      displayOrder,
      createdBy: req.user.userId,
    });

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'DEPARTMENT_CREATED',
      entityType: 'Department',
      entityId: department._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ success: true, data: department });
  } catch (err) {
    // Race-condition fallback: two concurrent requests can both pass
    // the pre-check above and then collide on the unique index itself.
    if (err && err.code === 11000) {
      return next(badRequest('A department with this name already exists in this clinic'));
    }
    next(err);
  }
};

/* ---------- LIST / SEARCH DEPARTMENTS ---------- */

const DEPARTMENT_SORT_FIELDS = ['displayOrder', 'name', 'createdAt'];

const listDepartments = async (req, res, next) => {
  try {
    const query = req.query || {};

    const page  = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
    const skip  = (page - 1) * limit;

    // Tenant filter — always present, never overridable by query params.
    const filter = { clinicId: req.clinicId };

    if (isNonEmptyString(query.search)) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(term, 'i');
      filter.$or = [{ name: regex }, { description: regex }, { departmentId: regex }];
    }

    if (query.isActive !== undefined) {
      if (query.isActive === 'true') filter.isActive = true;
      else if (query.isActive === 'false') filter.isActive = false;
    }

    let sortField = 'displayOrder';
    if (isNonEmptyString(query.sortBy)) {
      if (!DEPARTMENT_SORT_FIELDS.includes(query.sortBy)) {
        throw badRequest(`sortBy must be one of: ${DEPARTMENT_SORT_FIELDS.join(', ')}`);
      }
      sortField = query.sortBy;
    }
    const sortDir = query.sortOrder === 'desc' ? -1 : 1;

    const [departments, total] = await Promise.all([
      Department.find(filter)
        .sort({ [sortField]: sortDir, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Department.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: departments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- GET SINGLE DEPARTMENT ---------- */

const getDepartment = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid department id');
    }

    // Tenant scoped — _id + clinicId together (Critical Security Rule).
    const department = await Department.findOne({ _id: req.params.id, clinicId: req.clinicId }).lean();

    if (!department) {
      const error = new Error('Department not found');
      error.statusCode = 404;
      throw error;
    }

    res.status(200).json({ success: true, data: department });
  } catch (err) {
    next(err);
  }
};

/* ---------- UPDATE DEPARTMENT ----------
   Explicit whitelist — departmentId, clinicId, createdBy can never be
   touched here regardless of what the client sends. isActive is
   deliberately NOT accepted here — use PATCH /:id/status instead, so
   activation/deactivation always gets its own distinct audit action. */

const updateDepartment = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid department id');
    }

    const body = req.body || {};
    const errors = validateDepartmentFields(body, { requireCore: false });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    const updates = {};

    if (body.name !== undefined) {
      const duplicate = await Department.findOne({
        clinicId: req.clinicId,
        name: body.name.trim(),
        _id: { $ne: req.params.id },
      })
        .collation({ locale: 'en', strength: 2 })
        .select('_id')
        .lean();
      if (duplicate) {
        throw badRequest(`A department named "${body.name.trim()}" already exists in this clinic`);
      }
      updates.name = body.name.trim();
    }
    if (body.description !== undefined) updates.description = body.description ? body.description.trim() : '';
    if (body.color !== undefined) updates.color = body.color ? body.color.trim() : '';
    if (body.displayOrder !== undefined) updates.displayOrder = body.displayOrder;

    if (Object.keys(updates).length === 0) {
      throw badRequest('No valid fields provided to update');
    }

    updates.updatedBy = req.user.userId;

    const department = await Department.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!department) {
      const error = new Error('Department not found');
      error.statusCode = 404;
      throw error;
    }

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'DEPARTMENT_UPDATED',
      entityType: 'Department',
      entityId: department._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: department });
  } catch (err) {
    if (err && err.code === 11000) {
      return next(badRequest('A department with this name already exists in this clinic'));
    }
    next(err);
  }
};

/* ---------- ACTIVATE / DEACTIVATE DEPARTMENT ----------
   Soft delete only — never a hard delete (existing doctors/appointments/
   invoices reference departments by name and must keep working).
   Deactivating a department does NOT touch any doctor currently
   assigned to it — "existing doctors keep their department" — it only
   removes the department from the selectable list for NEW doctors
   (enforced in createDoctor, see below). */

const updateDepartmentStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid department id');
    }

    const body = req.body || {};
    if (typeof body.isActive !== 'boolean') {
      throw badRequest('isActive must be a boolean');
    }

    const department = await Department.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId },
      { $set: { isActive: body.isActive, updatedBy: req.user.userId } },
      { new: true, runValidators: true }
    );

    if (!department) {
      const error = new Error('Department not found');
      error.statusCode = 404;
      throw error;
    }

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: body.isActive ? 'DEPARTMENT_REACTIVATED' : 'DEPARTMENT_DEACTIVATED',
      entityType: 'Department',
      entityId: department._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: department });
  } catch (err) {
    next(err);
  }
};

/* ---------- REORDER DEPARTMENTS ----------
   Body: { order: [departmentId1, departmentId2, ...] } — an array of
   Department _ids in the desired display order. Every id must belong
   to this clinic; displayOrder is set to its index in the array.
   Bulk operation, single audit log entry (not one per department). */

const reorderDepartments = async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.order) || body.order.length === 0) {
      throw badRequest('order must be a non-empty array of department ids');
    }
    if (body.order.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      throw badRequest('order contains an invalid department id');
    }
    if (new Set(body.order).size !== body.order.length) {
      throw badRequest('order contains duplicate department ids');
    }

    // Verify every id belongs to this clinic before writing anything —
    // avoids partially applying a reorder that includes another
    // clinic's department id.
    const count = await Department.countDocuments({ _id: { $in: body.order }, clinicId: req.clinicId });
    if (count !== body.order.length) {
      throw badRequest('order contains a department id that does not belong to this clinic');
    }

    const bulkOps = body.order.map((id, index) => ({
      updateOne: {
        filter: { _id: id, clinicId: req.clinicId },
        update: { $set: { displayOrder: index, updatedBy: req.user.userId } },
      },
    }));
    await Department.bulkWrite(bulkOps);

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'DEPARTMENT_REORDERED',
      entityType: 'Department',
      entityId: null,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const departments = await Department.find({ clinicId: req.clinicId }).sort({ displayOrder: 1, name: 1 }).lean();
    res.status(200).json({ success: true, data: departments });
  } catch (err) {
    next(err);
  }
};

/* ---------- RBAC ----------
   clinic_admin:    full access (create, edit, deactivate, reorder)
   receptionist:    read only (needs department list for appointment
                     filters/dropdowns)
   doctor:          read only
   billing_staff:   read only (needs department list for billing
                     filters/department-wise revenue)
   super_admin:     no clinic context — blocked by requireClinicContext,
                     same as every module above. */

const departmentRouter = express.Router();
departmentRouter.use(authenticate, tenantScope, requireClinicContext);

departmentRouter.post('/', requirePermission('departments', 'create'), createDepartment);
departmentRouter.get('/', requirePermission('departments', 'view'), listDepartments);
departmentRouter.get('/:id', requirePermission('departments', 'view'), getDepartment);
departmentRouter.put('/:id', requirePermission('departments', 'edit'), updateDepartment);
departmentRouter.patch('/:id/status', requirePermission('departments', 'delete'), updateDepartmentStatus);
departmentRouter.patch('/reorder', requirePermission('departments', 'edit'), reorderDepartments);

app.use('/api/departments', departmentRouter);

/* ============================================================
   4H. APPOINTMENT ENGINE (Phase 8.0 — Tasks 01–10)
   Inlined per project convention (see 4D/4E/4F/4G above). This is
   the operational core: it reuses the existing Patient and Doctor
   records (no new collections beyond Appointment itself, which
   already existed — see section 1C) and the Doctor module's
   weeklyAvailability structure as the single source of truth for
   "when is this doctor bookable".

   CRITICAL SECURITY RULE: every Appointment query below filters on
   clinicId, sourced only from tenantScope(). Patient and Doctor
   references are independently re-validated as belonging to the
   same clinic on every create/update — a patientId or doctorId
   from another clinic must never be bookable, even if somehow
   guessed (Critical Security Rule, same posture as every module
   above).
   ============================================================ */

// DAY_VALUES, TIME_RE, isValidDay, isValidTime are already defined
// in section 4G (Doctor Management) and reused here as-is — both
// modules speak the exact same "HH:MM" / Mon..Sun vocabulary by
// design, so scheduling logic never has to convert between formats.

const APPOINTMENT_TYPES = ['Consultation', 'Follow-up', 'Telemedicine', 'Procedure', 'Other'];
const isValidApptType = (value) => APPOINTMENT_TYPES.includes(value);

const MAX_NOTES_LENGTH_APPT = 1000;
const MAX_CANCEL_REASON_LENGTH = 300;

/* ---------- date helpers ----------
   appointmentDate is stored as a date-only Date (midnight UTC) so
   "same day" comparisons are exact equality, never timezone-
   sensitive range math. All date input (create/update/list filters)
   passes through here first. */

const normalizeAppointmentDate = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

// JS getUTCDay(): 0=Sun..6=Sat. Doctor.weeklyAvailability uses
// Mon..Sun starting Monday — this maps one to the other.
const JS_DAY_TO_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabelForDate = (date) => JS_DAY_TO_LABEL[date.getUTCDay()];

// Minutes-since-midnight, for overlap arithmetic on "HH:MM" strings.
const timeToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/* ---------- TASK 09 — DOCTOR AVAILABILITY VALIDATION ----------
   Runs before every create and every reschedule (date/time change
   on update). Five checks, in order, each with a specific message
   so the frontend can show the real reason a slot was rejected:

     1. doctor exists, belongs to this clinic, and is active
     2. doctor.isAvailable (not on leave / temporarily off)
     3. the requested day-of-week is a working day for this doctor
     4. the requested startTime/endTime falls fully inside that
        day's working window
     5. (handled separately by checkSlotConflict) no overlapping
        appointment already exists

   Returns the loaded doctor doc on success, or throws a 400/404
   with a precise reason on failure. */

const validateDoctorAvailability = async (clinicId, doctorId, appointmentDate, startTime, endTime) => {
  if (!mongoose.Types.ObjectId.isValid(doctorId)) {
    throw badRequest('Invalid doctorId');
  }

  // Tenant scoped — _id + clinicId together (Critical Security Rule).
  const doctor = await Doctor.findOne({ _id: doctorId, clinicId }).lean();
  if (!doctor) {
    const error = new Error('Doctor not found');
    error.statusCode = 404;
    throw error;
  }

  if (!doctor.isActive) {
    throw badRequest('This doctor is no longer active and cannot be booked');
  }
  if (!doctor.isAvailable) {
    throw badRequest('This doctor is currently marked unavailable (e.g. on leave)');
  }

  const dayLabel = dayLabelForDate(appointmentDate);
  const daySchedule = (doctor.weeklyAvailability || []).find((d) => d.day === dayLabel);

  if (!daySchedule || !daySchedule.isAvailable) {
    throw badRequest(`Dr. ${doctor.fullName} does not see patients on ${dayLabel}`);
  }

  const reqStart = timeToMinutes(startTime);
  const reqEnd = timeToMinutes(endTime);
  const winStart = timeToMinutes(daySchedule.startTime);
  const winEnd = timeToMinutes(daySchedule.endTime);

  if (reqStart < winStart || reqEnd > winEnd) {
    throw badRequest(
      `Requested time ${startTime}-${endTime} is outside Dr. ${doctor.fullName}'s ${dayLabel} hours (${daySchedule.startTime}-${daySchedule.endTime})`
    );
  }

  return doctor;
};

/* ---------- TASK 09B — SLOT CONFLICT PREVENTION ----------
   Two intervals [aStart,aEnd) and [bStart,bEnd) overlap iff
   aStart < bEnd AND bStart < aEnd. Pulls same-clinic, same-doctor,
   same-day appointments that aren't cancelled/no_show (a freed or
   no-show slot is bookable again) and checks in application code —
   Mongo can't express interval overlap as a simple equality filter,
   and at clinic scale (a handful of appointments per doctor per
   day) this is a single small indexed query, not a scan.
   `excludeAppointmentId` lets updateAppointment re-check a
   reschedule without colliding with itself. */

const checkSlotConflict = async (clinicId, doctorId, appointmentDate, startTime, endTime, excludeAppointmentId = null) => {
  const filter = {
    clinicId,
    doctorId,
    appointmentDate,
    status: { $nin: ['cancelled', 'no_show'] },
  };
  if (excludeAppointmentId) filter._id = { $ne: excludeAppointmentId };

  const sameDayAppts = await Appointment.find(filter).select('startTime endTime').lean();

  const reqStart = timeToMinutes(startTime);
  const reqEnd = timeToMinutes(endTime);

  const conflict = sameDayAppts.find((a) => {
    const aStart = timeToMinutes(a.startTime);
    const aEnd = timeToMinutes(a.endTime);
    return reqStart < aEnd && aStart < reqEnd;
  });

  if (conflict) {
    throw badRequest(`This doctor already has an appointment from ${conflict.startTime} to ${conflict.endTime} on this day`);
  }
};

/* ---------- shared validation (Tasks 01, 04) ---------- */

const validateAppointmentFields = (body, { requireCore }) => {
  const errors = [];

  if (requireCore || body.patientId !== undefined) {
    if (!isNonEmptyString(body.patientId) || !mongoose.Types.ObjectId.isValid(body.patientId)) {
      errors.push('patientId is required and must be a valid id');
    }
  }
  if (requireCore || body.doctorId !== undefined) {
    if (!isNonEmptyString(body.doctorId) || !mongoose.Types.ObjectId.isValid(body.doctorId)) {
      errors.push('doctorId is required and must be a valid id');
    }
  }
  if (requireCore || body.appointmentDate !== undefined) {
    if (!body.appointmentDate || normalizeAppointmentDate(body.appointmentDate) === null) {
      errors.push('appointmentDate is required and must be a valid date');
    }
  }
  if (requireCore || body.startTime !== undefined) {
    if (!isValidTime(body.startTime)) errors.push('startTime is required and must be "HH:MM" (24hr)');
  }
  if (requireCore || body.endTime !== undefined) {
    if (!isValidTime(body.endTime)) errors.push('endTime is required and must be "HH:MM" (24hr)');
  }
  if (body.startTime !== undefined && body.endTime !== undefined && isValidTime(body.startTime) && isValidTime(body.endTime)) {
    if (timeToMinutes(body.startTime) >= timeToMinutes(body.endTime)) {
      errors.push('startTime must be before endTime');
    }
  }
  if (requireCore || body.type !== undefined) {
    if (!isValidApptType(body.type)) errors.push(`type must be one of: ${APPOINTMENT_TYPES.join(', ')}`);
  }
  if (body.source !== undefined) {
    if (!['manual', 'website', 'whatsapp', 'phone_call'].includes(body.source)) {
      errors.push('source must be one of: manual, website, whatsapp, phone_call');
    }
  }
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') errors.push('notes must be a string');
    else if (body.notes.length > MAX_NOTES_LENGTH_APPT) errors.push(`notes must be ${MAX_NOTES_LENGTH_APPT} characters or fewer`);
  }

  return errors;
};

/* ---------- TASK 01 — CREATE APPOINTMENT ---------- */

const createAppointment = async (req, res, next) => {
  try {
    const body = req.body || {};

    const errors = validateAppointmentFields(body, { requireCore: true });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    // Reuse existing Patient record — must belong to this clinic
    // (Critical Security Rule: cross-clinic patientId is rejected,
    // not silently scoped).
    const patient = await Patient.findOne({ _id: body.patientId, clinicId: req.clinicId })
      .select('_id fullName isActive')
      .lean();
    if (!patient) {
      const error = new Error('Patient not found');
      error.statusCode = 404;
      throw error;
    }
    if (!patient.isActive) {
      throw badRequest('This patient record is inactive');
    }

    const appointmentDate = normalizeAppointmentDate(body.appointmentDate);

    // Tasks 01, 09 — doctor active/available/day/time-window checks.
    const doctor = await validateDoctorAvailability(
      req.clinicId, body.doctorId, appointmentDate, body.startTime, body.endTime
    );

    // Task 09B — slot conflict prevention.
    await checkSlotConflict(req.clinicId, body.doctorId, appointmentDate, body.startTime, body.endTime);

    const appointment = await Appointment.create({
      clinicId: req.clinicId,
      patientId: patient._id,
      doctorId: doctor._id,
      appointmentDate,
      startTime: body.startTime,
      endTime: body.endTime,
      durationMinutes: timeToMinutes(body.endTime) - timeToMinutes(body.startTime),
      type: body.type,
      status: 'scheduled',
      source: body.source || 'manual',
      bookedBy: req.user.userId,
      notes: body.notes ? body.notes.trim() : undefined,
      createdBy: req.user.userId,
    });

    // Audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'APPOINTMENT_BOOKED',
      entityType: 'Appointment',
      entityId: appointment._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ success: true, data: appointment });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 02 — LIST APPOINTMENTS (Calendar-ready) ---------- */

const APPT_SORT_FIELDS = ['appointmentDate', 'createdAt', 'status'];

const listAppointments = async (req, res, next) => {
  try {
    const query = req.query || {};

    const page  = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    // Phase 14.4 — Visibility Engine integration. Query order per
    // spec: Tenant Scope -> Visibility Scope -> Search Filters ->
    // Sorting -> Pagination. Tenant scope (clinicId) is already on
    // req.clinicId from tenantScope(); visibility is ANDed in next,
    // before any of the filters below are layered on top — so every
    // filter/search a caller adds only ever narrows an already-
    // visibility-scoped query, it can never widen it back out.
    const visibility = visibilityEngine.getRequestVisibility(req, 'appointments');
    if (visibilityEngine.isDenied(visibility.mongoFilter)) {
      // billing_staff and any other NONE-scoped role: same shape as
      // a normal empty result, not an error — "no visibility" reads
      // as "nothing to show", not as a broken request. Billing's own
      // narrow "completed appointments for invoicing" need is served
      // by the existing GET /api/billing/from-appointment/:id handoff,
      // not this general list — see module header.
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 1 },
      });
    }

    const filter = { clinicId: req.clinicId, ...visibility.mongoFilter };

    // Single-day filter — the primary calendar-view query: "show me
    // this doctor's/this clinic's day". Exact equality since
    // appointmentDate is always normalized to midnight UTC.
    if (isNonEmptyString(query.date)) {
      const d = normalizeAppointmentDate(query.date);
      if (!d) throw badRequest('date must be a valid date');
      filter.appointmentDate = d;
    } else if (query.dateFrom || query.dateTo) {
      // Range filter — calendar month view.
      filter.appointmentDate = {};
      if (query.dateFrom) {
        const from = normalizeAppointmentDate(query.dateFrom);
        if (!from) throw badRequest('dateFrom must be a valid date');
        filter.appointmentDate.$gte = from;
      }
      if (query.dateTo) {
        const to = normalizeAppointmentDate(query.dateTo);
        if (!to) throw badRequest('dateTo must be a valid date');
        filter.appointmentDate.$lte = to;
      }
    }

    // Phase 14.4 — doctorId filter is only honored for roles with
    // clinic-wide (or operational) visibility. A doctor-scoped user's
    // visibility.mongoFilter already pins doctorId to their own id
    // above; letting query.doctorId overwrite that here would let a
    // doctor request `?doctorId=<someone else>` and see another
    // doctor's schedule — the exact leak this phase closes. Never a
    // silent override: filter.doctorId is only ever set once, either
    // by visibility (own data) or by this block (full/operational).
    if (isNonEmptyString(query.doctorId) && visibility.scope !== visibilityEngine.SCOPE_KINDS.OWN_DATA) {
      if (!mongoose.Types.ObjectId.isValid(query.doctorId)) throw badRequest('doctorId must be a valid id');
      filter.doctorId = query.doctorId;
    }
    if (isNonEmptyString(query.patientId)) {
      if (!mongoose.Types.ObjectId.isValid(query.patientId)) throw badRequest('patientId must be a valid id');
      filter.patientId = query.patientId;
    }
    if (isNonEmptyString(query.status)) {
      const validStatuses = ['scheduled', 'confirmed', 'waiting', 'completed', 'cancelled', 'no_show'];
      if (!validStatuses.includes(query.status)) throw badRequest(`status must be one of: ${validStatuses.join(', ')}`);
      filter.status = query.status;
    }

    let sortField = 'appointmentDate';
    if (isNonEmptyString(query.sortBy)) {
      if (!APPT_SORT_FIELDS.includes(query.sortBy)) throw badRequest(`sortBy must be one of: ${APPT_SORT_FIELDS.join(', ')}`);
      sortField = query.sortBy;
    }
    const sortDir = query.sortOrder === 'desc' ? -1 : 1;

    // populate() pulls just the display fields the list view needs
    // from Patient/Doctor — avoids the frontend making N follow-up
    // calls per appointment row.
    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .populate('patientId', 'fullName patientId phone')
        .populate('doctorId', 'fullName specialization initials avatarColor')
        .sort({ [sortField]: sortDir, startTime: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Appointment.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: appointments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 03 — APPOINTMENT DETAILS ---------- */

const getAppointment = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid appointment id');
    }

    // Phase 14.4 — same visibility filter as listAppointments, applied
    // to a single-document lookup. A doctor opening another doctor's
    // appointment by guessed/known ID gets exactly the same 404 as a
    // nonexistent id — never a 403, which would confirm the id is
    // real and just off-limits (the spec's "Do NOT leak information").
    const visibility = visibilityEngine.getRequestVisibility(req, 'appointments');
    if (visibilityEngine.isDenied(visibility.mongoFilter)) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    const appointment = await Appointment.findOne({ _id: req.params.id, clinicId: req.clinicId, ...visibility.mongoFilter })
      .populate('patientId', 'fullName patientId phone email')
      .populate('doctorId', 'fullName specialization initials avatarColor consultationFee')
      .lean();

    if (!appointment) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    res.status(200).json({ success: true, data: appointment });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 04 — UPDATE / RESCHEDULE APPOINTMENT ----------
   Only re-runs availability + conflict checks when the date/time/
   doctor actually changes — editing notes or type shouldn't force
   a doctor lookup it doesn't need. Explicit whitelist, same as
   every other update handler in this project: clinicId, patientId,
   status (handled separately via PATCH /status), createdBy can
   never be touched here. */

const updateAppointment = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid appointment id');
    }

    // Phase 14.4 — Visibility Engine gates which appointment this
    // write can even find, same as getAppointment. Permission Engine
    // (requirePermission('appointments','edit') on the route below)
    // already decided WHETHER this role may edit appointments at all;
    // this decides WHICH ones — a doctor with edit rights on their
    // own appointments still can't reach another doctor's by ID.
    const visibility = visibilityEngine.getRequestVisibility(req, 'appointments');
    if (visibilityEngine.isDenied(visibility.mongoFilter)) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    const existing = await Appointment.findOne({ _id: req.params.id, clinicId: req.clinicId, ...visibility.mongoFilter });
    if (!existing) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }
    if (['completed', 'cancelled'].includes(existing.status)) {
      throw badRequest(`Cannot modify an appointment that is already ${existing.status}`);
    }

    const body = req.body || {};
    const errors = validateAppointmentFields(body, { requireCore: false });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    const updates = {};
    let doctorId = existing.doctorId;

    if (body.doctorId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(body.doctorId)) throw badRequest('Invalid doctorId');
      doctorId = body.doctorId;
      updates.doctorId = body.doctorId;
    }

    const newDate = body.appointmentDate !== undefined ? normalizeAppointmentDate(body.appointmentDate) : existing.appointmentDate;
    const newStart = body.startTime !== undefined ? body.startTime : existing.startTime;
    const newEnd = body.endTime !== undefined ? body.endTime : existing.endTime;

    const isReschedule =
      body.doctorId !== undefined || body.appointmentDate !== undefined ||
      body.startTime !== undefined || body.endTime !== undefined;

    if (isReschedule) {
      // Tasks 01, 09 — re-validate doctor availability for the new slot.
      await validateDoctorAvailability(req.clinicId, doctorId, newDate, newStart, newEnd);
      // Task 09B — re-check conflicts, excluding this appointment itself.
      await checkSlotConflict(req.clinicId, doctorId, newDate, newStart, newEnd, existing._id);

      updates.appointmentDate = newDate;
      updates.startTime = newStart;
      updates.endTime = newEnd;
      updates.durationMinutes = timeToMinutes(newEnd) - timeToMinutes(newStart);
    }

    if (body.type !== undefined) updates.type = body.type;
    if (body.source !== undefined) updates.source = body.source;
    if (body.notes !== undefined) updates.notes = body.notes ? body.notes.trim() : '';

    if (Object.keys(updates).length === 0) {
      throw badRequest('No valid fields provided to update');
    }

    updates.updatedBy = req.user.userId;

    // Phase 14.4 — visibility.mongoFilter reapplied here (not just on
    // the `existing` read above) so this write can never touch a
    // document outside the caller's visible scope even under a race
    // where the appointment's ownership changed between the read and
    // this write — same defense-in-depth pattern as every other
    // mutating query in this file scoping by {_id, clinicId} together.
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId, ...visibility.mongoFilter },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!appointment) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    // Audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: isReschedule ? 'APPOINTMENT_RESCHEDULED' : 'APPOINTMENT_UPDATED',
      entityType: 'Appointment',
      entityId: appointment._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: appointment });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 05/06 — STATUS MANAGEMENT + CANCELLATION ----------
   One endpoint covers both: status transitions (scheduled ->
   confirmed -> waiting -> completed, or -> no_show) and cancellation
   (status -> cancelled, with reason). Cancelling frees the slot —
   checkSlotConflict already excludes 'cancelled'/'no_show' from its
   overlap query, so a cancelled slot is immediately rebookable. */

const VALID_STATUSES = ['scheduled', 'confirmed', 'waiting', 'completed', 'cancelled', 'no_show'];

// Coarse forward-only state machine — prevents nonsensical jumps
// (e.g. reopening a completed visit) while staying lightweight (a
// plain lookup table, not a separate state-machine library/pattern).
const ALLOWED_TRANSITIONS = {
  scheduled: ['confirmed', 'waiting', 'cancelled', 'no_show'],
  confirmed: ['waiting', 'completed', 'cancelled', 'no_show'],
  waiting:   ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show:   ['scheduled'], // rebooking the same slot record is allowed
};

const updateAppointmentStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw badRequest('Invalid appointment id');
    }

    const body = req.body || {};
    if (!isNonEmptyString(body.status) || !VALID_STATUSES.includes(body.status)) {
      throw badRequest(`status is required and must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    if (body.status === 'cancelled' && body.cancellationReason !== undefined) {
      if (typeof body.cancellationReason !== 'string' || body.cancellationReason.length > MAX_CANCEL_REASON_LENGTH) {
        throw badRequest(`cancellationReason must be a string up to ${MAX_CANCEL_REASON_LENGTH} characters`);
      }
    }

    // Phase 14.4 — this is the route a doctor uses to confirm/start/
    // complete/no-show "their own day" (see RBAC note above the
    // router). Without this check a doctor holding appointments.edit
    // could PATCH the status of any appointment in the clinic just by
    // guessing/incrementing an id — visibility, not just permission,
    // has to gate this write.
    const visibility = visibilityEngine.getRequestVisibility(req, 'appointments');
    if (visibilityEngine.isDenied(visibility.mongoFilter)) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    const existing = await Appointment.findOne({ _id: req.params.id, clinicId: req.clinicId, ...visibility.mongoFilter });
    if (!existing) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    const allowed = ALLOWED_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(body.status)) {
      throw badRequest(`Cannot change status from "${existing.status}" to "${body.status}"`);
    }

    const updates = { status: body.status, updatedBy: req.user.userId };
    if (body.status === 'cancelled') {
      updates.cancelledAt = new Date();
      updates.cancelledBy = req.user.userId;
      updates.cancellationReason = body.cancellationReason ? body.cancellationReason.trim() : null;
    }

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId, ...visibility.mongoFilter },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!appointment) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    const action = body.status === 'cancelled' ? 'APPOINTMENT_CANCELLED' : 'APPOINTMENT_STATUS_UPDATED';

    // Audit log
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action,
      entityType: 'Appointment',
      entityId: appointment._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: appointment });
  } catch (err) {
    next(err);
  }
};

/* ---------- TASK 10 — RBAC ----------
   Permission Engine controls WHICH ACTIONS a role may attempt
   (create/view/edit) — unchanged by Phase 14.4, still the
   requirePermission() calls below, per-clinic configurable via the
   Permission matrix (Phase 13.x). The doctor/receptionist/billing_staff
   descriptions below are this module's typical/expected configuration,
   not hardcoded checks in code.

   Phase 14.4 (Visibility Engine integration) layers WHICH DATA those
   actions can reach on top, inside listAppointments/getAppointment/
   updateAppointment/updateAppointmentStatus via
   visibilityEngine.getRequestVisibility(req, 'appointments'):

   clinic_admin:    FULL_CLINIC — every appointment in the clinic.
   receptionist:    OPERATIONAL — every appointment in the clinic
                     (front-desk needs the whole schedule to book/
                     reschedule/cancel on behalf of patients).
   doctor:          OWN_DATA — only appointments where doctorId
                     matches this doctor's linked Doctor profile
                     (req.user.doctorId, resolved at login by
                     authenticate() — Phase 14.2/Staff Identity
                     Linking). Applies to list, detail-by-id, edit,
                     and status-update alike — a doctor can never
                     read OR write another doctor's appointment,
                     including by guessing an id (returns 404, not
                     403 — see getAppointment).
   billing_staff:   NONE at the general appointments-module level —
                     matches the spec's "must never see the complete
                     clinic schedule". Billing's actual need (completed
                     appointments, to generate an invoice) is served
                     by the existing, narrower GET
                     /api/billing/from-appointment/:appointmentId
                     handoff route (billing module), not this general
                     list/detail — that route already scopes to one
                     specific appointment the billing flow already
                     knows about, rather than exposing the schedule.
   super_admin:     no clinic context — blocked by
                     requireClinicContext, same as every module
                     above, before visibility is even evaluated. */

const appointmentRouter = express.Router();

appointmentRouter.post(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('appointments', 'create'),
  createAppointment
);

appointmentRouter.get(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('appointments', 'view'),
  listAppointments
);

appointmentRouter.get(
  '/:id',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('appointments', 'view'),
  getAppointment
);

appointmentRouter.put(
  '/:id',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('appointments', 'edit'),
  updateAppointment
);

appointmentRouter.patch(
  '/:id/status',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('appointments', 'edit'),
  updateAppointmentStatus
);

app.use('/api/appointments', appointmentRouter);

/* ============================================================
   4I. DASHBOARD / OPERATIONS COMMAND CENTER (Phase 9.0)
   Read-only aggregation over the existing Patient, Doctor, and
   Appointment collections — no new collection, no repository/
   service layer, same "inlined, lightweight" convention as every
   module above. One endpoint returns everything the command-
   center view needs in a single round trip.

   Tenant isolation: every query below is scoped by req.clinicId,
   sourced only from tenantScope() (Critical Security Rule — same
   posture as every module above). super_admin has no single
   clinic and is blocked by requireClinicContext, same as Clinic/
   Settings/Patients/Doctors/Appointments.

   RBAC: read-only, no mutation — every clinic-scoped role that can
   already read appointments (clinic_admin, receptionist, doctor,
   billing_staff) can view the dashboard. No audit log entry is
   written, consistent with every other GET in this file (audit
   logs record mutations: *_CREATED/_UPDATED/_CANCELLED — not reads).

   Deliberately NOT included yet: revenue/billing figures. The
   Invoice model already exists (section 1C) but has no routes
   wired (see PLANNED ROUTES below) — a revenue number on a live
   ops dashboard with no real billing pipeline behind it would be
   fabricated data, not an operational insight. The frontend KPI
   card stays a visible "coming soon" placeholder until the
   Billing module ships (see Phase 9.0 report — Recommendations).
   ============================================================ */

// dayLabelForDate, timeToMinutes, normalizeAppointmentDate are
// defined above in section 4H (Appointment Engine) and reused
// here as-is — the dashboard speaks the exact same "HH:MM" /
// Mon..Sun vocabulary as appointments and doctor availability.

const getDashboardOverview = async (req, res, next) => {
  try {
    const todayDate = normalizeAppointmentDate(new Date());
    const todayLabel = dayLabelForDate(todayDate);
    const nowMinutes = (() => {
      const n = new Date();
      return n.getHours() * 60 + n.getMinutes();
    })();

    // Phase 14.3 -- Dashboard Visibility Integration. Computed once per
    // request and reused by every widget query below (Goal 5/9 pattern
    // from visibilityEngine.js: getRequestVisibility caches on req).
    // dash.widgets.{appointments,patients,revenue,schedule} carry the
    // scope + mongoFilter this route needs. The full doctor roster
    // isn't a DASHBOARD_WIDGETS entry (the spec's "Total Doctors" KPI
    // is a clinic-wide/operational concept, not per-doctor data) --
    // gated below via canViewOperational off the base 'dashboard'
    // module context instead, which resolves true only for
    // clinic_admin and receptionist (FULL_CLINIC / OPERATIONAL).
    const dash = visibilityEngine.getDashboardVisibility(req.user);
    const baseCtx = visibilityEngine.getVisibilityContext(req.user, 'dashboard');
    const apptFilter = dash.widgets.appointments.mongoFilter;
    const canSeeDoctorRoster = baseCtx.canViewOperational;

    // Patient count/activity uses the 'patients' widget scope -- a
    // doctor's "active patients" KPI must reflect only their own
    // patients, not the clinic total. Patient has no doctorId field
    // (see visibilityEngine header notes), so OWN_DATA here resolves
    // via the same Appointment-join strategy as getVisiblePatients().
    const patientScope = dash.widgets.patients.scope;
    const patientMongoFilter = patientScope === visibilityEngine.SCOPE_KINDS.OWN_DATA
      ? await visibilityEngine.getVisiblePatients(req.user, { Appointment })
      : dash.widgets.patients.mongoFilter; // {} for FULL_CLINIC/OPERATIONAL, deny sentinel for NONE

    const patientsDenied = visibilityEngine.isDenied(patientMongoFilter);
    const apptsDenied = visibilityEngine.isDenied(apptFilter);

    // Five independent reads, fired together. Each is a single
    // indexed, clinic-scoped query -- Patient/Doctor counts hit the
    // {clinicId,isActive} indexes (Patient added in Phase 9.0,
    // Doctor already existed); the appointments read hits the
    // {clinicId,appointmentDate} index. A clinic's daily appointment
    // volume is realistically tens, not thousands, so pulling the
    // full day and tallying status/per-doctor counts in application
    // code (below) is cheaper than running four more aggregate
    // queries against the database for numbers this small.
    //
    // Phase 14.3: every query below now folds in the Visibility
    // Engine's mongoFilter for its widget. tenantScope's clinicId
    // stays the base of every filter object -- the engine only adds
    // to it, never replaces it (see visibilityEngine.js header).
    const [activePatients, activeDoctors, totalDoctors, doctorsList, todaysAppointments] = await Promise.all([
      patientsDenied
        ? 0
        : Patient.countDocuments({ clinicId: req.clinicId, isActive: true, ...patientMongoFilter }),
      canSeeDoctorRoster ? Doctor.countDocuments({ clinicId: req.clinicId, isActive: true }) : 0,
      canSeeDoctorRoster ? Doctor.countDocuments({ clinicId: req.clinicId }) : 0,
      canSeeDoctorRoster
        ? Doctor.find({ clinicId: req.clinicId, isActive: true })
            .select('fullName specialization initials avatarColor isAvailable weeklyAvailability')
            .lean()
        : (req.user && req.user.doctorId
            ? Doctor.find({ clinicId: req.clinicId, isActive: true, _id: req.user.doctorId })
                .select('fullName specialization initials avatarColor isAvailable weeklyAvailability')
                .lean()
            : []),
      apptsDenied
        ? []
        : Appointment.find({ clinicId: req.clinicId, appointmentDate: todayDate, ...apptFilter })
            .populate('patientId', 'fullName patientId phone')
            .populate('doctorId', 'fullName specialization initials avatarColor')
            .sort({ startTime: 1 })
            .lean(),
    ]);

    // Single pass over today's appointments: tally status counts
    // and per-doctor "patients today" counts together, rather than
    // looping the array twice.
    const statusCounts = { scheduled: 0, confirmed: 0, waiting: 0, completed: 0, cancelled: 0, no_show: 0 };
    const patientsTodayByDoctor = {};

    for (const appt of todaysAppointments) {
      if (statusCounts[appt.status] !== undefined) statusCounts[appt.status] += 1;
      const docKey = String(appt.doctorId && appt.doctorId._id ? appt.doctorId._id : appt.doctorId);
      patientsTodayByDoctor[docKey] = (patientsTodayByDoctor[docKey] || 0) + 1;
    }

    // Doctor roster for today: working hours (from weeklyAvailability)
    // + short-term isAvailable flag (e.g. on leave) + how many
    // patients they have on today's schedule.
    const doctorsToday = doctorsList.map((d) => {
      const daySchedule = (d.weeklyAvailability || []).find((w) => w.day === todayLabel);
      const workingToday = !!(daySchedule && daySchedule.isAvailable);
      const status = !d.isAvailable ? 'on_leave' : (workingToday ? 'available' : 'off_today');
      return {
        doctorId: d._id,
        fullName: d.fullName,
        specialization: d.specialization,
        initials: d.initials,
        avatarColor: d.avatarColor,
        status,
        patientsToday: patientsTodayByDoctor[String(d._id)] || 0,
      };
    });

    // "Upcoming" = today's appointments that are still unresolved
    // (not yet completed/cancelled/no-show) and haven't started yet.
    // Capped to 5 — this powers a small sidebar widget, not a list view.
    const upcomingAppointments = todaysAppointments
      .filter((appt) =>
        ['scheduled', 'confirmed', 'waiting'].includes(appt.status) &&
        timeToMinutes(appt.startTime) >= nowMinutes
      )
      .slice(0, 5);

    const todaysRemaining = statusCounts.scheduled + statusCounts.confirmed + statusCounts.waiting;

    // Phase 10.0 -- live billing KPIs for the dashboard summary widget.
    // Phase 14.3 -- now scoped by the 'revenue' widget (see DASHBOARD_MATRIX):
    //   clinic_admin  -> FULL_CLINIC  (all invoices)
    //   doctor        -> OWN_DATA     (only invoices carrying their doctorId)
    //   receptionist  -> NONE         ("no financial analytics" per spec)
    //   billing_staff -> FINANCIAL    (all invoices -- a billing clerk sees
    //                                  every invoice in the clinic, not a
    //                                  doctor-scoped subset)
    // Values stay `null` (not 0) when the widget is not visible, so the
    // frontend can tell "no revenue today" apart from "not allowed to
    // see revenue" and remove the KPI card entirely in the latter case
    // (see dashboard.js applyDashboardVisibility()).
    const revenueWidget = dash.widgets.revenue;
    let billingKpis = { todaysRevenue: null, pendingCount: null, pendingAmount: null };
    if (revenueWidget.visible && !visibilityEngine.isDenied(revenueWidget.mongoFilter)) {
      try {
        const todayStart = new Date(todayDate);
        const todayEnd   = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
        const cidObj     = new mongoose.Types.ObjectId(req.clinicId);
        // revenueWidget.mongoFilter is {} for FULL_CLINIC/FINANCIAL, or
        // { doctorId } for a doctor's OWN_DATA scope -- folded into both
        // aggregations below exactly like every other widget filter.
        const revenueDoctorMatch = revenueWidget.mongoFilter && revenueWidget.mongoFilter.doctorId
          ? { doctorId: new mongoose.Types.ObjectId(revenueWidget.mongoFilter.doctorId) }
          : {};
        const [todayRevAgg, pendingAgg] = await Promise.all([
          Invoice.aggregate([
            { $match: { clinicId: cidObj, paymentStatus: 'paid', invoiceDate: { $gte: todayStart, $lt: todayEnd }, ...revenueDoctorMatch } },
            { $group: { _id: null, amount: { $sum: '$total' } } },
          ]),
          Invoice.aggregate([
            { $match: { clinicId: cidObj, paymentStatus: 'pending', ...revenueDoctorMatch } },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$total' } } },
          ]),
        ]);
        billingKpis = {
          todaysRevenue: parseFloat(((todayRevAgg[0]?.amount) || 0).toFixed(2)),
          pendingCount:  pendingAgg[0]?.count || 0,
          pendingAmount: parseFloat(((pendingAgg[0]?.amount) || 0).toFixed(2)),
        };
      } catch (billingErr) {
        console.error('Dashboard billing KPI fetch failed (non-fatal):', billingErr.message);
        billingKpis = { todaysRevenue: 0, pendingCount: 0, pendingAmount: 0 };
      }
    }

    res.status(200).json({
      success: true,
      data: {
        date: todayDate.toISOString().slice(0, 10),
        summary: {
          activePatients,
          activeDoctors,
          totalDoctors,
          todaysTotal: todaysAppointments.length,
          todaysRemaining,
          todaysScheduled: statusCounts.scheduled,
          todaysConfirmed: statusCounts.confirmed,
          todaysWaiting: statusCounts.waiting,
          todaysCompleted: statusCounts.completed,
          todaysCancelled: statusCounts.cancelled,
          todaysNoShow: statusCounts.no_show,
          // Phase 10.0 billing KPIs -- null (not 0) when the 'revenue'
          // widget isn't visible for this role, see billingKpis above.
          todaysRevenue:        billingKpis.todaysRevenue,
          pendingInvoiceCount:  billingKpis.pendingCount,
          pendingInvoiceAmount: billingKpis.pendingAmount,
        },
        todaysAppointments,
        upcomingAppointments,
        doctorsToday,
        // Phase 14.3 -- lets the frontend build its widget-visibility
        // decisions from the exact same scope computation the backend
        // just used, instead of re-deriving a mirror table purely from
        // window._appPermissions.role. Single source of truth: this
        // object IS visibilityEngine.getDashboardVisibility(req.user),
        // serialized. See dashboard.js applyDashboardVisibility().
        visibility: {
          role: dash.role,
          scope: dash.scope,
          widgets: Object.fromEntries(
            Object.entries(dash.widgets).map(([key, w]) => [key, { scope: w.scope, visible: w.visible }])
          ),
          canViewOperational: baseCtx.canViewOperational,
          canViewFinancial: baseCtx.canViewFinancial,
          canViewClinical: baseCtx.canViewClinical,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Dashboard Recent Activity (Phase D1, enriched in D3) ----
   GET /api/dashboard/activity?limit=
   Reads the latest AuditLog entries for the clinic — the exact same
   entries every module already writes on create/update/status-change
   actions (PATIENT_CREATED, APPOINTMENT_BOOKED, INVOICE_CREATED,
   STAFF_CREATED, DEPARTMENT_CREATED, SETTINGS_UPDATED, etc. — see
   section 1E auditLogSchema and the AuditLog.create() calls scattered
   through Patients/Doctors/Departments/Appointments/Billing/Staff).
   AuditLog was previously write-only from the API's perspective; D1
   added this first read route. Read-only, no new writes, same RBAC
   as the rest of the dashboard — every clinic-scoped role that can
   see the dashboard can see what happened on it.

   Phase D3 adds: a per-entity `description` (resolved via batched
   lookups, not N+1 — see idsByType below), the acting user's `role`,
   an `icon` per entityType, and `date`/`time` alongside the existing
   `createdAt` so the client can show relative time ("2 min ago"),
   an absolute date/time, and a "Yesterday" bucket without an extra
   request. No LOGIN/LOGOUT audit action exists yet anywhere in this
   codebase (see ACTIVITY_LABELS below), so those rows simply never
   appear today — nothing here fabricates them. */

// Raw action code -> short human label (activity "title"). Falls
// back to a generic Title Case of the action code for anything not
// explicitly listed, so a future AuditLog.create() call elsewhere
// never produces a blank activity row.
const ACTIVITY_LABELS = {
  INITIAL_ADMIN_CREATED: 'Clinic account created',
  CLINIC_UPDATED: 'Clinic details updated',
  SETTINGS_UPDATED: 'Settings updated',
  PATIENT_CREATED: 'Patient created',
  PATIENT_UPDATED: 'Patient updated',
  PATIENT_REACTIVATED: 'Patient reactivated',
  PATIENT_DEACTIVATED: 'Patient deactivated',
  DOCTOR_CREATED: 'Doctor added',
  DOCTOR_UPDATED: 'Doctor updated',
  DOCTOR_REACTIVATED: 'Doctor reactivated',
  DOCTOR_DEACTIVATED: 'Doctor deactivated',
  DOCTOR_STATUS_UPDATED: 'Doctor status updated',
  DEPARTMENT_CREATED: 'Department added',
  DEPARTMENT_UPDATED: 'Department updated',
  DEPARTMENT_REACTIVATED: 'Department activated',
  DEPARTMENT_DEACTIVATED: 'Department deactivated',
  DEPARTMENT_REORDERED: 'Departments reordered',
  APPOINTMENT_BOOKED: 'Appointment booked',
  APPOINTMENT_RESCHEDULED: 'Appointment rescheduled',
  APPOINTMENT_UPDATED: 'Appointment updated',
  APPOINTMENT_STATUS_UPDATED: 'Appointment status updated',
  APPOINTMENT_CANCELLED: 'Appointment cancelled',
  INVOICE_CREATED: 'Invoice created',
  INVOICE_UPDATED: 'Invoice updated',
  INVOICE_PAYMENT_UPDATED: 'Invoice paid',
  INVOICE_CANCELLED: 'Invoice cancelled',
  STAFF_CREATED: 'Staff created',
  STAFF_UPDATED: 'Staff updated',
  STAFF_ACTIVATED: 'Staff member activated',
  STAFF_DEACTIVATED: 'Staff member deactivated',
  STAFF_PASSWORD_RESET: 'Staff password reset',
  LOGIN: 'Login',
  LOGOUT: 'Logout',
};

function labelForActivity(action) {
  if (ACTIVITY_LABELS[action]) return ACTIVITY_LABELS[action];
  return String(action || '')
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

// entityType -> icon name (Material Symbols). Sent to the client so
// the icon choice lives in one place; color stays client-side, mapped
// to the app's existing design-system accent classes.
const ACTIVITY_ICONS = {
  Patient: 'person',
  Doctor: 'stethoscope',
  Appointment: 'event',
  Invoice: 'receipt_long',
  User: 'badge',
  Department: 'apartment',
  Setting: 'settings',
  Clinic: 'storefront',
};

// User.role enum value -> display label, for the "Role" field on
// each activity row.
const ROLE_LABELS = {
  super_admin: 'Super Admin',
  clinic_admin: 'Clinic Admin',
  doctor: 'Doctor',
  receptionist: 'Receptionist',
  billing_staff: 'Billing Staff',
};

/* Builds a human-readable description for one audit log entry, e.g.
   "Ravi Kumar was registered as a new patient". Falls back to the
   generic label if the referenced entity can't be found (hard
   deleted, or a legacy log row) — the feed must never render a
   blank description. `entities` is a Map keyed by
   "entityType:entityId" -> lean doc, built by getDashboardActivity
   below via a handful of batched queries, so this is O(1) per row
   rather than one query per row. */
function describeActivity(log, entities) {
  const key = log.entityId ? `${log.entityType}:${log.entityId}` : null;
  const entity = key ? entities.get(key) : null;

  switch (log.entityType) {
    case 'Patient': {
      const name = entity?.fullName || 'A patient';
      if (log.action === 'PATIENT_CREATED') return `${name} was registered as a new patient`;
      if (log.action === 'PATIENT_REACTIVATED') return `${name}'s record was reactivated`;
      if (log.action === 'PATIENT_DEACTIVATED') return `${name}'s record was deactivated`;
      return `${name}'s patient record was updated`;
    }
    case 'Doctor': {
      const name = entity?.fullName ? `Dr. ${entity.fullName}` : 'A doctor';
      if (log.action === 'DOCTOR_CREATED') return `${name} was added to the clinic`;
      if (log.action === 'DOCTOR_REACTIVATED') return `${name} was marked active`;
      if (log.action === 'DOCTOR_DEACTIVATED') return `${name} was marked inactive`;
      if (log.action === 'DOCTOR_STATUS_UPDATED') return `${name}'s status was updated`;
      return `${name}'s profile was updated`;
    }
    case 'Department': {
      const name = entity?.name || 'A department';
      if (log.action === 'DEPARTMENT_CREATED') return `${name} department was created`;
      if (log.action === 'DEPARTMENT_REACTIVATED') return `${name} department was activated`;
      if (log.action === 'DEPARTMENT_DEACTIVATED') return `${name} department was deactivated`;
      if (log.action === 'DEPARTMENT_REORDERED') return 'Department display order was changed';
      return `${name} department was updated`;
    }
    case 'Appointment': {
      const patientName = entity?.patientId?.fullName || 'a patient';
      const doctorName = entity?.doctorId?.fullName ? `Dr. ${entity.doctorId.fullName}` : 'a doctor';
      if (log.action === 'APPOINTMENT_BOOKED') return `Appointment booked for ${patientName} with ${doctorName}`;
      if (log.action === 'APPOINTMENT_RESCHEDULED') return `Appointment for ${patientName} was rescheduled`;
      if (log.action === 'APPOINTMENT_CANCELLED') return `Appointment for ${patientName} was cancelled`;
      if (log.action === 'APPOINTMENT_STATUS_UPDATED') return `Appointment status updated for ${patientName}`;
      return `Appointment for ${patientName} was updated`;
    }
    case 'Invoice': {
      const num = entity?.invoiceNumber || 'An invoice';
      const patientName = entity?.patientId?.fullName;
      const suffix = patientName ? ` for ${patientName}` : '';
      if (log.action === 'INVOICE_CREATED') return `Invoice ${num} created${suffix}`;
      if (log.action === 'INVOICE_PAYMENT_UPDATED') return `Invoice ${num} payment was recorded`;
      if (log.action === 'INVOICE_CANCELLED') return `Invoice ${num} was cancelled`;
      return `Invoice ${num} was updated`;
    }
    case 'User': {
      const name = entity?.name || 'A staff member';
      if (log.action === 'STAFF_CREATED') return `${name} was added as staff`;
      if (log.action === 'STAFF_ACTIVATED') return `${name}'s account was activated`;
      if (log.action === 'STAFF_DEACTIVATED') return `${name}'s account was deactivated`;
      if (log.action === 'STAFF_PASSWORD_RESET') return `${name}'s password was reset`;
      if (log.action === 'INITIAL_ADMIN_CREATED') return `${name}'s clinic admin account was created`;
      return `${name}'s account was updated`;
    }
    case 'Setting':
      return 'Clinic settings were updated';
    case 'Clinic':
      return 'Clinic details were updated';
    default:
      return labelForActivity(log.action);
  }
}

// Phase 14.3 -- Recent Activity isn't one of the engine's five named
// DASHBOARD_WIDGETS, so it maps onto the closest existing scope per
// the phase spec's own framing ("Doctor -> Own activity only",
// "Reception -> Operational activities", "Billing -> Financial
// activities", "Admin -> Complete clinic activity") rather than
// inventing a new scope kind in visibilityEngine.js. AuditLog has no
// doctorId field (see auditLogSchema above) -- only `userId`, the
// acting user -- so "own activity" for a doctor is scoped by
// userId:req.user.userId (matches the engine's own 'notifications'
// widget convention for per-user scoping), not a fabricated doctorId
// join. Operational/financial scoping is by entityType, since that's
// the only axis AuditLog actually carries that maps to "clinical
// ops" vs "financial" the way the spec means it.
const OPERATIONAL_ACTIVITY_ENTITY_TYPES = ['Patient', 'Appointment', 'Doctor', 'Department'];
const FINANCIAL_ACTIVITY_ENTITY_TYPES = ['Invoice'];

function activityVisibilityFilter(user) {
  const dashScope = visibilityEngine.getDashboardVisibility(user).scope;
  switch (dashScope) {
    case visibilityEngine.SCOPE_KINDS.FULL_CLINIC:
      return {}; // admin -- complete clinic activity, no extra filter
    case visibilityEngine.SCOPE_KINDS.OWN_DATA:
      // doctor -- own activity only. No doctorId on AuditLog; scope by
      // acting user instead. A doctor account with no userId (shouldn't
      // happen post-authenticate) gets the deny-safe sentinel.
      return user && user.userId ? { userId: user.userId } : { __visibilityDeny: true };
    case visibilityEngine.SCOPE_KINDS.OPERATIONAL:
      // receptionist -- operational activities (patients/appointments/
      // doctors/departments), never financial.
      return { entityType: { $in: OPERATIONAL_ACTIVITY_ENTITY_TYPES } };
    case visibilityEngine.SCOPE_KINDS.FINANCIAL:
      // billing_staff -- financial activities (invoices) only.
      return { entityType: { $in: FINANCIAL_ACTIVITY_ENTITY_TYPES } };
    default:
      return { __visibilityDeny: true };
  }
}

const getDashboardActivity = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const activityFilter = activityVisibilityFilter(req.user);
    if (visibilityEngine.isDenied(activityFilter)) {
      return res.status(200).json({ success: true, data: [] });
    }

    const logs = await AuditLog.find({ clinicId: req.clinicId, ...activityFilter })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'name role')
      .lean();

    if (!logs.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    const idsByType = {};
    for (const l of logs) {
      if (!l.entityId) continue;
      if (!idsByType[l.entityType]) idsByType[l.entityType] = new Set();
      idsByType[l.entityType].add(String(l.entityId));
    }

    const entities = new Map();
    const lookups = [];

    if (idsByType.Patient) {
      lookups.push(
        Patient.find({ _id: { $in: [...idsByType.Patient] }, clinicId: req.clinicId })
          .select('fullName').lean()
          .then((docs) => docs.forEach((d) => entities.set(`Patient:${d._id}`, d)))
      );
    }
    if (idsByType.Doctor) {
      lookups.push(
        Doctor.find({ _id: { $in: [...idsByType.Doctor] }, clinicId: req.clinicId })
          .select('fullName').lean()
          .then((docs) => docs.forEach((d) => entities.set(`Doctor:${d._id}`, d)))
      );
    }
    if (idsByType.Department) {
      lookups.push(
        Department.find({ _id: { $in: [...idsByType.Department] }, clinicId: req.clinicId })
          .select('name').lean()
          .then((docs) => docs.forEach((d) => entities.set(`Department:${d._id}`, d)))
      );
    }
    if (idsByType.Appointment) {
      lookups.push(
        Appointment.find({ _id: { $in: [...idsByType.Appointment] }, clinicId: req.clinicId })
          .select('patientId doctorId')
          .populate('patientId', 'fullName')
          .populate('doctorId', 'fullName')
          .lean()
          .then((docs) => docs.forEach((d) => entities.set(`Appointment:${d._id}`, d)))
      );
    }
    if (idsByType.Invoice) {
      lookups.push(
        Invoice.find({ _id: { $in: [...idsByType.Invoice] }, clinicId: req.clinicId })
          .select('invoiceNumber patientId')
          .populate('patientId', 'fullName')
          .lean()
          .then((docs) => docs.forEach((d) => entities.set(`Invoice:${d._id}`, d)))
      );
    }
    if (idsByType.User) {
      lookups.push(
        User.find({ _id: { $in: [...idsByType.User] }, clinicId: req.clinicId })
          .select('name role').lean()
          .then((docs) => docs.forEach((d) => entities.set(`User:${d._id}`, d)))
      );
    }

    await Promise.all(lookups);

    res.status(200).json({
      success: true,
      data: logs.map((l) => ({
        _id: l._id,
        action: l.action,
        title: labelForActivity(l.action),
        description: describeActivity(l, entities),
        entityType: l.entityType,
        entityId: l.entityId,
        icon: ACTIVITY_ICONS[l.entityType] || 'history',
        actor: l.userId?.name || null,
        role: l.userId?.role || null,
        roleLabel: l.userId?.role ? (ROLE_LABELS[l.userId.role] || l.userId.role) : null,
        createdAt: l.createdAt,
        date: l.createdAt ? new Date(l.createdAt).toISOString().slice(0, 10) : null,
        time: l.createdAt ? new Date(l.createdAt).toISOString().slice(11, 16) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Dashboard Revenue Analytics (Phase D2) ----------
   GET /api/dashboard/revenue?period=weekly|monthly
   Dashboard-local revenue widget, deliberately separate from
   GET /api/reports/revenue (Reports module — out of scope for this
   phase, left untouched). Two views:
     weekly  — last 7 calendar days, one bucket per day
     monthly — last 12 calendar months, one bucket per month
   Both are zero-filled: a day/month with no paid invoices still
   appears in `trend` with revenue: 0, rather than being omitted
   (silently dropping empty buckets would misrender as a shorter
   x-axis instead of an honest zero). Only paymentStatus:'paid'
   invoices count as revenue — pending/cancelled/draft are excluded
   at the query level, matching how every other revenue figure on
   this dashboard is already computed (see getDashboardOverview's
   billingKpis and getBillingSummary).

   Aggregation only — MongoDB groups and sums; Node.js never loads
   raw invoices or computes totals in application code. The
   {clinicId, invoiceDate, paymentStatus} compound index (declared
   above, shared with /api/reports/revenue and /api/billing/summary)
   covers both the $match and the sort implied by grouping on
   invoiceDate, so no new index is needed. */

const getDashboardRevenue = async (req, res, next) => {
  try {
    // Phase 14.3 -- same 'revenue' widget scope as the overview KPIs
    // (see DASHBOARD_MATRIX): receptionist is denied outright ("no
    // financial analytics"), doctor is folded into the aggregation's
    // $match as a doctorId filter (own revenue only), clinic_admin and
    // billing_staff see the full clinic trend.
    const revenueWidget = visibilityEngine.getDashboardVisibility(req.user).widgets.revenue;
    if (!revenueWidget.visible || visibilityEngine.isDenied(revenueWidget.mongoFilter)) {
      return res.status(200).json({
        success: true,
        data: { period: req.query.period === 'monthly' ? 'monthly' : 'weekly', range: null, trend: [], stats: { total: 0, average: 0, highest: null, lowest: null }, visible: false },
      });
    }
    const revenueDoctorMatch = revenueWidget.mongoFilter && revenueWidget.mongoFilter.doctorId
      ? { doctorId: new mongoose.Types.ObjectId(revenueWidget.mongoFilter.doctorId) }
      : {};

    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const now = new Date();

    // Bucket boundaries + zero-filled bucket list, built in JS (cheap —
    // at most 12 iterations) so the response always has a complete,
    // predictable set of buckets regardless of what MongoDB returns.
    let rangeStart, buckets, dateFormat;
    if (period === 'weekly') {
      // Last 7 calendar days, oldest first, including today.
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      rangeStart = new Date(todayMidnight.getTime() - 6 * 24 * 60 * 60 * 1000);
      dateFormat = '%Y-%m-%d';
      buckets = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(rangeStart.getTime() + i * 24 * 60 * 60 * 1000);
        buckets.push({
          key: d.toISOString().slice(0, 10),
          label: d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }),
        });
      }
    } else {
      // Last 12 calendar months, oldest first, including this month.
      rangeStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      dateFormat = '%Y-%m';
      buckets = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
        buckets.push({
          key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
          label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        });
      }
    }
    const rangeEnd = now;

    // Single aggregation: paid invoices in range, grouped by bucket.
    // Phase 14.3: revenueDoctorMatch folds in the doctor's own-data
    // filter when applicable, {} otherwise -- same pattern as every
    // other widget query in this file.
    const agg = await Invoice.aggregate([
      {
        $match: {
          clinicId: cid,
          paymentStatus: 'paid',
          invoiceDate: { $gte: rangeStart, $lte: rangeEnd },
          ...revenueDoctorMatch,
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$invoiceDate' } },
          revenue: { $sum: '$total' },
          invoiceCount: { $sum: 1 },
        },
      },
    ]);

    const byKey = {};
    for (const row of agg) byKey[row._id] = { revenue: fix2(row.revenue), invoiceCount: row.invoiceCount };

    const trend = buckets.map((b) => ({
      bucket: b.key,
      label: b.label,
      revenue: byKey[b.key]?.revenue || 0,
      invoiceCount: byKey[b.key]?.invoiceCount || 0,
    }));

    // Stats computed over the same zero-filled trend, not just the
    // days/months that had invoices — "Lowest Revenue Day" should be
    // able to report a real zero day, and "Average" should reflect
    // the whole window, not just the active days within it.
    const total = fix2(trend.reduce((sum, t) => sum + t.revenue, 0));
    const average = trend.length ? fix2(total / trend.length) : 0;
    const highest = trend.reduce((max, t) => (t.revenue > max.revenue ? t : max), trend[0]);
    const lowest = trend.reduce((min, t) => (t.revenue < min.revenue ? t : min), trend[0]);

    res.status(200).json({
      success: true,
      data: {
        period,
        range: { from: rangeStart.toISOString().slice(0, 10), to: rangeEnd.toISOString().slice(0, 10) },
        trend,
        stats: {
          total,
          average,
          highest: highest ? { bucket: highest.bucket, label: highest.label, revenue: highest.revenue } : null,
          lowest: lowest ? { bucket: lowest.bucket, label: lowest.label, revenue: lowest.revenue } : null,
        },
        visible: true,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Dashboard Pending Tasks & Alerts (Phase D4) ----------
   GET /api/dashboard/tasks
   The clinic administrator's daily action center: a list of live,
   database-derived tasks/alerts, each with a priority, a count, and
   a link to the module that resolves it. Every task type below is a
   small, independent async function — TASK_GENERATORS — that returns
   either a task object or null (nothing to report). This is the
   "future ready" seam: adding Medicine Stock Alerts, Lab Reports
   Pending, License Expiry, etc. later means writing one more
   generator function and adding it to the array, not touching the
   route, the response shape, or the frontend widget.

   Tenant isolation: every generator receives req.clinicId (from
   tenantScope, never the query string or body) and scopes every
   query to it. Generators run in parallel via Promise.all, and a
   single generator throwing doesn't take down the others — each is
   wrapped so a bad query degrades to "skip this task" rather than
   a 500 for the whole widget. */

const TASK_PRIORITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

// entityType-style "module" key -> the page the task's action button
// should send the user to. Kept as a lookup (not inlined per task)
// so a future task type just picks one of these instead of hardcoding
// a filename again.
const TASK_MODULE_LINKS = {
  appointments: { label: 'View Appointments', href: 'appointments.html' },
  billing: { label: 'View Billing', href: 'billing.html' },
  doctors: { label: 'View Doctors', href: 'doctors.html' },
  staff: { label: 'View Staff', href: 'settings.html' },
  settings: { label: 'Open Settings', href: 'settings.html' },
  departments: { label: 'Manage Departments', href: 'settings.html' },
};

/* Each generator: async (clinicId) -> task object | null
   Task shape: { type, title, description, priority, count, action } */

async function taskPendingAppointments(clinicId) {
  const count = await Appointment.countDocuments({
    clinicId,
    status: { $in: ['scheduled', 'confirmed'] },
  });
  if (!count) return null;
  return {
    type: 'PENDING_APPOINTMENTS',
    title: 'Pending Appointments',
    description: `${count} appointment${count === 1 ? '' : 's'} scheduled but not yet confirmed or seen`,
    priority: TASK_PRIORITY.MEDIUM,
    count,
    action: TASK_MODULE_LINKS.appointments,
  };
}

async function taskWaitingPatients(clinicId) {
  const todayDate = normalizeAppointmentDate(new Date());
  const count = await Appointment.countDocuments({
    clinicId,
    appointmentDate: todayDate,
    status: 'waiting',
  });
  if (!count) return null;
  return {
    type: 'WAITING_PATIENTS',
    title: "Today's Waiting Patients",
    description: `${count} patient${count === 1 ? '' : 's'} currently waiting to be seen`,
    priority: TASK_PRIORITY.HIGH,
    count,
    action: TASK_MODULE_LINKS.appointments,
  };
}

async function taskPendingBills(clinicId) {
  const count = await Invoice.countDocuments({ clinicId, paymentStatus: 'pending' });
  if (!count) return null;
  return {
    type: 'PENDING_BILLS',
    title: 'Pending Bills',
    description: `${count} invoice${count === 1 ? '' : 's'} awaiting payment`,
    priority: TASK_PRIORITY.HIGH,
    count,
    action: TASK_MODULE_LINKS.billing,
  };
}

async function taskOverdueInvoices(clinicId) {
  const count = await Invoice.countDocuments({ clinicId, paymentStatus: 'overdue' });
  if (!count) return null;
  return {
    type: 'OVERDUE_INVOICES',
    title: 'Overdue Invoices',
    description: `${count} invoice${count === 1 ? '' : 's'} past due — follow up with the patient`,
    priority: TASK_PRIORITY.CRITICAL,
    count,
    action: TASK_MODULE_LINKS.billing,
  };
}

// Doctors flagged "unavailable" (short-term isAvailable=false, e.g.
// on leave) who still have unresolved future appointments booked
// against them — those slots need reassigning or the patient needs
// to be told, so this is one of the higher-priority alerts.
async function taskUnavailableDoctorsWithAppointments(clinicId) {
  const todayDate = normalizeAppointmentDate(new Date());
  const unavailableDoctors = await Doctor.find({ clinicId, isActive: true, isAvailable: false })
    .select('_id')
    .lean();
  if (!unavailableDoctors.length) return null;

  const doctorIds = unavailableDoctors.map((d) => d._id);
  const count = await Appointment.countDocuments({
    clinicId,
    doctorId: { $in: doctorIds },
    appointmentDate: { $gte: todayDate },
    status: { $in: ['scheduled', 'confirmed', 'waiting'] },
  });
  if (!count) return null;
  return {
    type: 'UNAVAILABLE_DOCTORS_WITH_APPOINTMENTS',
    title: 'Unavailable Doctors With Upcoming Appointments',
    description: `${count} upcoming appointment${count === 1 ? '' : 's'} booked with a doctor currently marked unavailable`,
    priority: TASK_PRIORITY.CRITICAL,
    count,
    action: TASK_MODULE_LINKS.doctors,
  };
}

// Future-ready per the spec ("Inactive Staff (future-ready)") — the
// User/staff model already supports this today (isActive on User,
// STAFF_ROLES = doctor/receptionist), so it's wired now rather than
// left as a stub, but kept LOW priority since an inactive staff
// account isn't itself urgent, just worth a periodic review.
async function taskInactiveStaff(clinicId) {
  const count = await User.countDocuments({
    clinicId,
    role: { $in: STAFF_ROLES },
    isActive: false,
  });
  if (!count) return null;
  return {
    type: 'INACTIVE_STAFF',
    title: 'Inactive Staff Accounts',
    description: `${count} staff account${count === 1 ? '' : 's'} marked inactive`,
    priority: TASK_PRIORITY.LOW,
    count,
    action: TASK_MODULE_LINKS.staff,
  };
}

// Clinic profile completeness — flags the fields the Settings > Clinic
// Information tab collects but that are still empty. Not a count of
// documents, but the same task shape (count = number of missing
// fields) so the widget doesn't need a special case for it.
async function taskMissingClinicInformation(clinicId) {
  const clinic = await Clinic.findById(clinicId).select('phone address branding').lean();
  if (!clinic) return null;

  const missing = [];
  if (!clinic.phone) missing.push('phone number');
  if (!clinic.address || !clinic.address.city) missing.push('address');
  if (!clinic.branding || !clinic.branding.logo) missing.push('logo');

  if (!missing.length) return null;
  return {
    type: 'MISSING_CLINIC_INFORMATION',
    title: 'Missing Clinic Information',
    description: `Clinic profile is missing: ${missing.join(', ')}`,
    priority: TASK_PRIORITY.LOW,
    count: missing.length,
    action: TASK_MODULE_LINKS.settings,
  };
}

async function taskMissingDepartments(clinicId) {
  const count = await Department.countDocuments({ clinicId, isActive: true });
  if (count > 0) return null;
  return {
    type: 'MISSING_DEPARTMENTS',
    title: 'Missing Departments',
    description: 'No active departments configured — doctors cannot be assigned a department',
    priority: TASK_PRIORITY.MEDIUM,
    count: 1,
    action: TASK_MODULE_LINKS.departments,
  };
}

// System-level warnings that don't belong to any one module. Only
// one real check exists today (a clinic still on 'trial' status with
// no doctors added yet — i.e. setup was never finished); this is the
// slot future checks (e.g. "backup failed", "WhatsApp integration
// disconnected") plug into without a new task type or endpoint.
async function taskSystemWarnings(clinicId) {
  const [clinic, doctorCount] = await Promise.all([
    Clinic.findById(clinicId).select('status').lean(),
    Doctor.countDocuments({ clinicId, isActive: true }),
  ]);
  if (!clinic) return null;
  if (clinic.status === 'trial' && doctorCount === 0) {
    return {
      type: 'SYSTEM_SETUP_INCOMPLETE',
      title: 'Clinic Setup Incomplete',
      description: 'No doctors have been added yet — the clinic cannot take appointments',
      priority: TASK_PRIORITY.HIGH,
      count: 1,
      action: TASK_MODULE_LINKS.doctors,
    };
  }
  return null;
}

// Registry — add a new generator here (and only here) to add a new
// task type to the widget. Order here is only a tie-breaker; the
// route sorts by priority before returning.
//
// Phase 14.3 -- Pending Tasks & Alerts isn't a DASHBOARD_WIDGETS entry
// either (like Recent Activity above), and every generator here reads
// clinic-wide collections with no per-doctor ownership concept ("3
// overdue invoices" or "clinic setup incomplete" isn't anyone's
// individual data) -- so this widget is gated at the CATEGORY level
// per generator, using the same FINANCIAL/OPERATIONAL/NONE scope
// vocabulary the rest of the engine uses, rather than per-document
// filtering. A role only sees task categories its dashboard scope
// already grants: financial tasks require canViewFinancial-or-FULL_CLINIC,
// operational tasks require canViewOperational-or-FULL_CLINIC, and
// admin-only tasks (clinic setup, missing departments/info, inactive
// staff) require FULL_CLINIC specifically. A doctor's dashboard scope
// is OWN_DATA, which is none of these -- so a doctor correctly sees no
// clinic-wide tasks at all, matching "Doctor: My Follow-ups" etc. in
// the spec rather than clinic operational alerts.
const TASK_CATEGORY = { FINANCIAL: 'financial', OPERATIONAL: 'operational', ADMIN: 'admin' };

const TASK_GENERATORS = [
  { fn: taskOverdueInvoices, category: TASK_CATEGORY.FINANCIAL },
  { fn: taskUnavailableDoctorsWithAppointments, category: TASK_CATEGORY.OPERATIONAL },
  { fn: taskWaitingPatients, category: TASK_CATEGORY.OPERATIONAL },
  { fn: taskPendingBills, category: TASK_CATEGORY.FINANCIAL },
  { fn: taskSystemWarnings, category: TASK_CATEGORY.ADMIN },
  { fn: taskPendingAppointments, category: TASK_CATEGORY.OPERATIONAL },
  { fn: taskMissingDepartments, category: TASK_CATEGORY.ADMIN },
  { fn: taskMissingClinicInformation, category: TASK_CATEGORY.ADMIN },
  { fn: taskInactiveStaff, category: TASK_CATEGORY.ADMIN },
];

const TASK_PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// Which task categories a role's dashboard scope unlocks. FULL_CLINIC
// (clinic_admin) gets every category; OPERATIONAL (receptionist) gets
// only operational tasks (no financial per spec: "cannot access
// financial analytics"); FINANCIAL (billing_staff) gets only financial
// tasks; OWN_DATA (doctor) and NONE get nothing -- these are clinic-wide
// operational/admin alerts, not personal to-dos.
function allowedTaskCategories(dashScope) {
  const K = visibilityEngine.SCOPE_KINDS;
  if (dashScope === K.FULL_CLINIC) return [TASK_CATEGORY.FINANCIAL, TASK_CATEGORY.OPERATIONAL, TASK_CATEGORY.ADMIN];
  if (dashScope === K.OPERATIONAL) return [TASK_CATEGORY.OPERATIONAL];
  if (dashScope === K.FINANCIAL) return [TASK_CATEGORY.FINANCIAL];
  return [];
}

const getDashboardTasks = async (req, res, next) => {
  try {
    const dashScope = visibilityEngine.getDashboardVisibility(req.user).scope;
    const allowedCategories = new Set(allowedTaskCategories(dashScope));
    const generatorsToRun = TASK_GENERATORS.filter((g) => allowedCategories.has(g.category));

    const results = await Promise.all(
      generatorsToRun.map(({ fn: generator }) =>
        generator(req.clinicId).catch((genErr) => {
          // One failing generator (e.g. a bad index, a transient
          // Mongo hiccup) should not take down the whole widget —
          // log it and simply omit that task for this load.
          console.error(`Dashboard task generator "${generator.name}" failed (non-fatal):`, genErr.message);
          return null;
        })
      )
    );

    const tasks = results
      .filter(Boolean)
      .sort((a, b) => TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority]);

    res.status(200).json({ success: true, data: tasks });
  } catch (err) {
    next(err);
  }
};

/* ---------- Dashboard Today's Queue (Phase D5) ----------
   GET /api/dashboard/queue?doctorId=&department=

   Live patient-flow widget for the Dashboard. Reuses the existing
   Appointment status enum end-to-end — no dashboard-only states are
   introduced. The real workflow (see ALLOWED_TRANSITIONS above) is:

     scheduled -> confirmed -> waiting -> completed
                                   \-> cancelled / no_show (from any
                                       non-terminal state)

   The original spec sketch used "Checked In" / "With Doctor" as
   separate steps, but no such statuses exist on Appointment and
   adding them would violate "reuse the existing Appointment
   workflow." Here: 'confirmed' is displayed as "Checked In" (a
   patient who has arrived/confirmed for today) and 'waiting' is
   displayed as "Waiting" for the queue itself; there is no distinct
   "With Doctor" state in the data model today, so it is omitted
   rather than fabricated. If a future phase adds an in-progress
   status to the schema, this route and its label map are the only
   two places that need to change.

   Tenant isolation: identical pattern to getDashboardOverview —
   every query is scoped by req.clinicId (set by tenantScope).
   Performance: one indexed find() over {clinicId, appointmentDate}
   (same compound index the overview route already uses), .lean(),
   and only the fields the queue card actually renders. Status
   summary counts are tallied in a single pass over the same
   in-memory array — no second query. */

const QUEUE_ACTIVE_STATUSES = ['scheduled', 'confirmed', 'waiting'];
const QUEUE_ALL_STATUSES = ['scheduled', 'confirmed', 'waiting', 'completed', 'cancelled', 'no_show'];

const getDashboardQueue = async (req, res, next) => {
  try {
    // Phase 14.3 -- Today's Queue maps onto the 'appointments' widget
    // (per spec: Doctor "My Queue", Reception "Today's Queue" /
    // "Waiting Patients" / "Checked-In Patients", Billing Staff: not
    // listed -> hidden, Admin: full). billing_staff's dashboard
    // 'appointments' scope is NONE (see DASHBOARD_MATRIX), so this
    // widget is denied for them exactly like every other clinical
    // widget in the Billing Staff column of the spec.
    const apptWidget = visibilityEngine.getDashboardVisibility(req.user).widgets.appointments;
    if (!apptWidget.visible || visibilityEngine.isDenied(apptWidget.mongoFilter)) {
      return res.status(200).json({
        success: true,
        data: { date: normalizeAppointmentDate(new Date()).toISOString().slice(0, 10), summary: {}, queue: [], refreshHintSeconds: 30, visible: false },
      });
    }

    const todayDate = normalizeAppointmentDate(new Date());
    const nowMinutes = (() => {
      const n = new Date();
      return n.getHours() * 60 + n.getMinutes();
    })();

    const query = req.query || {};
    const filter = { clinicId: req.clinicId, appointmentDate: todayDate };

    // apptWidget.mongoFilter is {} for FULL_CLINIC/OPERATIONAL, or
    // { doctorId } for a doctor's OWN_DATA scope. A doctor's queue is
    // ALWAYS their own, regardless of any ?doctorId= query param --
    // the query param only narrows further for roles with clinic-wide
    // visibility (admin/reception filtering to a specific doctor),
    // it can never widen a doctor's own-data scope to someone else's
    // queue. This is why the widget filter is applied first and
    // unconditionally, before the optional query-string doctorId.
    Object.assign(filter, apptWidget.mongoFilter);

    if (!filter.doctorId && isNonEmptyString(query.doctorId)) {
      if (!mongoose.Types.ObjectId.isValid(query.doctorId)) {
        throw badRequest('doctorId must be a valid id');
      }
      filter.doctorId = query.doctorId;
    }

    // Today's full set (for summary counts) is fetched once; the
    // department filter (a Doctor field, not an Appointment field)
    // is applied in-memory after populate, same as doctorFilter is
    // applied at the DB level — both converge on one query total.
    const todaysAppointments = await Appointment.find(filter)
      .select('patientId doctorId appointmentDate startTime endTime type status notes')
      .populate('patientId', 'fullName patientId phone')
      .populate('doctorId', 'fullName specialization initials avatarColor')
      .sort({ startTime: 1 })
      .lean();

    const department = isNonEmptyString(query.department) ? query.department.trim() : null;
    const scoped = department
      ? todaysAppointments.filter((a) => (a.doctorId && a.doctorId.specialization) === department)
      : todaysAppointments;

    // Summary counts reflect the filtered set (doctor/department),
    // consistent with "Each count must be calculated live from
    // appointment status" — a receptionist filtering to one doctor
    // sees that doctor's queue counts, not the whole clinic's.
    const summary = QUEUE_ALL_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
    for (const appt of scoped) {
      if (summary[appt.status] !== undefined) summary[appt.status] += 1;
    }

    const activeQueue = scoped
      .filter((a) => QUEUE_ACTIVE_STATUSES.includes(a.status))
      .map((a) => {
        const startMinutes = timeToMinutes(a.startTime);
        // Waiting time only makes sense once the patient's slot has
        // actually started; a not-yet-due 'scheduled'/'confirmed'
        // appointment isn't "waiting" yet, so it's reported as 0
        // rather than a negative or fabricated number.
        const waitingMinutes = startMinutes <= nowMinutes ? nowMinutes - startMinutes : 0;
        return {
          appointmentId: a._id,
          patient: a.patientId ? {
            id: a.patientId._id,
            name: a.patientId.fullName,
            patientId: a.patientId.patientId,
            phone: a.patientId.phone,
          } : null,
          doctor: a.doctorId ? {
            id: a.doctorId._id,
            name: a.doctorId.fullName,
            specialization: a.doctorId.specialization,
            initials: a.doctorId.initials,
            avatarColor: a.doctorId.avatarColor,
          } : null,
          department: a.doctorId ? a.doctorId.specialization : null,
          startTime: a.startTime,
          endTime: a.endTime,
          type: a.type,
          status: a.status,
          waitingMinutes,
          // Future-ready priority flags (Emergency / Senior / VIP) —
          // intentionally always false today. No such fields exist
          // yet on Patient or Appointment; this reserves the shape
          // for the frontend layout without inventing backend data,
          // per spec: "prepare the layout... do not implement now."
          priority: { emergency: false, senior: false, vip: false },
        };
      })
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
      .map((item, idx) => ({ queueNumber: idx + 1, ...item }));

    res.status(200).json({
      success: true,
      data: {
        date: todayDate.toISOString().slice(0, 10),
        summary,
        queue: activeQueue,
        // Signals the client can safely poll/upgrade to WebSocket
        // later without a payload shape change — not itself a live
        // channel.
        refreshHintSeconds: 30,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Dashboard Doctor Performance Today (Phase D6) ----------
   GET /api/dashboard/doctor-performance?sortBy=patients|revenue|completed

   Top-5 "who's performing today" widget. Reuses the exact same
   aggregation shape as getDoctorPerformanceReport (reports module,
   section "Doctor Performance Report") — same two-query pattern
   (Appointment.aggregate for volume, Invoice.aggregate for revenue),
   just scoped to today instead of a date range, and merged with the
   live availability logic already computed in getDashboardOverview
   (weeklyAvailability + isAvailable -> available/on_leave/off_today).

   Revenue source: Invoice.doctorId (added in the billing schema
   patch — see "if (!Invoice.schema.path('doctorId'))" above), not a
   join through appointmentId. This is the same field
   getDoctorPerformanceReport and getDashboardRevenue's by-doctor
   breakdown already rely on, so this widget's revenue numbers
   reconcile with Reports and the Revenue widget rather than drifting
   from a second, differently-shaped calculation.

   Tenant isolation: every query scoped by req.clinicId. */

const DOCTOR_PERF_SORT_FIELDS = {
  patients: 'patientsToday',
  revenue: 'revenue',
  completed: 'completed',
};

const getDashboardDoctorPerformance = async (req, res, next) => {
  try {
    // Phase 14.3 -- uses the engine's purpose-built
    // getDoctorPerformanceVisibility() (Phase 14.2 Goal 7) rather than
    // re-deriving the same rule here: clinic_admin/receptionist get
    // the full aggregate ranking (operational, not financial/clinical
    // -- per spec reception is allowed "Doctor schedules"), a doctor
    // is restricted to their own row, billing_staff gets none (doctor
    // productivity isn't billing's concern per spec: "cannot view
    // doctor productivity").
    const docPerfVisibility = visibilityEngine.getDoctorPerformanceVisibility(req.user);
    if (docPerfVisibility.scope === visibilityEngine.SCOPE_KINDS.NONE) {
      return res.status(200).json({
        success: true,
        data: { date: normalizeAppointmentDate(new Date()).toISOString().slice(0, 10), sortBy: 'patients', doctors: [], visible: false },
      });
    }

    const todayDate = normalizeAppointmentDate(new Date());
    const nowMinutes = (() => {
      const n = new Date();
      return n.getHours() * 60 + n.getMinutes();
    })();

    const query = req.query || {};
    const sortKey = isNonEmptyString(query.sortBy) && DOCTOR_PERF_SORT_FIELDS[query.sortBy]
      ? query.sortBy
      : 'patients';
    const sortField = DOCTOR_PERF_SORT_FIELDS[sortKey];

    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const todayStart = new Date(todayDate);
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // docPerfVisibility.mongoFilter is {} for the admin/reception
    // aggregate view, or { doctorId } when restrictedToSelf (doctor
    // role) -- folded into every query below the same way every other
    // widget's mongoFilter is folded in elsewhere in this file.
    // NOTE: Appointment/Invoice carry a `doctorId` field, but Doctor
    // documents are keyed by `_id` -- perfDoctorIdMatchOnOwnCollection
    // below is the same restriction expressed against Doctor's own
    // primary key instead of a foreign-key field.
    const perfDoctorObjMatch = docPerfVisibility.mongoFilter && docPerfVisibility.mongoFilter.doctorId
      ? { doctorId: new mongoose.Types.ObjectId(docPerfVisibility.mongoFilter.doctorId) }
      : {};
    const perfDoctorOwnIdMatch = docPerfVisibility.mongoFilter && docPerfVisibility.mongoFilter.doctorId
      ? { _id: docPerfVisibility.mongoFilter.doctorId }
      : {};

    // Four independent, indexed reads fired together — same
    // "small daily volume, tally in application code" reasoning as
    // getDashboardOverview: a clinic's per-day appointment/invoice
    // count is small enough that grouping here is cheaper than
    // adding a fourth aggregation stage to either pipeline.
    const [apptStats, revenueStats, doctorsList, upcomingToday] = await Promise.all([
      Appointment.aggregate([
        { $match: { clinicId: cid, appointmentDate: todayDate, ...perfDoctorObjMatch } },
        {
          $group: {
            _id: '$doctorId',
            patientsToday: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
      ]),
      Invoice.aggregate([
        { $match: { clinicId: cid, invoiceDate: { $gte: todayStart, $lt: todayEnd }, paymentStatus: 'paid', doctorId: { $ne: null }, ...perfDoctorObjMatch } },
        { $group: { _id: '$doctorId', revenue: { $sum: '$total' } } },
      ]),
      Doctor.find({ clinicId: req.clinicId, isActive: true, ...perfDoctorOwnIdMatch })
        .select('fullName specialization initials avatarColor isAvailable weeklyAvailability')
        .lean(),
      // Today's non-terminal appointments, for "Next Appointment" per
      // doctor — same {clinicId, doctorId, appointmentDate} index
      // getDashboardOverview and getDashboardQueue already use.
      Appointment.find({
        clinicId: req.clinicId,
        appointmentDate: todayDate,
        status: { $in: ['scheduled', 'confirmed', 'waiting'] },
        ...perfDoctorObjMatch,
      })
        .select('doctorId startTime')
        .sort({ startTime: 1 })
        .lean(),
    ]);

    const apptMap = {};
    for (const row of apptStats) apptMap[String(row._id)] = row;
    const revMap = {};
    for (const row of revenueStats) revMap[String(row._id)] = row.revenue;

    // Next appointment per doctor: first upcoming (not-yet-started)
    // slot in today's already-sorted, already-status-filtered list.
    // A single pass keyed by doctorId, not a query per doctor.
    const nextApptByDoctor = {};
    for (const appt of upcomingToday) {
      const key = String(appt.doctorId);
      if (nextApptByDoctor[key]) continue; // already have the earliest for this doctor
      if (timeToMinutes(appt.startTime) >= nowMinutes) {
        nextApptByDoctor[key] = appt.startTime;
      }
    }

    const dayLabel = dayLabelForDate(todayDate);
    const fix2 = (n) => parseFloat((n || 0).toFixed(2));

    const doctors = doctorsList.map((d) => {
      const key = String(d._id);
      const a = apptMap[key] || { patientsToday: 0, completed: 0 };
      const daySchedule = (d.weeklyAvailability || []).find((w) => w.day === dayLabel);
      const workingToday = !!(daySchedule && daySchedule.isAvailable);
      const availability = !d.isAvailable ? 'on_leave' : (workingToday ? 'available' : 'off_today');

      return {
        doctorId: d._id,
        fullName: d.fullName,
        specialization: d.specialization,
        initials: d.initials,
        avatarColor: d.avatarColor,
        patientsToday: a.patientsToday,
        completed: a.completed,
        revenue: fix2(revMap[key] || 0),
        availability,
        nextAppointmentTime: nextApptByDoctor[key] || null,
      };
    });

    // Only doctors with actual activity today (appointments or
    // revenue) are eligible for the ranking — a doctor with zero
    // patients and zero revenue isn't a "performer" to pad the Top 5
    // with, per spec: "No doctor has appointments today -> No fake
    // ranking."
    const active = doctors.filter((d) => d.patientsToday > 0 || d.revenue > 0);

    const ranked = active
      .sort((x, y) => y[sortField] - x[sortField])
      .slice(0, 5)
      .map((d, idx) => ({ rank: idx + 1, ...d }));

    res.status(200).json({
      success: true,
      data: {
        date: todayDate.toISOString().slice(0, 10),
        sortBy: sortKey,
        doctors: ranked,
        visible: true,
        restrictedToSelf: docPerfVisibility.restrictedToSelf,
      },
    });
  } catch (err) {
    next(err);
  }
};

const dashboardRouter = express.Router();
dashboardRouter.get(
  '/',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('dashboard', 'view'),
  getDashboardOverview
);
dashboardRouter.get(
  '/activity',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('dashboard', 'view'),
  getDashboardActivity
);
dashboardRouter.get(
  '/revenue',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('dashboard', 'view'),
  getDashboardRevenue
);
dashboardRouter.get(
  '/tasks',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('dashboard', 'view'),
  getDashboardTasks
);
dashboardRouter.get(
  '/queue',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('dashboard', 'view'),
  getDashboardQueue
);
dashboardRouter.get(
  '/doctor-performance',
  authenticate,
  tenantScope,
  requireClinicContext,
  requirePermission('dashboard', 'view'),
  getDashboardDoctorPerformance
);
app.use('/api/dashboard', dashboardRouter);

/* ============================================================
   4J. BILLING & INVOICE MODULE (Phase 10.0)
   Financial backbone of MediCore. Handles the complete clinic
   billing workflow: invoice creation (standalone or from an
   appointment), listing, details, payment status management,
   patient billing history, and revenue summary.

   Architecture conventions (identical to every prior module):
   — All logic inlined here. No separate files, no service layer.
   — Every query is clinicId-scoped via req.clinicId (tenantScope).
   — super_admin blocked by requireClinicContext (same as all
     other modules — they have no single clinic to bill against).
   — Explicit field whitelists on every mutation (no req.body
     spread, no mass-assignment). clinicId always from JWT, never
     from body.
   — Audit log entries for every mutation (INVOICE_CREATED,
     INVOICE_UPDATED, INVOICE_PAYMENT_UPDATED, INVOICE_CANCELLED).
   — GET endpoints do NOT write audit logs, consistent with
     Patients, Doctors, Appointments, Dashboard.
   — Patient counters (totalInvoices, lastInvoiceAt) updated on
     INVOICE_CREATED — these placeholder fields were reserved in
     patientSchema (Phase 6.1 Task 05) exactly for this moment.

   RBAC matrix:
     clinic_admin  — full CRUD
     billing_staff — full CRUD
     receptionist  — create + read (no delete, no status override)
     doctor        — read-only (own patients' invoices via list filter)

   Schema assessment (see invoiceSchema, section 1C):
   The existing schema is solid for Phase 10.0. Two targeted
   additions are made here via schema evolution (addFields strategy
   — MongoDB is schemaless so existing documents are unaffected):
     1. dueDate   — required for overdue detection and payment
                    reminders. Added as optional Date here; future
                    reminder workers will query { dueDate: { $lt: now },
                    paymentStatus: 'pending' }.
     2. doctorId  — the appointment already links doctor, but an
                    invoice can exist without an appointment (walk-in
                    billing, lab-only billing). Storing doctorId
                    directly enables fast per-doctor revenue queries
                    without joining through appointments.
   Both are soft additions: optional, default null, no migration
   required, fully backward-compatible with Phase 9.0 dashboard data.

   Revenue tracking approach:
   Summary figures (today/month/outstanding) are computed in
   GET /api/billing/summary via MongoDB aggregation ($match → $group)
   against the existing {clinicId, paymentStatus} and a new
   {clinicId, invoiceDate} compound index added below. No denormalized
   counters on Clinic — aggregations at this scale (single clinic,
   months of invoices) are sub-millisecond on indexed collections.

   Future hooks (no code yet — comments only):
   — GST/tax reporting: taxPercentage already in Settings; tax amount
     already stored per invoice. A /api/billing/reports/gst endpoint
     will $group by month + sum tax, ready to add in Phase 11.
   — Receipt PDF: generate server-side from invoice document fields —
     no new schema changes needed.
   — Payment reminders: cron job queries { dueDate < now, status:
     'pending' } — dueDate added here makes this trivial.
   — WhatsApp notifications: Settings.whatsappEnabled already flags
     per-clinic opt-in. Billing module emits the event; notification
     worker subscribes.
   — Multi-branch: clinicId is already the isolation key. When
     branchId is introduced (branchEnabled flag already on Clinic),
     add branchId to the filter — zero schema changes needed here.
   — Dashboard revenue widget: extend getDashboardOverview()
     (section 4I) with todaysRevenue + pendingInvoiceCount pulled
     from the same indexes used by GET /api/billing/summary.
   ============================================================ */

/* ---- Schema evolution: dueDate + doctorId on Invoice ---- */

// Mongoose is document-level: adding optional paths to an already-
// registered model after initial registration requires accessing the
// schema directly. Since Invoice is registered above (line ~746) and
// we cannot re-register, we use schema.add() — the idiomatic way to
// extend a schema post-definition in the same process, before any
// query runs. Both fields are optional with null defaults so existing
// documents without them are valid and unaffected.

if (!Invoice.schema.path('dueDate')) {
  Invoice.schema.add({
    dueDate: { type: Date, default: null },
  });
  Invoice.schema.index({ clinicId: 1, dueDate: 1 });
}
if (!Invoice.schema.path('doctorId')) {
  Invoice.schema.add({
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', default: null },
  });
  Invoice.schema.index({ clinicId: 1, doctorId: 1 });
}

// Compound index for date-range revenue queries (summary, reports).
// Does not duplicate the existing {clinicId, paymentStatus} index.
Invoice.schema.index({ clinicId: 1, invoiceDate: 1, paymentStatus: 1 });

/* ---- Shared billing helpers ---- */

// Generates a sequential, human-readable invoice number scoped to the
// clinic: INV-{YYYYMM}-{5-digit-seq}. The sequence is derived from
// the count of invoices in the current month for this clinic — avoids
// a separate counter collection while remaining gap-tolerant (voided
// invoices don't shift later numbers). Collision risk on concurrent
// creation is negligible at clinic scale; if needed later, a unique
// index on invoiceNumber + a retry loop handles it.
const generateInvoiceNumber = async (clinicId) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthStart = new Date(year, now.getMonth(), 1);
  const monthEnd   = new Date(year, now.getMonth() + 1, 1);

  const count = await Invoice.countDocuments({
    clinicId,
    invoiceDate: { $gte: monthStart, $lt: monthEnd },
  });

  const seq = String(count + 1).padStart(5, '0');
  return `INV-${year}${month}-${seq}`;
};

// Recalculates subtotal, tax, and total from the items array and the
// clinic's taxPercentage setting. Called on create and update so
// totals are always derived, never trusted from the client.
const computeInvoiceTotals = (items, taxPercentage = 0) => {
  const subtotal = items.reduce((sum, item) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    return sum + qty * price;
  }, 0);
  const tax   = parseFloat(((subtotal * taxPercentage) / 100).toFixed(2));
  const total = parseFloat((subtotal + tax).toFixed(2));
  return { subtotal: parseFloat(subtotal.toFixed(2)), tax, total };
};

// Validates a single line item. Returns an error string or null.
const validateItem = (item, index) => {
  if (typeof item !== 'object' || item === null) return `items[${index}] must be an object`;
  if (!item.description || typeof item.description !== 'string' || !item.description.trim())
    return `items[${index}].description is required`;
  if (item.quantity === undefined || Number(item.quantity) < 0 || !Number.isFinite(Number(item.quantity)))
    return `items[${index}].quantity must be a non-negative number`;
  if (item.price === undefined || Number(item.price) < 0 || !Number.isFinite(Number(item.price)))
    return `items[${index}].price must be a non-negative number`;
  return null;
};

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'upi', 'cheque', 'insurance', 'other'];
const PAYMENT_STATUSES = ['paid', 'pending', 'overdue', 'cancelled'];
const BILLING_SORT_FIELDS = ['invoiceDate', 'total', 'createdAt', 'dueDate'];
const MAX_INVOICE_NOTES = 1000;

/* ---- Task 01 — CREATE INVOICE ---- */

// Supports two creation paths:
//   A. Appointment-linked: body.appointmentId populates patientId +
//      doctorId automatically from the appointment record. The caller
//      may still override items, notes, dueDate.
//   B. Standalone: body.patientId + optional body.doctorId required.
// In both cases the invoice is tenant-scoped and tax is computed
// server-side from Settings.taxPercentage — the client never sends tax.

const createInvoice = async (req, res, next) => {
  try {
    const body = req.body || {};
    const errors = [];

    // Resolve patient + doctor from appointment OR from body fields
    let resolvedPatientId = null;
    let resolvedDoctorId  = null;
    let linkedAppointment = null;

    if (body.appointmentId) {
      if (!mongoose.Types.ObjectId.isValid(body.appointmentId)) {
        errors.push('appointmentId must be a valid id');
      } else {
        linkedAppointment = await Appointment.findOne({
          _id: body.appointmentId,
          clinicId: req.clinicId,
        })
          .populate('patientId', '_id fullName isActive')
          .populate('doctorId', '_id fullName')
          .lean();
        if (!linkedAppointment) errors.push('Appointment not found or does not belong to this clinic');
        else {
          resolvedPatientId = linkedAppointment.patientId?._id;
          resolvedDoctorId  = linkedAppointment.doctorId?._id || null;
          if (!linkedAppointment.patientId?.isActive) errors.push('Patient linked to appointment is inactive');
        }
      }
    } else {
      // Standalone invoice — patientId is required
      if (!body.patientId || !mongoose.Types.ObjectId.isValid(body.patientId)) {
        errors.push('patientId is required and must be a valid id');
      } else {
        const patient = await Patient.findOne({ _id: body.patientId, clinicId: req.clinicId })
          .select('_id isActive')
          .lean();
        if (!patient) errors.push('Patient not found');
        else if (!patient.isActive) errors.push('Patient is inactive');
        else resolvedPatientId = patient._id;
      }

      if (body.doctorId) {
        if (!mongoose.Types.ObjectId.isValid(body.doctorId)) {
          errors.push('doctorId must be a valid id');
        } else {
          const doc = await Doctor.findOne({ _id: body.doctorId, clinicId: req.clinicId })
            .select('_id isActive')
            .lean();
          if (!doc) errors.push('Doctor not found');
          else if (!doc.isActive) errors.push('Doctor is inactive');
          else resolvedDoctorId = doc._id;
        }
      }
    }

    // Items — at least one required
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) errors.push('At least one item is required');
    for (let i = 0; i < rawItems.length; i++) {
      const itemError = validateItem(rawItems[i], i);
      if (itemError) errors.push(itemError);
    }

    // invoiceDate — defaults to today if omitted
    let invoiceDate = new Date();
    if (body.invoiceDate !== undefined) {
      const d = new Date(body.invoiceDate);
      if (isNaN(d.getTime())) errors.push('invoiceDate must be a valid date');
      else invoiceDate = d;
    }

    // dueDate — optional, must be >= invoiceDate
    let dueDate = null;
    if (body.dueDate !== undefined) {
      const d = new Date(body.dueDate);
      if (isNaN(d.getTime())) errors.push('dueDate must be a valid date');
      else dueDate = d;
    }

    // paymentMethod — optional but validated if present
    if (body.paymentMethod !== undefined && !PAYMENT_METHODS.includes(body.paymentMethod)) {
      errors.push(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }

    // paymentStatus — only 'paid' or 'pending' allowed at creation
    const allowedCreate = ['paid', 'pending'];
    const paymentStatus = body.paymentStatus || 'pending';
    if (!allowedCreate.includes(paymentStatus)) {
      errors.push(`paymentStatus at creation must be one of: ${allowedCreate.join(', ')}`);
    }

    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') errors.push('notes must be a string');
      else if (body.notes.length > MAX_INVOICE_NOTES) errors.push(`notes must be ${MAX_INVOICE_NOTES} characters or fewer`);
    }

    if (errors.length > 0) throw badRequest(errors.join('; '));

    // Pull taxPercentage from clinic Settings (falls back to 0 if
    // Settings doc doesn't exist yet — new clinics are unbilled).
    const settings = await Setting.findOne({ clinicId: req.clinicId }).select('taxPercentage').lean();
    const taxPct = settings?.taxPercentage ?? 0;

    // Build clean items with server-computed amount (qty × price)
    const items = rawItems.map((item) => ({
      description: String(item.description).trim(),
      quantity:    Number(item.quantity),
      price:       parseFloat(Number(item.price).toFixed(2)),
      amount:      parseFloat((Number(item.quantity) * Number(item.price)).toFixed(2)),
    }));

    const { subtotal, tax, total } = computeInvoiceTotals(items, taxPct);
    const invoiceNumber = await generateInvoiceNumber(req.clinicId);

    const invoiceData = {
      clinicId:      req.clinicId,
      patientId:     resolvedPatientId,
      invoiceNumber,
      invoiceDate,
      dueDate,
      items,
      subtotal,
      tax,
      total,
      paymentStatus,
      paymentMethod: body.paymentMethod || null,
      paidAt:        paymentStatus === 'paid' ? new Date() : null,
      notes:         body.notes ? body.notes.trim() : undefined,
      createdBy:     req.user.userId,
    };

    if (resolvedDoctorId)  invoiceData.doctorId      = resolvedDoctorId;
    if (linkedAppointment) invoiceData.appointmentId = linkedAppointment._id;

    const invoice = await Invoice.create(invoiceData);

    // Update patient billing counters (Phase 6.1 Task 05 placeholders)
    // Fire-and-forget — a failure here must NOT fail the invoice creation.
    Patient.findByIdAndUpdate(resolvedPatientId, {
      $inc:  { totalInvoices: 1 },
      $set:  { lastInvoiceAt: invoice.createdAt },
    }).catch((err) => console.error('Patient billing counter update failed:', err.message));

    await AuditLog.create({
      clinicId:  req.clinicId,
      userId:    req.user.userId,
      action:    'INVOICE_CREATED',
      entityType:'Invoice',
      entityId:  invoice._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 02 — LIST INVOICES (paginated, filterable) ---- */

const listInvoices = async (req, res, next) => {
  try {
    const query = req.query || {};

    const page  = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const filter = { clinicId: req.clinicId };

    if (isNonEmptyString(query.patientId)) {
      if (!mongoose.Types.ObjectId.isValid(query.patientId)) throw badRequest('patientId must be a valid id');
      filter.patientId = query.patientId;
    }
    if (isNonEmptyString(query.doctorId)) {
      if (!mongoose.Types.ObjectId.isValid(query.doctorId)) throw badRequest('doctorId must be a valid id');
      filter.doctorId = query.doctorId;
    }
    if (isNonEmptyString(query.appointmentId)) {
      if (!mongoose.Types.ObjectId.isValid(query.appointmentId)) throw badRequest('appointmentId must be a valid id');
      filter.appointmentId = query.appointmentId;
    }
    if (isNonEmptyString(query.paymentStatus)) {
      if (!PAYMENT_STATUSES.includes(query.paymentStatus)) throw badRequest(`paymentStatus must be one of: ${PAYMENT_STATUSES.join(', ')}`);
      filter.paymentStatus = query.paymentStatus;
    }

    // Date range on invoiceDate
    if (query.dateFrom || query.dateTo) {
      filter.invoiceDate = {};
      if (query.dateFrom) {
        const d = new Date(query.dateFrom);
        if (isNaN(d.getTime())) throw badRequest('dateFrom must be a valid date');
        filter.invoiceDate.$gte = d;
      }
      if (query.dateTo) {
        const d = new Date(query.dateTo);
        if (isNaN(d.getTime())) throw badRequest('dateTo must be a valid date');
        // Include the full day by setting to end of day
        d.setHours(23, 59, 59, 999);
        filter.invoiceDate.$lte = d;
      }
    }

    // Overdue filter shortcut: status is still 'pending' but dueDate has passed
    if (query.overdue === 'true') {
      filter.paymentStatus = 'pending';
      filter.dueDate = { $lt: new Date(), $ne: null };
    }

    // Text search on invoiceNumber (exact prefix match — no full-text
    // index needed for invoice numbers, which are well-structured).
    if (isNonEmptyString(query.search)) {
      filter.invoiceNumber = { $regex: `^${query.search.trim()}`, $options: 'i' };
    }

    // Minimum amount filter (useful for large-invoice reports)
    if (query.minAmount !== undefined) {
      const min = Number(query.minAmount);
      if (!Number.isFinite(min) || min < 0) throw badRequest('minAmount must be a non-negative number');
      filter.total = { ...(filter.total || {}), $gte: min };
    }

    let sortField = 'invoiceDate';
    if (isNonEmptyString(query.sortBy)) {
      if (!BILLING_SORT_FIELDS.includes(query.sortBy)) throw badRequest(`sortBy must be one of: ${BILLING_SORT_FIELDS.join(', ')}`);
      sortField = query.sortBy;
    }
    const sortDir = query.sortOrder === 'desc' ? -1 : 1;

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .populate('patientId', 'fullName patientId phone')
        .populate('doctorId',  'fullName specialization initials avatarColor')
        .populate('appointmentId', 'appointmentDate startTime type')
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    // Annotate each invoice with a computed isOverdue flag so the
    // frontend doesn't have to re-derive it from dueDate + status.
    const now = new Date();
    const annotated = invoices.map((inv) => ({
      ...inv,
      isOverdue: inv.paymentStatus === 'pending' && inv.dueDate && new Date(inv.dueDate) < now,
    }));

    res.status(200).json({
      success: true,
      data: annotated,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 03 — INVOICE DETAIL ---- */

const getInvoice = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid invoice id');

    const invoice = await Invoice.findOne({ _id: req.params.id, clinicId: req.clinicId })
      .populate('patientId',     'fullName patientId phone email address bloodGroup')
      .populate('doctorId',      'fullName specialization qualification phone email')
      .populate('appointmentId', 'appointmentDate startTime endTime type status notes')
      .populate('createdBy',     'name email role')
      .populate('updatedBy',     'name email role')
      .lean();

    if (!invoice) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }

    // Pull clinic/settings for receipt rendering
    const settings = await Setting.findOne({ clinicId: req.clinicId })
      .select('clinicName address contactNumber email currency taxPercentage logo')
      .lean();

    const now = new Date();
    res.status(200).json({
      success: true,
      data: {
        ...invoice,
        isOverdue: invoice.paymentStatus === 'pending' && invoice.dueDate && new Date(invoice.dueDate) < now,
        clinic: settings || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 04 — UPDATE INVOICE (items, notes, dates) ---- */
// Payment status changes go through PATCH /:id/payment (Task 05)
// to keep the audit trail clean and enforce the status state machine
// independently of general field edits.
// Paid/cancelled invoices are immutable (no edits allowed).

const updateInvoice = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid invoice id');

    const existing = await Invoice.findOne({ _id: req.params.id, clinicId: req.clinicId });
    if (!existing) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }
    if (['paid', 'cancelled'].includes(existing.paymentStatus)) {
      throw badRequest(`Cannot edit an invoice that is already ${existing.paymentStatus}`);
    }

    const body = req.body || {};
    const errors = [];
    const updates = {};

    // Items — if provided, must be valid and non-empty
    let recalcTotals = false;
    if (body.items !== undefined) {
      if (!Array.isArray(body.items) || body.items.length === 0) {
        errors.push('items must be a non-empty array');
      } else {
        for (let i = 0; i < body.items.length; i++) {
          const itemError = validateItem(body.items[i], i);
          if (itemError) errors.push(itemError);
        }
        if (!errors.length) {
          updates.items = body.items.map((item) => ({
            description: String(item.description).trim(),
            quantity:    Number(item.quantity),
            price:       parseFloat(Number(item.price).toFixed(2)),
            amount:      parseFloat((Number(item.quantity) * Number(item.price)).toFixed(2)),
          }));
          recalcTotals = true;
        }
      }
    }

    if (body.invoiceDate !== undefined) {
      const d = new Date(body.invoiceDate);
      if (isNaN(d.getTime())) errors.push('invoiceDate must be a valid date');
      else updates.invoiceDate = d;
    }

    if (body.dueDate !== undefined) {
      if (body.dueDate === null) {
        updates.dueDate = null;
      } else {
        const d = new Date(body.dueDate);
        if (isNaN(d.getTime())) errors.push('dueDate must be a valid date');
        else updates.dueDate = d;
      }
    }

    if (body.notes !== undefined) {
      if (body.notes === null || body.notes === '') {
        updates.notes = '';
      } else if (typeof body.notes !== 'string') {
        errors.push('notes must be a string');
      } else if (body.notes.length > MAX_INVOICE_NOTES) {
        errors.push(`notes must be ${MAX_INVOICE_NOTES} characters or fewer`);
      } else {
        updates.notes = body.notes.trim();
      }
    }

    if (errors.length > 0) throw badRequest(errors.join('; '));
    if (Object.keys(updates).length === 0) throw badRequest('No updatable fields provided');

    if (recalcTotals) {
      const settings = await Setting.findOne({ clinicId: req.clinicId }).select('taxPercentage').lean();
      const taxPct = settings?.taxPercentage ?? 0;
      const { subtotal, tax, total } = computeInvoiceTotals(updates.items, taxPct);
      updates.subtotal = subtotal;
      updates.tax      = tax;
      updates.total    = total;
    }

    updates.updatedBy = req.user.userId;

    const updated = await Invoice.findByIdAndUpdate(
      existing._id,
      { $set: updates },
      { new: true, runValidators: true }
    )
      .populate('patientId', 'fullName patientId')
      .populate('doctorId',  'fullName specialization')
      .lean();

    await AuditLog.create({
      clinicId:   req.clinicId,
      userId:     req.user.userId,
      action:     'INVOICE_UPDATED',
      entityType: 'Invoice',
      entityId:   existing._id,
      ipAddress:  req.ip,
      userAgent:  req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 05 — UPDATE PAYMENT STATUS ---- */
// Dedicated PATCH endpoint. Enforces a state machine:
//   pending  → paid | overdue | cancelled
//   overdue  → paid | cancelled
//   paid     → (locked — no transitions)
//   cancelled→ (locked — no transitions)
// Reactivating a cancelled invoice requires a new invoice (by design).

const PAYMENT_TRANSITIONS = {
  pending:   ['paid', 'overdue', 'cancelled'],
  overdue:   ['paid', 'cancelled'],
  paid:      [],
  cancelled: [],
};

const updatePaymentStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid invoice id');

    const invoice = await Invoice.findOne({ _id: req.params.id, clinicId: req.clinicId });
    if (!invoice) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }

    const body = req.body || {};
    const errors = [];

    if (!body.paymentStatus || !PAYMENT_STATUSES.includes(body.paymentStatus)) {
      errors.push(`paymentStatus must be one of: ${PAYMENT_STATUSES.join(', ')}`);
    } else {
      const allowed = PAYMENT_TRANSITIONS[invoice.paymentStatus] || [];
      if (!allowed.includes(body.paymentStatus)) {
        errors.push(
          `Cannot transition from '${invoice.paymentStatus}' to '${body.paymentStatus}'. ` +
          `Allowed transitions: ${allowed.length ? allowed.join(', ') : 'none'}`
        );
      }
    }

    if (body.paymentMethod !== undefined && !PAYMENT_METHODS.includes(body.paymentMethod)) {
      errors.push(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }

    if (errors.length > 0) throw badRequest(errors.join('; '));

    const updates = {
      paymentStatus: body.paymentStatus,
      updatedBy: req.user.userId,
    };

    if (body.paymentStatus === 'paid') {
      updates.paidAt = new Date();
      if (body.paymentMethod) updates.paymentMethod = body.paymentMethod;
    }

    const updated = await Invoice.findByIdAndUpdate(
      invoice._id,
      { $set: updates },
      { new: true, runValidators: true }
    )
      .populate('patientId', 'fullName patientId')
      .lean();

    await AuditLog.create({
      clinicId:   req.clinicId,
      userId:     req.user.userId,
      action:     'INVOICE_PAYMENT_UPDATED',
      entityType: 'Invoice',
      entityId:   invoice._id,
      ipAddress:  req.ip,
      userAgent:  req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 06 — CANCEL INVOICE ---- */
// Dedicated DELETE-style endpoint using PATCH semantics: invoices are
// soft-cancelled, never hard-deleted. Financial records must be
// auditable — a hard DELETE would break the revenue history.
// Only clinic_admin and billing_staff can cancel; receptionist cannot.

const cancelInvoice = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid invoice id');

    const invoice = await Invoice.findOne({ _id: req.params.id, clinicId: req.clinicId });
    if (!invoice) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }
    if (invoice.paymentStatus === 'cancelled') throw badRequest('Invoice is already cancelled');
    if (invoice.paymentStatus === 'paid')      throw badRequest('Cannot cancel a paid invoice. Issue a credit note instead.');

    await Invoice.findByIdAndUpdate(invoice._id, {
      $set: { paymentStatus: 'cancelled', updatedBy: req.user.userId },
    });

    // Decrement patient counter (best-effort, same fire-and-forget
    // pattern used on create — a failed counter is non-critical)
    Patient.findByIdAndUpdate(invoice.patientId, {
      $inc: { totalInvoices: -1 },
    }).catch((err) => console.error('Patient invoice counter decrement failed:', err.message));

    await AuditLog.create({
      clinicId:   req.clinicId,
      userId:     req.user.userId,
      action:     'INVOICE_CANCELLED',
      entityType: 'Invoice',
      entityId:   invoice._id,
      ipAddress:  req.ip,
      userAgent:  req.headers['user-agent'],
    });

    res.status(200).json({ success: true, message: 'Invoice cancelled successfully' });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 07 — PATIENT BILLING HISTORY ---- */
// Returns all non-cancelled invoices for a patient, sorted newest
// first, with a running total. Used by the patient profile view
// to display billing history without loading the full invoice list.

const getPatientBillingHistory = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.patientId)) throw badRequest('Invalid patient id');

    // Verify patient belongs to this clinic (tenant isolation)
    const patient = await Patient.findOne({ _id: req.params.patientId, clinicId: req.clinicId })
      .select('_id fullName patientId totalInvoices lastInvoiceAt')
      .lean();
    if (!patient) {
      const error = new Error('Patient not found');
      error.statusCode = 404;
      throw error;
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip  = (page - 1) * limit;

    const filter = {
      clinicId:  req.clinicId,
      patientId: patient._id,
      paymentStatus: { $ne: 'cancelled' },
    };

    const [invoices, total, totals] = await Promise.all([
      Invoice.find(filter)
        .populate('doctorId',      'fullName specialization')
        .populate('appointmentId', 'appointmentDate type')
        .sort({ invoiceDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(filter),
      Invoice.aggregate([
        { $match: { clinicId: new mongoose.Types.ObjectId(req.clinicId), patientId: patient._id, paymentStatus: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: null,
            lifetimeTotal:   { $sum: '$total' },
            lifetimePaid:    { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } },
            lifetimePending: { $sum: { $cond: [{ $ne:  ['$paymentStatus', 'paid'] }, '$total', 0] } },
          },
        },
      ]),
    ]);

    const summary = totals[0] || { lifetimeTotal: 0, lifetimePaid: 0, lifetimePending: 0 };

    res.status(200).json({
      success: true,
      data: {
        patient,
        invoices,
        summary: {
          lifetimeTotal:   parseFloat(summary.lifetimeTotal.toFixed(2)),
          lifetimePaid:    parseFloat(summary.lifetimePaid.toFixed(2)),
          lifetimePending: parseFloat(summary.lifetimePending.toFixed(2)),
        },
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 08 — REVENUE SUMMARY ---- */
// Single-endpoint aggregation for the dashboard revenue widget and
// the Billing page KPI strip. Returns:
//   today/month/year revenue + outstanding + overdue
//   + by-status breakdown + top doctors by revenue
// All figures are for non-cancelled invoices only.
// Query params: month=YYYY-MM (defaults to current), year=YYYY.

const getBillingSummary = async (req, res, next) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year,  10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    if (month < 1 || month > 12) throw badRequest('month must be between 1 and 12');
    if (year < 2000 || year > 2100) throw badRequest('year out of range');

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd   = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd   = new Date(year, month, 1);
    const yearStart  = new Date(year, 0, 1);
    const yearEnd    = new Date(year + 1, 0, 1);

    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const baseMatch = { clinicId: cid, paymentStatus: { $ne: 'cancelled' } };

    const [
      todayAgg,
      monthAgg,
      yearAgg,
      statusBreakdown,
      overdueCount,
      overdueAmount,
      topDoctors,
    ] = await Promise.all([
      // Today's collection
      Invoice.aggregate([
        { $match: { ...baseMatch, invoiceDate: { $gte: todayStart, $lt: todayEnd } } },
        { $group: { _id: null, collected: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } }, invoiced: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),

      // Selected month
      Invoice.aggregate([
        { $match: { ...baseMatch, invoiceDate: { $gte: monthStart, $lt: monthEnd } } },
        { $group: { _id: null, collected: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } }, invoiced: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),

      // Selected year
      Invoice.aggregate([
        { $match: { ...baseMatch, invoiceDate: { $gte: yearStart, $lt: yearEnd } } },
        { $group: { _id: null, collected: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } }, invoiced: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),

      // By-status breakdown for selected month
      Invoice.aggregate([
        { $match: { clinicId: cid, invoiceDate: { $gte: monthStart, $lt: monthEnd } } },
        { $group: { _id: '$paymentStatus', count: { $sum: 1 }, amount: { $sum: '$total' } } },
      ]),

      // Overdue count (pending + dueDate passed)
      Invoice.countDocuments({
        clinicId: req.clinicId,
        paymentStatus: 'pending',
        dueDate: { $lt: now, $ne: null },
      }),

      // Overdue amount
      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: 'pending', dueDate: { $lt: now, $ne: null } } },
        { $group: { _id: null, amount: { $sum: '$total' } } },
      ]),

      // Top 5 doctors by revenue this month
      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: 'paid', invoiceDate: { $gte: monthStart, $lt: monthEnd }, doctorId: { $ne: null } } },
        { $group: { _id: '$doctorId', revenue: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'doctors', localField: '_id', foreignField: '_id', as: 'doctor' } },
        { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, revenue: 1, count: 1, 'doctor.fullName': 1, 'doctor.specialization': 1, 'doctor.initials': 1, 'doctor.avatarColor': 1 } },
      ]),
    ]);

    const fix2 = (n) => parseFloat((n || 0).toFixed(2));
    const today  = todayAgg[0]  || { collected: 0, invoiced: 0, count: 0 };
    const mth    = monthAgg[0]  || { collected: 0, invoiced: 0, count: 0 };
    const yr     = yearAgg[0]   || { collected: 0, invoiced: 0, count: 0 };
    const ovdAmt = overdueAmount[0]?.amount || 0;

    // Build status breakdown map
    const statusMap = {};
    for (const row of statusBreakdown) {
      statusMap[row._id] = { count: row.count, amount: fix2(row.amount) };
    }

    res.status(200).json({
      success: true,
      data: {
        period: { year, month },
        today: {
          collected: fix2(today.collected),
          invoiced:  fix2(today.invoiced),
          count:     today.count,
        },
        month: {
          collected: fix2(mth.collected),
          invoiced:  fix2(mth.invoiced),
          count:     mth.count,
          pending:   fix2((mth.invoiced || 0) - (mth.collected || 0)),
        },
        year: {
          collected: fix2(yr.collected),
          invoiced:  fix2(yr.invoiced),
          count:     yr.count,
        },
        overdue: {
          count:  overdueCount,
          amount: fix2(ovdAmt),
        },
        statusBreakdown: statusMap,
        topDoctors,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---- Task 09 — APPOINTMENT-TO-INVOICE WORKFLOW ---- */
// Convenience endpoint: GET /api/billing/from-appointment/:appointmentId
// Returns a prefilled invoice draft (not persisted) ready for the
// frontend to confirm and POST to /api/billing. The doctor's
// consultationFee seeds the first line item. This is the core of the
// appointment → billing handoff.

const getInvoiceDraftFromAppointment = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.appointmentId)) throw badRequest('Invalid appointment id');

    const appointment = await Appointment.findOne({
      _id: req.params.appointmentId,
      clinicId: req.clinicId,
    })
      .populate('patientId', 'fullName patientId phone email')
      .populate('doctorId',  'fullName specialization consultationFee initials avatarColor')
      .lean();

    if (!appointment) {
      const error = new Error('Appointment not found');
      error.statusCode = 404;
      throw error;
    }

    // Check if an invoice already exists for this appointment
    const existingInvoice = await Invoice.findOne({
      clinicId: req.clinicId,
      appointmentId: appointment._id,
    }).select('_id invoiceNumber paymentStatus').lean();

    const settings = await Setting.findOne({ clinicId: req.clinicId })
      .select('taxPercentage currency clinicName')
      .lean();
    const taxPct = settings?.taxPercentage ?? 0;

    // Seed items from doctor's consultation fee
    const fee = appointment.doctorId?.consultationFee || 0;
    const draftItems = fee > 0
      ? [{ description: `${appointment.type || 'Consultation'} — ${appointment.doctorId?.fullName || 'Doctor'}`, quantity: 1, price: fee, amount: fee }]
      : [];

    const { subtotal, tax, total } = computeInvoiceTotals(draftItems, taxPct);

    // Due date defaults to invoice date + 7 days
    const today = new Date();
    const dueDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    res.status(200).json({
      success: true,
      data: {
        draft: {
          appointmentId: appointment._id,
          patientId:     appointment.patientId?._id,
          doctorId:      appointment.doctorId?._id,
          invoiceDate:   today.toISOString().slice(0, 10),
          dueDate:       dueDate.toISOString().slice(0, 10),
          items:         draftItems,
          subtotal,
          tax,
          total,
          paymentStatus: 'pending',
          taxPercentage: taxPct,
        },
        appointment,
        existingInvoice: existingInvoice || null,
        clinic: settings || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---- Billing Router ---- */

const billingRouter = express.Router();

// All billing routes require authentication + tenant scope
billingRouter.use(authenticate, tenantScope, requireClinicContext);

// Invoice CRUD
billingRouter.post(
  '/',
  requirePermission('billing', 'create'),
  createInvoice
);

billingRouter.get(
  '/',
  requirePermission('billing', 'view'),
  listInvoices
);

billingRouter.get(
  '/summary',
  requirePermission('billing', 'view'),
  getBillingSummary
);

// Appointment-to-invoice draft — must come before /:id routes
billingRouter.get(
  '/from-appointment/:appointmentId',
  requirePermission('billing', 'view'),
  getInvoiceDraftFromAppointment
);

// Patient billing history
billingRouter.get(
  '/patient/:patientId',
  requirePermission('billing', 'view'),
  getPatientBillingHistory
);

billingRouter.get(
  '/:id',
  requirePermission('billing', 'view'),
  getInvoice
);

billingRouter.put(
  '/:id',
  requirePermission('billing', 'edit'),
  updateInvoice
);

billingRouter.patch(
  '/:id/payment',
  requirePermission('billing', 'manage'),
  updatePaymentStatus
);

billingRouter.patch(
  '/:id/cancel',
  requirePermission('billing', 'manage'),
  cancelInvoice
);

app.use('/api/billing', billingRouter);

/* ============================================================
   4K. REPORTS & ANALYTICS ENGINE (Phase 11.0)
   Management-level insights layer over the existing Patient,
   Doctor, Appointment, and Invoice collections. No new
   collections, no service/repository layer — same "inlined,
   lightweight" convention as every prior module.

   This module is READ-ONLY. It answers questions; it never
   writes business data. Consistent with Dashboard (4I), no
   audit log entries are written here (audit logs record
   mutations, not reads).

   Tenant isolation: every aggregation below starts with
   { clinicId: req.clinicId } as the FIRST stage, sourced only
   from tenantScope() (Critical Security Rule — identical posture
   to every module above). super_admin is blocked by
   requireClinicContext, same as Clinic/Settings/Patients/Doctors/
   Appointments/Dashboard/Billing — a cross-clinic rollup is a
   deliberately separate, future "Franchise Analytics" surface
   (see Recommendations), never an accidental side effect of a
   missing filter here.

   RBAC matrix (financial reports are tighter than operational
   reports — same instinct as Billing's matrix in 4J):
     clinic_admin   — full access to every report
     billing_staff  — revenue, payments, outstanding (their domain)
     receptionist   — appointments, patient growth (operational only)
     doctor         — appointments (their own context, read-only)
   Doctor performance & business-health overview are clinic_admin
   only — they rank/compare staff and surface clinic-wide P&L,
   neither of which belongs to a non-admin role.

   Aggregation strategy:
   — Every report is a single aggregation pipeline (occasionally
     2-3 run in parallel via Promise.all, mirroring the Dashboard
     and Billing-Summary pattern) — no N+1 queries, no in-app
     joins where Mongo can do it in one $lookup.
   — Trend buckets (daily/weekly/monthly/yearly) are produced with
     $dateToString / $isoWeek inside $group — bucketing happens in
     the DB, never by looping result sets in Node.
   — All reports reuse EXISTING indexes:
       Invoice:      {clinicId,invoiceDate,paymentStatus}, {clinicId,paymentStatus},
                     {clinicId,dueDate}, {clinicId,doctorId}
       Appointment:  {clinicId,appointmentDate}, {clinicId,doctorId,appointmentDate},
                     {clinicId,status}
       Patient:      {clinicId,isActive}, {clinicId,fullName}
       Doctor:       {clinicId,isActive}, {clinicId,specialization}
     No new indexes are required for Phase 11.0 at clinic scale;
     see Performance Observations in the Phase 11.0 report for the
     one index this module WOULD need once multi-branch ships.
   ============================================================ */

/* ---------- shared report helpers ---------- */

const REPORT_PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];

// Returns the $dateToString format (or $isoWeek-based grouping key)
// used to bucket a date field for a given period. Used identically
// across revenue/appointments/patient-growth trend pipelines so all
// three "speak the same calendar" and can be correlated on a chart.
const bucketGroupId = (field, period) => {
  switch (period) {
    case 'daily':
      return { $dateToString: { format: '%Y-%m-%d', date: field } };
    case 'weekly':
      // ISO week-year + zero-padded ISO week number, e.g. "2026-W25".
      // Using isoWeekYear (not plain $year) avoids the Dec/Jan
      // boundary bug where the last days of December can belong to
      // ISO week 1 of the following year.
      return {
        $concat: [
          { $toString: { $isoWeekYear: field } },
          '-W',
          {
            $cond: [
              { $lt: [{ $isoWeek: field }, 10] },
              { $concat: ['0', { $toString: { $isoWeek: field } }] },
              { $toString: { $isoWeek: field } },
            ],
          },
        ],
      };
    case 'yearly':
      return { $dateToString: { format: '%Y', date: field } };
    case 'monthly':
    default:
      return { $dateToString: { format: '%Y-%m', date: field } };
  }
};

// Validates & normalizes the shared ?period=&from=&to= query params
// used by every trend endpoint below. Defaults to monthly buckets
// over the trailing 12 months when no explicit range is given —
// the same "last 12 months" default the Reports UI already charts
// (reports.js initRevenueAnalytics/initPatientGrowth mocks).
const parseReportRange = (query) => {
  const period = REPORT_PERIODS.includes(query.period) ? query.period : 'monthly';

  let from, to;
  if (query.from) {
    from = new Date(query.from);
    if (isNaN(from.getTime())) throw badRequest('from must be a valid date');
  }
  if (query.to) {
    to = new Date(query.to);
    if (isNaN(to.getTime())) throw badRequest('to must be a valid date');
  }
  if (from && to && from > to) throw badRequest('from must be before to');

  if (!from || !to) {
    const now = new Date();
    const defaultSpanDays = { daily: 30, weekly: 90, monthly: 365, yearly: 365 * 5 }[period];
    to = to || now;
    from = from || new Date(to.getTime() - defaultSpanDays * 24 * 60 * 60 * 1000);
  }

  return { period, from, to };
};

const fix2 = (n) => parseFloat((n || 0).toFixed(2));

/* ---------- Report 01 — REVENUE ANALYTICS ---------- */
// GET /api/reports/revenue?period=monthly&from=&to=
// Trend of collected vs invoiced revenue, plus revenue by doctor
// and by department (specialization) for the same window. This is
// the same paid-vs-invoiced shape getBillingSummary already uses
// (4J Task 08), generalized to an arbitrary range/granularity
// instead of "today/this month/this year" only.

const getRevenueReport = async (req, res, next) => {
  try {
    // Phase 14.8 — Visibility Engine integration. Revenue is a
    // financial report: per VISIBILITY_MATRIX, only clinic_admin
    // (FULL_CLINIC) and billing_staff (FINANCIAL) may see it at all.
    // A doctor's "own revenue" is explicitly conditional in the spec
    // ("if clinic configuration allows") and no such per-clinic toggle
    // exists in this schema yet, so doctor stays denied here rather
    // than guessing a default; receptionist is denied per spec
    // ("Must NEVER view: Revenue"). Both already reach this handler
    // today via reports.view — gate is enforced here, not by loosening
    // or tightening requirePermission (Permission Engine untouched).
    const visibility = visibilityEngine.getReportVisibility(req.user, 'reports');
    const canSeeRevenue = visibility === visibilityEngine.SCOPE_KINDS.FULL_CLINIC
      || visibility === visibilityEngine.SCOPE_KINDS.FINANCIAL;
    if (!canSeeRevenue) {
      const error = new Error('You do not have access to revenue analytics');
      error.statusCode = 403;
      throw error;
    }

    const { period, from, to } = parseReportRange(req.query);
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinicId: cid, invoiceDate: { $gte: from, $lte: to } };

    const [trend, byDoctor, byDepartment, totals] = await Promise.all([
      // Trend: collected vs invoiced per bucket
      Invoice.aggregate([
        { $match: match },
        {
          $group: {
            _id: bucketGroupId('$invoiceDate', period),
            invoiced: { $sum: '$total' },
            collected: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Revenue by doctor (paid only — "revenue" means money actually collected)
      Invoice.aggregate([
        { $match: { ...match, paymentStatus: 'paid', doctorId: { $ne: null } } },
        { $group: { _id: '$doctorId', revenue: { $sum: '$total' }, invoiceCount: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'doctors', localField: '_id', foreignField: '_id', as: 'doctor' } },
        { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, revenue: 1, invoiceCount: 1, 'doctor.fullName': 1, 'doctor.specialization': 1, 'doctor.initials': 1, 'doctor.avatarColor': 1 } },
      ]),

      // Revenue by department/specialization — same paid invoices,
      // grouped through the doctor's specialization instead of doctorId.
      // uniquePatients/patientCount added for Phase R2 (Top Departments
      // needs a per-department patient count — same $addToSet + $size
      // pattern already used in getDoctorPerformanceReport above).
      Invoice.aggregate([
        { $match: { ...match, paymentStatus: 'paid', doctorId: { $ne: null } } },
        { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doctor' } },
        { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $ifNull: ['$doctor.specialization', 'Unassigned'] },
            revenue: { $sum: '$total' },
            invoiceCount: { $sum: 1 },
            uniquePatients: { $addToSet: '$patientId' },
          },
        },
        { $project: { revenue: 1, invoiceCount: 1, patientCount: { $size: '$uniquePatients' } } },
        { $sort: { revenue: -1 } },
      ]),

      // Window totals + collection rate
      Invoice.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            invoiced: { $sum: '$total' },
            collected: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } },
            tax: { $sum: '$tax' },
            discount: { $sum: '$discount' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const t = totals[0] || { invoiced: 0, collected: 0, tax: 0, discount: 0, count: 0 };

    res.status(200).json({
      success: true,
      data: {
        period,
        range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        trend: trend.map((row) => ({
          bucket: row._id,
          invoiced: fix2(row.invoiced),
          collected: fix2(row.collected),
          collectionRate: row.invoiced ? fix2((row.collected / row.invoiced) * 100) : 0,
          invoiceCount: row.count,
        })),
        totals: {
          invoiced: fix2(t.invoiced),
          collected: fix2(t.collected),
          tax: fix2(t.tax),
          discount: fix2(t.discount),
          collectionRate: t.invoiced ? fix2((t.collected / t.invoiced) * 100) : 0,
          invoiceCount: t.count,
        },
        byDoctor,
        byDepartment: byDepartment.map((row) => ({ specialization: row._id, revenue: fix2(row.revenue), invoiceCount: row.invoiceCount, patientCount: row.patientCount })),
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Report 02 — APPOINTMENT ANALYTICS ---------- */
// GET /api/reports/appointments?period=monthly&from=&to=
// Volume trend, status breakdown, per-doctor load, and the
// completion/no-show/cancellation rates clinic owners use to
// judge scheduling health.

const getAppointmentsReport = async (req, res, next) => {
  try {
    // Phase 14.8 — Visibility Engine integration. Appointment
    // analytics: admin (FULL_CLINIC) and receptionist (OPERATIONAL)
    // see clinic-wide; doctor (OWN_DATA) sees only their own load;
    // billing_staff (NONE — "cannot view clinical records not
    // required for billing") is denied outright.
    const visibility = visibilityEngine.getReportVisibility(req.user, 'reports');
    if (visibility === visibilityEngine.SCOPE_KINDS.NONE) {
      const error = new Error('You do not have access to appointment analytics');
      error.statusCode = 403;
      throw error;
    }

    const { period, from, to } = parseReportRange(req.query);
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinicId: cid, appointmentDate: { $gte: from, $lte: to } };
    // Doctor scope: same doctorId field appointments already carries
    // (no join needed, unlike patients) — buildMongoFilter's flat
    // { doctorId } filter ANDs straight into every aggregate's $match.
    if (visibility === visibilityEngine.SCOPE_KINDS.OWN_DATA) {
      if (!req.user.doctorId) {
        const error = new Error('You do not have access to appointment analytics');
        error.statusCode = 403;
        throw error;
      }
      match.doctorId = new mongoose.Types.ObjectId(req.user.doctorId);
    }

    const [trend, byStatus, byDoctor, byDepartment] = await Promise.all([
      Appointment.aggregate([
        { $match: match },
        { $group: { _id: bucketGroupId('$appointmentDate', period), count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      Appointment.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      Appointment.aggregate([
        { $match: match },
        { $group: { _id: '$doctorId', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }, cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'doctors', localField: '_id', foreignField: '_id', as: 'doctor' } },
        { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, total: 1, completed: 1, cancelled: 1, 'doctor.fullName': 1, 'doctor.specialization': 1, 'doctor.initials': 1, 'doctor.avatarColor': 1 } },
      ]),

      Appointment.aggregate([
        { $match: match },
        { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doctor' } },
        { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $ifNull: ['$doctor.specialization', 'Unassigned'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const statusMap = {};
    let totalAppts = 0;
    for (const row of byStatus) {
      statusMap[row._id] = row.count;
      totalAppts += row.count;
    }
    const completed = statusMap.completed || 0;
    const cancelled = statusMap.cancelled || 0;
    const noShow = statusMap.no_show || 0;

    res.status(200).json({
      success: true,
      data: {
        period,
        range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        trend: trend.map((row) => ({ bucket: row._id, count: row.count })),
        totals: {
          total: totalAppts,
          completed,
          cancelled,
          noShow,
          completionRate: totalAppts ? fix2((completed / totalAppts) * 100) : 0,
          cancellationRate: totalAppts ? fix2((cancelled / totalAppts) * 100) : 0,
          noShowRate: totalAppts ? fix2((noShow / totalAppts) * 100) : 0,
        },
        byStatus: statusMap,
        byDoctor,
        byDepartment: byDepartment.map((row) => ({ specialization: row._id, count: row.count })),
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Report 03 — PATIENT GROWTH ANALYTICS ---------- */
// GET /api/reports/patients/growth?period=monthly&from=&to=
// New-patient trend (by Patient.createdAt), acquisition source
// breakdown, and a returning-vs-new split for the window derived
// from Appointment history (a patient with >1 appointment overall
// counts as "returning" the moment their 2nd+ visit falls in range).

const getPatientGrowthReport = async (req, res, next) => {
  try {
    // Phase 14.8 — Visibility Engine integration. Patient growth is
    // an operational/clinical report: admin (FULL_CLINIC) and
    // receptionist (OPERATIONAL — "patient flow") see clinic-wide;
    // doctor (OWN_DATA) sees only their own patients' growth/mix;
    // billing_staff (NONE) is denied — their patient-facing view is
    // billing-related fields only, which this trend report doesn't
    // provide (see Billing module instead, per Phase 14.5 notes).
    const visibility = visibilityEngine.getReportVisibility(req.user, 'reports');
    if (visibility === visibilityEngine.SCOPE_KINDS.NONE) {
      const error = new Error('You do not have access to patient growth analytics');
      error.statusCode = 403;
      throw error;
    }

    const { period, from, to } = parseReportRange(req.query);
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinicId: cid, createdAt: { $gte: from, $lte: to } };
    const activeMatch = { clinicId: cid };
    const apptMatch = { clinicId: cid, appointmentDate: { $gte: from, $lte: to } };

    // Doctor scope: Patient has no doctorId field, so "own patients"
    // requires the Appointment-join lookup (same abstraction used by
    // the Patient module, Phase 14.5) — reused here rather than
    // re-deriving the join. Appointment-side aggregates take the flat
    // { doctorId } filter directly, no join needed there.
    if (visibility === visibilityEngine.SCOPE_KINDS.OWN_DATA) {
      if (!req.user.doctorId) {
        const error = new Error('You do not have access to patient growth analytics');
        error.statusCode = 403;
        throw error;
      }
      const patientFilter = await visibilityEngine.getVisiblePatients(req.user, { Appointment });
      if (visibilityEngine.isDenied(patientFilter)) {
        const error = new Error('You do not have access to patient growth analytics');
        error.statusCode = 403;
        throw error;
      }
      Object.assign(match, patientFilter);
      Object.assign(activeMatch, patientFilter);
      apptMatch.doctorId = new mongoose.Types.ObjectId(req.user.doctorId);
    }

    const [trend, bySource, activeVsInactive, visitMix] = await Promise.all([
      Patient.aggregate([
        { $match: match },
        { $group: { _id: bucketGroupId('$createdAt', period), count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      Patient.aggregate([
        { $match: match },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      Patient.aggregate([
        { $match: activeMatch },
        { $group: { _id: '$isActive', count: { $sum: 1 } } },
      ]),

      // New vs returning, based on appointment occurrence within range:
      // for each appointment in the window, was it that patient's
      // first-ever appointment (new) or a later one (returning)?
      Appointment.aggregate([
        { $match: apptMatch },
        { $sort: { patientId: 1, appointmentDate: 1 } },
        { $group: { _id: '$patientId', firstInRange: { $first: '$appointmentDate' }, visitsInRange: { $sum: 1 } } },
        {
          $lookup: {
            from: 'appointments',
            let: { pid: '$_id', first: '$firstInRange' },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ['$patientId', '$$pid'] }, { $eq: ['$clinicId', cid] }, { $lt: ['$appointmentDate', '$$first'] }] } } },
              { $limit: 1 },
            ],
            as: 'priorVisit',
          },
        },
        { $group: { _id: { $cond: [{ $gt: [{ $size: '$priorVisit' }, 0] }, 'returning', 'new'] }, patients: { $sum: 1 }, visits: { $sum: '$visitsInRange' } } },
      ]),
    ]);

    const activeMap = { active: 0, inactive: 0 };
    for (const row of activeVsInactive) activeMap[row._id ? 'active' : 'inactive'] = row.count;

    const mix = { new: { patients: 0, visits: 0 }, returning: { patients: 0, visits: 0 } };
    for (const row of visitMix) mix[row._id] = { patients: row.patients, visits: row.visits };

    res.status(200).json({
      success: true,
      data: {
        period,
        range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        trend: trend.map((row) => ({ bucket: row._id, newPatients: row.count })),
        bySource: bySource.map((row) => ({ source: row._id, count: row.count })),
        activeVsInactive: activeMap,
        visitMix: mix,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Report 04 — DOCTOR PERFORMANCE ANALYTICS ---------- */
// GET /api/reports/doctors/performance?from=&to=
// clinic_admin only. Per-doctor patients seen, appointment outcomes,
// and revenue generated for the window — the ranked staff table the
// Reports UI mock (reports.js PERF_DATA) already renders, now backed
// by real aggregation instead of static fixtures.
//
// NOTE: the existing doctorSchema (section 1C) has no `rating` field.
// The frontend mock displays a star rating that does not exist
// anywhere in the backend. This report intentionally omits rating
// rather than fabricate one — see Risks Found in the Phase 11.0
// report for the recommended fix (patient-feedback collection).

const getDoctorPerformanceReport = async (req, res, next) => {
  try {
    // Phase 14.8 — Visibility Engine integration. Uses the
    // purpose-built getDoctorPerformanceVisibility() (Phase 14.2
    // Goal 7) rather than the generic reports scope: admin/
    // receptionist get the aggregate roster (OPERATIONAL — "doctor
    // schedules" visibility, not a privacy concern the way raw
    // patient data is), a doctor is restricted to their own row
    // only, and billing_staff is denied ("cannot view doctor
    // productivity"). This also loosens the route's permission gate
    // from reports.manage to reports.view (see route registration
    // below) so a doctor can reach this handler at all — the
    // Permission Engine's matrix itself is untouched; only which
    // action this specific route checks changes, same pattern as
    // every other reports.view endpoint.
    const docPerfVisibility = visibilityEngine.getDoctorPerformanceVisibility(req.user);
    if (docPerfVisibility.scope === visibilityEngine.SCOPE_KINDS.NONE) {
      const error = new Error('You do not have access to doctor performance analytics');
      error.statusCode = 403;
      throw error;
    }

    // Phase 14.8 spec: "Doctor Performance -> Reception: Hidden" —
    // this is a narrower rule than getDoctorPerformanceVisibility()
    // itself grants (that helper, from Phase 14.2, gives receptionist
    // OPERATIONAL access citing an earlier "doctor schedules"
    // allowance). visibilityEngine.js is a protected dependency this
    // phase must not modify, so the stricter, more specific Phase
    // 14.8 rule is enforced here at the call site instead of loosening
    // the shared helper for every future caller. If a future phase
    // needs receptionist to see this report again, that's a decision
    // for a dedicated spec revision, not a silent reversion here.
    if (req.user && req.user.role === 'receptionist') {
      const error = new Error('You do not have access to doctor performance analytics');
      error.statusCode = 403;
      throw error;
    }

    const { from, to } = parseReportRange({ ...req.query, period: 'monthly' });
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    // mongoFilter is {} for OPERATIONAL (admin/receptionist) or
    // { doctorId: <id> } for a self-restricted doctor — ANDed into
    // every query below, including the Doctor.find roster itself so
    // a doctor's response contains only their own profile row, not
    // the full staff list with everyone else zeroed out.
    const doctorScopeFilter = docPerfVisibility.mongoFilter;

    const [apptStats, revenueStats, doctors] = await Promise.all([
      Appointment.aggregate([
        { $match: { clinicId: cid, appointmentDate: { $gte: from, $lte: to }, ...doctorScopeFilter } },
        {
          $group: {
            _id: '$doctorId',
            totalAppointments: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } },
            uniquePatients: { $addToSet: '$patientId' },
          },
        },
        { $project: { totalAppointments: 1, completed: 1, cancelled: 1, noShow: 1, patientCount: { $size: '$uniquePatients' } } },
      ]),

      // Revenue-by-doctor is financial data — per spec a doctor's
      // "own revenue" is only shown "if clinic configuration allows"
      // (no such toggle exists yet, see getRevenueReport note), so
      // this stays admin/receptionist-visible only; a self-restricted
      // doctor gets an empty revenue map and every row's revenue
      // below correctly falls back to 0 rather than exposing it.
      docPerfVisibility.restrictedToSelf
        ? Promise.resolve([])
        : Invoice.aggregate([
            { $match: { clinicId: cid, invoiceDate: { $gte: from, $lte: to }, paymentStatus: 'paid', doctorId: { $ne: null } } },
            { $group: { _id: '$doctorId', revenue: { $sum: '$total' } } },
          ]),

      Doctor.find({ clinicId: cid, ...doctorScopeFilter }).select('fullName specialization initials avatarColor isActive').lean(),
    ]);

    const apptMap = {};
    for (const row of apptStats) apptMap[String(row._id)] = row;
    const revMap = {};
    for (const row of revenueStats) revMap[String(row._id)] = row.revenue;

    const table = doctors
      .map((d) => {
        const a = apptMap[String(d._id)] || { totalAppointments: 0, completed: 0, cancelled: 0, noShow: 0, patientCount: 0 };
        return {
          doctorId: d._id,
          fullName: d.fullName,
          specialization: d.specialization,
          initials: d.initials,
          avatarColor: d.avatarColor,
          isActive: d.isActive,
          patients: a.patientCount,
          appointments: a.totalAppointments,
          completed: a.completed,
          cancelled: a.cancelled,
          noShow: a.noShow,
          completionRate: a.totalAppointments ? fix2((a.completed / a.totalAppointments) * 100) : 0,
          revenue: fix2(revMap[String(d._id)] || 0),
        };
      })
      .sort((x, y) => y.revenue - x.revenue);

    res.status(200).json({
      success: true,
      data: {
        range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        doctors: table,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Report 05 — PAYMENT ANALYTICS ---------- */
// GET /api/reports/payments?period=monthly&from=&to=
// Payment-method mix and collection efficiency for the window —
// answers "how are patients actually paying us" (billing.html's
// Payment Methods card mock, now real).

const getPaymentsReport = async (req, res, next) => {
  try {
    // Phase 14.8 — payment-method analytics is pure financial data:
    // only clinic_admin (FULL_CLINIC) and billing_staff (FINANCIAL)
    // per spec ("Billing: Payment methods... Doctor/Reception: Must
    // NEVER view Revenue/Financial reports"). Same gate as
    // getRevenueReport — no per-doctor breakdown exists in this
    // report to further scope, so it's clinic-wide-or-nothing.
    const visibility = visibilityEngine.getReportVisibility(req.user, 'reports');
    const canSeeFinancial = visibility === visibilityEngine.SCOPE_KINDS.FULL_CLINIC
      || visibility === visibilityEngine.SCOPE_KINDS.FINANCIAL;
    if (!canSeeFinancial) {
      const error = new Error('You do not have access to payment analytics');
      error.statusCode = 403;
      throw error;
    }

    const { period, from, to } = parseReportRange(req.query);
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinicId: cid, invoiceDate: { $gte: from, $lte: to }, paymentStatus: 'paid' };

    const [byMethod, trend] = await Promise.all([
      Invoice.aggregate([
        { $match: match },
        { $group: { _id: { $ifNull: ['$paymentMethod', 'unspecified'] }, amount: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } },
      ]),

      Invoice.aggregate([
        { $match: match },
        { $group: { _id: bucketGroupId('$invoiceDate', period), amount: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const totalCollected = byMethod.reduce((sum, row) => sum + row.amount, 0);

    res.status(200).json({
      success: true,
      data: {
        period,
        range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        byMethod: byMethod.map((row) => ({
          method: row._id,
          amount: fix2(row.amount),
          count: row.count,
          share: totalCollected ? fix2((row.amount / totalCollected) * 100) : 0,
        })),
        trend: trend.map((row) => ({ bucket: row._id, amount: fix2(row.amount), count: row.count })),
        totalCollected: fix2(totalCollected),
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Report 06 — OUTSTANDING INVOICE ANALYTICS ---------- */
// GET /api/reports/outstanding
// Aging breakdown of everything not yet collected (pending +
// overdue) — the AR-aging view clinic owners use to chase
// collections, and the data WhatsApp payment reminders (Recom-
// mendations) will eventually run against.

const AGING_BUCKETS = [
  { label: '0-7 days', min: 0, max: 7 },
  { label: '8-15 days', min: 8, max: 15 },
  { label: '16-30 days', min: 16, max: 30 },
  { label: '31+ days', min: 31, max: Infinity },
];

const getOutstandingReport = async (req, res, next) => {
  try {
    // Phase 14.8 — outstanding/AR-aging is pure financial data, same
    // gate as getRevenueReport/getPaymentsReport: clinic_admin and
    // billing_staff only.
    const visibility = visibilityEngine.getReportVisibility(req.user, 'reports');
    const canSeeFinancial = visibility === visibilityEngine.SCOPE_KINDS.FULL_CLINIC
      || visibility === visibilityEngine.SCOPE_KINDS.FINANCIAL;
    if (!canSeeFinancial) {
      const error = new Error('You do not have access to outstanding-payment analytics');
      error.statusCode = 403;
      throw error;
    }

    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const now = new Date();

    const [open, byDoctor, byPatient] = await Promise.all([
      // All open invoices (pending or already flagged overdue), with
      // days-overdue computed against dueDate (falls back to
      // invoiceDate if dueDate was never set — same fallback the
      // billing summary already implicitly relies on).
      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: { $in: ['pending', 'overdue'] } } },
        {
          $project: {
            total: 1,
            patientId: 1,
            doctorId: 1,
            daysOverdue: {
              $max: [0, { $divide: [{ $subtract: [now, { $ifNull: ['$dueDate', '$invoiceDate'] }] }, 1000 * 60 * 60 * 24] }],
            },
          },
        },
      ]),

      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: { $in: ['pending', 'overdue'] }, doctorId: { $ne: null } } },
        { $group: { _id: '$doctorId', amount: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'doctors', localField: '_id', foreignField: '_id', as: 'doctor' } },
        { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, amount: 1, count: 1, 'doctor.fullName': 1, 'doctor.initials': 1, 'doctor.avatarColor': 1 } },
      ]),

      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: { $in: ['pending', 'overdue'] } } },
        { $group: { _id: '$patientId', amount: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'patients', localField: '_id', foreignField: '_id', as: 'patient' } },
        { $unwind: { path: '$patient', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, amount: 1, count: 1, 'patient.fullName': 1, 'patient.phone': 1, 'patient.patientId': 1 } },
      ]),
    ]);

    const aging = AGING_BUCKETS.map((b) => ({ label: b.label, amount: 0, count: 0 }));
    let totalOutstanding = 0;
    for (const inv of open) {
      totalOutstanding += inv.total;
      const idx = AGING_BUCKETS.findIndex((b) => inv.daysOverdue >= b.min && inv.daysOverdue <= b.max);
      const bucket = aging[idx === -1 ? aging.length - 1 : idx];
      bucket.amount += inv.total;
      bucket.count += 1;
    }
    aging.forEach((b) => (b.amount = fix2(b.amount)));

    res.status(200).json({
      success: true,
      data: {
        totalOutstanding: fix2(totalOutstanding),
        openInvoiceCount: open.length,
        aging,
        byDoctor: byDoctor.map((row) => ({ ...row, amount: fix2(row.amount) })),
        topDebtors: byPatient.map((row) => ({ ...row, amount: fix2(row.amount) })),
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- Report 07 — BUSINESS HEALTH OVERVIEW ---------- */
// GET /api/reports/overview
// clinic_admin only. One executive-summary endpoint combining
// month-over-month deltas across revenue, patients, and
// appointments — designed to be the single payload behind both
// the future Executive Dashboard widget and a WhatsApp digest
// message (see Recommendations: WhatsApp Automation Integration).

const getBusinessOverviewReport = async (req, res, next) => {
  try {
    const cid = new mongoose.Types.ObjectId(req.clinicId);
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = thisMonthStart;
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const revenueFor = (start, end) =>
      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: 'paid', invoiceDate: { $gte: start, $lt: end } } },
        { $group: { _id: null, amount: { $sum: '$total' } } },
      ]);
    const apptsFor = (start, end) =>
      Appointment.aggregate([
        { $match: { clinicId: cid, appointmentDate: { $gte: start, $lt: end } } },
        { $group: { _id: null, total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
      ]);
    const newPatientsFor = (start, end) => Patient.countDocuments({ clinicId: cid, createdAt: { $gte: start, $lt: end } });

    const [
      revThisMonth, revLastMonth,
      apptThisMonth, apptLastMonth,
      newPatThisMonth, newPatLastMonth,
      activePatients, activeDoctors,
      outstandingAgg,
    ] = await Promise.all([
      revenueFor(thisMonthStart, nextMonthStart),
      revenueFor(lastMonthStart, lastMonthEnd),
      apptsFor(thisMonthStart, nextMonthStart),
      apptsFor(lastMonthStart, lastMonthEnd),
      newPatientsFor(thisMonthStart, nextMonthStart),
      newPatientsFor(lastMonthStart, lastMonthEnd),
      Patient.countDocuments({ clinicId: cid, isActive: true }),
      Doctor.countDocuments({ clinicId: cid, isActive: true }),
      Invoice.aggregate([
        { $match: { clinicId: cid, paymentStatus: { $in: ['pending', 'overdue'] } } },
        { $group: { _id: null, amount: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),
    ]);

    const pctChange = (curr, prev) => {
      if (!prev) return curr ? 100 : 0;
      return fix2(((curr - prev) / prev) * 100);
    };

    const rThis = revThisMonth[0]?.amount || 0;
    const rLast = revLastMonth[0]?.amount || 0;
    const aThis = apptThisMonth[0] || { total: 0, completed: 0 };
    const aLast = apptLastMonth[0] || { total: 0, completed: 0 };
    const outstanding = outstandingAgg[0] || { amount: 0, count: 0 };

    res.status(200).json({
      success: true,
      data: {
        asOf: now.toISOString(),
        revenue: { thisMonth: fix2(rThis), lastMonth: fix2(rLast), changePct: pctChange(rThis, rLast) },
        appointments: {
          thisMonth: aThis.total,
          lastMonth: aLast.total,
          changePct: pctChange(aThis.total, aLast.total),
          completionRateThisMonth: aThis.total ? fix2((aThis.completed / aThis.total) * 100) : 0,
        },
        newPatients: { thisMonth: newPatThisMonth, lastMonth: newPatLastMonth, changePct: pctChange(newPatThisMonth, newPatLastMonth) },
        activePatients,
        activeDoctors,
        outstanding: { amount: fix2(outstanding.amount), count: outstanding.count },
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ---- Reports Router ---- */

const reportsRouter = express.Router();

// All report routes require authentication + tenant scope, same
// gate as every other module (authenticate → authorize → tenantScope
// → requireClinicContext). Order matches Billing's router exactly.
reportsRouter.use(authenticate, tenantScope, requireClinicContext);

reportsRouter.get('/revenue', requirePermission('reports', 'view'), getRevenueReport);
reportsRouter.get('/appointments', requirePermission('reports', 'view'), getAppointmentsReport);
reportsRouter.get('/patients/growth', requirePermission('reports', 'view'), getPatientGrowthReport);
// Phase 14.8 — changed from reports.manage to reports.view so a
// doctor (who has view, not manage) can reach this handler at all;
// getDoctorPerformanceVisibility() inside the handler is what
// actually restricts a doctor to their own row. receptionist also
// has reports.view but getDoctorPerformanceVisibility() grants
// receptionist the OPERATIONAL roster view per spec ("Reception:
// Doctor schedules"); billing_staff has reports.view+export too but
// is denied inside the handler (scope NONE) — the Permission Engine
// matrix itself is unchanged, only this route's required action.
reportsRouter.get('/doctors/performance', requirePermission('reports', 'view'), getDoctorPerformanceReport);
reportsRouter.get('/payments', requirePermission('reports', 'view'), getPaymentsReport);
reportsRouter.get('/outstanding', requirePermission('reports', 'view'), getOutstandingReport);
reportsRouter.get('/overview', requirePermission('reports', 'manage'), getBusinessOverviewReport);

app.use('/api/reports', reportsRouter);

/* ============================================================
   4I. STAFF MANAGEMENT (Phase 14.0)
   + STAFF IDENTITY LINKING (Phase 12.1)
   Lets a clinic_admin create/view/edit/activate/deactivate staff
   login accounts (role: doctor or receptionist) and reset their
   passwords. Inlined per project convention (see 4D–4H above).
   Reuses the existing User model/schema (section 1B) — no new
   models, no new auth scheme. Staff log in via POST /api/auth/login
   with { username, password } (handleLogin above); the admin login
   flow (index.html, { email, password }) is untouched.

   Phase 12.1 note: for role: doctor, doctorId is now REQUIRED and
   must reference an existing, active, not-already-linked Doctor
   profile (section 1C) — no more manually-typed doctor identities.
   Receptionist/billing_staff accounts are explicitly out of scope
   for this phase and keep the old manual-identity path (see the
   phase spec's "Receptionist"/"Billing Staff" sections). This phase
   only links identity; it does not touch permissions, visibility,
   authentication, or dashboard logic (all pre-existing and untouched
   here — authenticate() already resolved doctorId onto req.user back
   in Phase 14.2).

   RBAC: clinic_admin only, end to end. Every route below requires
   authenticate → tenantScope → requireClinicContext → authorize
   ('clinic_admin'), same gate order as every other module.

   Tenant isolation: every query is scoped by both clinicId AND
   role: { $in: STAFF_ROLES } together — this is what stops a
   clinic_admin from ever reading/editing/deactivating another
   clinic_admin, a super_admin, or a billing_staff account through
   this module; only doctor/receptionist accounts are reachable here,
   per the "Support: receptionist, doctor" requirement. ============================================================ */

const STAFF_ROLES = ['doctor', 'receptionist'];
const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;

const isValidUsername = (value) =>
  typeof value === 'string' && USERNAME_RE.test(value.trim().toLowerCase());

// Shape returned by every /api/staff response. Deliberately distinct
// from sanitizeUser() (used by /api/auth) — `fullName` instead of
// `name` matches the field name every other module's frontend already
// sends/expects (doctors.js, patients.js), without touching the
// User schema's actual `name` field or the auth endpoints' response
// shape anywhere else in the app.
const serializeStaff = (userDoc) => {
  const u = userDoc.toJSON ? userDoc.toJSON() : userDoc;
  return {
    _id: u._id,
    fullName: u.name,
    username: u.username || null,
    phone: u.phone || null,
    role: u.role,
    doctorId: u.doctorId || null,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt,
  };
};

// `requireCore` controls whether fullName/username/phone/role are
// mandatory (true on create) or merely validated-if-present (false
// on update) — same convention as validatePatientFields/
// validateDoctorFields above.
const validateStaffFields = (body, { requireCore }) => {
  const errors = [];

  if (requireCore || body.fullName !== undefined) {
    if (!isNonEmptyString(body.fullName)) {
      errors.push('fullName is required and must be a non-empty string');
    } else if (body.fullName.trim().length > MAX_NAME_LENGTH) {
      errors.push(`fullName must be ${MAX_NAME_LENGTH} characters or fewer`);
    }
  }

  if (requireCore || body.username !== undefined) {
    if (!isValidUsername(body.username)) {
      errors.push('username is required and must be 3-30 characters: lowercase letters, numbers, "_" or "."');
    }
  }

  if (requireCore || body.phone !== undefined) {
    if (!isValidPhone(body.phone)) {
      errors.push('phone is required and must be a valid phone number');
    }
  }

  if (requireCore || body.role !== undefined) {
    if (!STAFF_ROLES.includes(body.role)) {
      errors.push(`role is required and must be one of: ${STAFF_ROLES.join(', ')}`);
    }
  }

  // Phase 12.1 (Staff Identity Linking) — for role: doctor, doctorId is
  // no longer optional. A doctor login must always be linked to a real
  // Doctor profile; there is no more "manual name, no linked doctor"
  // path.
  if (requireCore && body.role === 'doctor') {
    if (body.doctorId === undefined || body.doctorId === null || body.doctorId === '') {
      errors.push('doctorId is required when role is doctor — select an existing Doctor profile');
    }
  }

  if (body.doctorId !== undefined && body.doctorId !== null && body.doctorId !== '') {
    if (!mongoose.Types.ObjectId.isValid(body.doctorId)) {
      errors.push('doctorId is not a valid id');
    } else if (body.role && body.role !== 'doctor') {
      errors.push('doctorId can only be set when role is doctor');
    }
  }

  // Clearing doctorId (null/'') on a doctor-role account is never valid
  // — a doctor login always stays linked; to change WHO it's linked to,
  // the admin picks a different doctor, they don't unlink it.
  if (!requireCore && body.doctorId !== undefined && (body.doctorId === null || body.doctorId === '') && body.role === 'doctor') {
    errors.push('doctorId cannot be cleared for a doctor account — select a different doctor to relink instead');
  }

  return errors;
};

/* ---------- AVAILABLE DOCTORS (Phase 12.1) ----------
   Backs the "Select Doctor" dropdown on the Create/Edit Staff form
   when role = doctor. Returns only doctors that are:
     - in this clinic (tenant isolation)
     - active (isActive: true)
     - NOT already linked to a login (no User with this doctorId)
   Excludes manual name entry entirely — the frontend can no longer
   create a doctor login without picking one of these.

   Supports ?search= across name/doctorId/specialization, and
   ?includeId= (used by the Edit Staff form) which adds back the
   doctor currently linked to *this* staff record even though they're
   technically "linked" — so editing an existing doctor login doesn't
   make its own doctor vanish from the dropdown. */

const listAvailableDoctors = async (req, res, next) => {
  try {
    const query = req.query || {};

    // Every doctorId currently linked to a login in this clinic —
    // lean/minimal projection per the Performance section of the spec.
    const linkedDoctorIds = await User.find({
      clinicId: req.clinicId,
      role: 'doctor',
      doctorId: { $ne: null },
    }).select('doctorId').lean();

    const linkedIdSet = new Set(linkedDoctorIds.map((u) => String(u.doctorId)));

    // Editing an existing doctor login: keep that doctor selectable
    // even though they're "linked" (linked to the very record being
    // edited).
    if (isNonEmptyString(query.includeId) && mongoose.Types.ObjectId.isValid(query.includeId)) {
      linkedIdSet.delete(String(query.includeId));
    }

    const filter = { clinicId: req.clinicId, isActive: true };
    if (linkedIdSet.size > 0) {
      filter._id = { $nin: Array.from(linkedIdSet).map((id) => new mongoose.Types.ObjectId(id)) };
    }

    if (isNonEmptyString(query.search)) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(term, 'i');
      filter.$or = [{ fullName: regex }, { doctorId: regex }, { specialization: regex }];
    }

    const doctors = await Doctor.find(filter)
      .select('doctorId fullName specialization isActive')
      .sort({ fullName: 1 })
      .lean();

    res.status(200).json({
      success: true,
      data: doctors.map((d) => ({
        _id: d._id,
        doctorId: d.doctorId,
        fullName: d.fullName,
        specialization: d.specialization || null,
        isActive: d.isActive,
      })),
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- CREATE STAFF ---------- */

const createStaff = async (req, res, next) => {
  try {
    const body = req.body || {};

    const errors = validateStaffFields(body, { requireCore: true });
    if (!isStrongEnoughPassword(body.password)) {
      errors.push('password must be at least 8 characters long');
    }
    if (errors.length > 0) throw badRequest(errors.join('; '));

    const username = body.username.trim().toLowerCase();

    const duplicate = await User.findOne({ clinicId: req.clinicId, username }).select('_id').lean();
    if (duplicate) throw badRequest('A staff member with this username already exists in your clinic');

    // Phase 12.1 (Staff Identity Linking) — link to an existing Doctor
    // profile (doctors.html / /api/doctors). Required when role is
    // doctor (enforced above in validateStaffFields); receptionist/
    // billing_staff accounts never send doctorId and stay on the old
    // manual-identity path untouched by this phase. The Doctor profile
    // remains the single source of truth — nothing about the doctor
    // (name, department, specialization) is copied onto the User doc.
    let doctorId;
    if (body.doctorId) {
      const doctorProfile = await Doctor.findOne({ _id: body.doctorId, clinicId: req.clinicId }).select('_id isActive').lean();
      if (!doctorProfile) throw badRequest('No doctor profile found with this id in your clinic');
      if (!doctorProfile.isActive) throw badRequest('This doctor profile is inactive and cannot be linked to a login');

      // Duplicate-link prevention: a doctor profile may have only ONE
      // login account. Checked here (not just left to a unique index)
      // so the error message is clear and actionable rather than a raw
      // duplicate-key error.
      const alreadyLinked = await User.findOne({ clinicId: req.clinicId, doctorId: doctorProfile._id }).select('_id').lean();
      if (alreadyLinked) throw badRequest('This doctor already has a login account — a doctor profile can only be linked to one login');

      doctorId = doctorProfile._id;
    }

    const passwordHash = await hashPassword(body.password);

    const user = await User.create({
      clinicId: req.clinicId,
      name: body.fullName.trim(),
      username,
      phone: body.phone.trim(),
      role: body.role,
      doctorId: doctorId || undefined,
      passwordHash,
      isActive: true,
    });

    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'STAFF_LOGIN_CREATED',
      entityType: 'User',
      entityId: user._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: doctorId ? { doctorId: String(doctorId) } : undefined,
    });

    res.status(201).json({ success: true, data: serializeStaff(user) });
  } catch (err) {
    next(err);
  }
};

/* ---------- LIST STAFF ---------- */

const listStaff = async (req, res, next) => {
  try {
    const query = req.query || {};

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    // Tenant filter + role whitelist — always present, never
    // overridable by query params (Critical Security Rule).
    const filter = { clinicId: req.clinicId, role: { $in: STAFF_ROLES } };

    if (isNonEmptyString(query.search)) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(term, 'i');
      filter.$or = [{ name: regex }, { username: regex }, { phone: regex }];
    }

    if (isNonEmptyString(query.role)) {
      if (!STAFF_ROLES.includes(query.role)) throw badRequest(`role filter must be one of: ${STAFF_ROLES.join(', ')}`);
      filter.role = query.role;
    }

    if (query.isActive !== undefined) {
      if (query.isActive === 'true') filter.isActive = true;
      else if (query.isActive === 'false') filter.isActive = false;
    }

    const [staff, total] = await Promise.all([
      User.find(filter)
        .select('name username phone role doctorId isActive lastLoginAt createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: staff.map((u) => ({
        _id: u._id,
        fullName: u.name,
        username: u.username || null,
        phone: u.phone || null,
        role: u.role,
        doctorId: u.doctorId || null,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt || null,
        createdAt: u.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    next(err);
  }
};

/* ---------- GET ONE STAFF MEMBER ---------- */

const getStaffMember = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid staff id');

    const user = await User.findOne({
      _id: req.params.id,
      clinicId: req.clinicId,
      role: { $in: STAFF_ROLES },
    });

    if (!user) {
      const error = new Error('Staff member not found');
      error.statusCode = 404;
      throw error;
    }

    res.status(200).json({ success: true, data: serializeStaff(user) });
  } catch (err) {
    next(err);
  }
};

/* ---------- UPDATE STAFF (profile fields, not password) ---------- */

const updateStaff = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid staff id');

    const body = req.body || {};
    const errors = validateStaffFields(body, { requireCore: false });
    if (errors.length > 0) throw badRequest(errors.join('; '));

    // Explicit whitelist — anything else sent (password, isActive,
    // clinicId, role outside STAFF_ROLES, etc.) is silently dropped.
    const updates = {};
    if (body.fullName !== undefined) updates.name = body.fullName.trim();
    if (body.phone !== undefined) updates.phone = body.phone.trim();
    if (body.role !== undefined) updates.role = body.role;

    if (body.username !== undefined) {
      const username = body.username.trim().toLowerCase();
      const duplicate = await User.findOne({
        clinicId: req.clinicId,
        username,
        _id: { $ne: req.params.id },
      }).select('_id').lean();
      if (duplicate) throw badRequest('A staff member with this username already exists in your clinic');
      updates.username = username;
    }

    // Phase 12.1 (Staff Identity Linking) — fetch the existing account
    // first so we know the prior doctorId (needed to tell a genuine
    // relink apart from "doctorId sent but unchanged", and to block
    // clearing it — see validateStaffFields — with a lookup instead of
    // trusting req.body blindly).
    const existing = await User.findOne({
      _id: req.params.id,
      clinicId: req.clinicId,
      role: { $in: STAFF_ROLES },
    }).select('doctorId role').lean();

    if (!existing) {
      const error = new Error('Staff member not found');
      error.statusCode = 404;
      throw error;
    }

    let isRelink = false;
    if (body.doctorId !== undefined) {
      // null/'' is only reachable here for non-doctor roles — a doctor
      // role trying to clear doctorId already failed validation above.
      if (body.doctorId === null || body.doctorId === '') {
        updates.doctorId = null;
      } else {
        const doctorProfile = await Doctor.findOne({ _id: body.doctorId, clinicId: req.clinicId }).select('_id isActive').lean();
        if (!doctorProfile) throw badRequest('No doctor profile found with this id in your clinic');
        if (!doctorProfile.isActive) throw badRequest('This doctor profile is inactive and cannot be linked to a login');

        const alreadyChanging = !existing.doctorId || String(existing.doctorId) !== String(doctorProfile._id);
        if (alreadyChanging) {
          // Duplicate-link prevention on relink too — excludes this
          // same user (_id: { $ne }) so re-saving the identical link
          // doesn't false-positive against itself.
          const alreadyLinked = await User.findOne({
            clinicId: req.clinicId,
            doctorId: doctorProfile._id,
            _id: { $ne: req.params.id },
          }).select('_id').lean();
          if (alreadyLinked) throw badRequest('This doctor already has a login account — a doctor profile can only be linked to one login');
          isRelink = true;
        }

        updates.doctorId = doctorProfile._id;
      }
    }

    if (Object.keys(updates).length === 0) throw badRequest('No valid fields provided to update');

    // Tenant + role scoped — _id + clinicId + role together (Critical
    // Security Rule) — a clinic_admin can never reach a clinic_admin/
    // super_admin/billing_staff account through this route.
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId, role: { $in: STAFF_ROLES } },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!user) {
      const error = new Error('Staff member not found');
      error.statusCode = 404;
      throw error;
    }

    // STAFF_LOGIN_RELINKED when the doctor link actually changed to a
    // different doctor; STAFF_LOGIN_UPDATED for every other edit
    // (username, phone, fullName, or doctorId cleared to null).
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: isRelink ? 'STAFF_LOGIN_RELINKED' : 'STAFF_LOGIN_UPDATED',
      entityType: 'User',
      entityId: user._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: isRelink
        ? { previousDoctorId: existing.doctorId ? String(existing.doctorId) : null, newDoctorId: String(updates.doctorId) }
        : undefined,
    });

    res.status(200).json({ success: true, data: serializeStaff(user) });
  } catch (err) {
    next(err);
  }
};

/* ---------- ACTIVATE / DEACTIVATE STAFF ----------
   Soft toggle only — never a hard delete. Symmetric: also used to
   re-activate a previously deactivated account (mirrors Patient/
   Doctor status endpoints' convention in this codebase). */

const updateStaffStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid staff id');

    const body = req.body || {};
    if (typeof body.isActive !== 'boolean') throw badRequest('isActive must be a boolean');

    const update = { isActive: body.isActive };
    if (body.isActive) {
      // Reactivating clears any lockout left over from before deactivation.
      update.loginAttempts = 0;
      update.lockUntil = null;
    }

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId, role: { $in: STAFF_ROLES } },
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!user) {
      const error = new Error('Staff member not found');
      error.statusCode = 404;
      throw error;
    }

    // Phase 12.1 (Staff Identity Linking) — audit naming aligned with
    // the spec's STAFF_LOGIN_* vocabulary. Deactivating a staff login
    // is this app's only "delete" (soft, never a hard delete — see the
    // module header above), so it logs as STAFF_LOGIN_REMOVED; the
    // Doctor profile itself is never touched by this route either way,
    // so a doctor's medical record survives their login being removed.
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: body.isActive ? 'STAFF_LOGIN_UPDATED' : 'STAFF_LOGIN_REMOVED',
      entityType: 'User',
      entityId: user._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { isActive: body.isActive, doctorId: user.doctorId ? String(user.doctorId) : null },
    });

    res.status(200).json({ success: true, data: serializeStaff(user) });
  } catch (err) {
    next(err);
  }
};

/* ---------- RESET STAFF PASSWORD ----------
   Staff accounts have no email, so there is no "forgot password"
   email-link flow — the clinic_admin sets a new password directly.
   Clears any lockout so the staff member can log in immediately. */

const resetStaffPassword = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw badRequest('Invalid staff id');

    const body = req.body || {};
    if (!isStrongEnoughPassword(body.newPassword)) {
      throw badRequest('newPassword must be at least 8 characters long');
    }

    const passwordHash = await hashPassword(body.newPassword);

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, clinicId: req.clinicId, role: { $in: STAFF_ROLES } },
      {
        $set: {
          passwordHash,
          passwordChangedAt: new Date(),
          loginAttempts: 0,
          lockUntil: null,
        },
      },
      { new: true, runValidators: true }
    );

    if (!user) {
      const error = new Error('Staff member not found');
      error.statusCode = 404;
      throw error;
    }

    // Task 08-equivalent — audit log. Never logs the password itself.
    await AuditLog.create({
      clinicId: req.clinicId,
      userId: req.user.userId,
      action: 'STAFF_PASSWORD_RESET',
      entityType: 'User',
      entityId: user._id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ success: true, message: 'Password reset successfully', data: serializeStaff(user) });
  } catch (err) {
    next(err);
  }
};

/* ---------- RBAC ----------
   clinic_admin only, every route. No other role can create, view,
   edit, activate/deactivate, or reset passwords for staff accounts. */

const staffRouter = express.Router();
staffRouter.use(authenticate, tenantScope, requireClinicContext);

staffRouter.post('/', requirePermission('staff', 'create'), createStaff);
staffRouter.get('/', requirePermission('staff', 'view'), listStaff);
// Phase 12.1 — must be registered before '/:id' or Express would match
// "available-doctors" as an :id param instead.
staffRouter.get('/available-doctors', requirePermission('staff', 'create'), listAvailableDoctors);
staffRouter.get('/:id', requirePermission('staff', 'view'), getStaffMember);
staffRouter.put('/:id', requirePermission('staff', 'edit'), updateStaff);
staffRouter.patch('/:id/status', requirePermission('staff', 'delete'), updateStaffStatus);
staffRouter.patch('/:id/reset-password', requirePermission('staff', 'manage'), resetStaffPassword);

app.use('/api/staff', staffRouter);

/* ============================================================
   5. ERROR HANDLING
   ============================================================ */

// 404 — only for requests that didn't match a static file or API route
app.use(require('../middleware/notFound'));

// Global error handler
app.use(require('../middleware/errorHandler'));

/* ============================================================
   6. START — DB first, then server
   ============================================================ */

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`\n✅  MediCore API running on port ${PORT}`);
      console.log(`   Environment : ${process.env.NODE_ENV}`);
      console.log(`   Health Check: http://localhost:${PORT}/api/health\n`);
    });
  } catch (err) {
    console.error('❌  Startup failed:', err.message);
    process.exit(1);
  }
})();

module.exports = app;