import { z } from 'zod';

// ── Shared primitives ─────────────────────────────────────

/**
 * A valid UID — alphanumeric, dashes, underscores, max 100 chars.
 * This prevents path traversal or injection via URL params.
 */
export const uidSchema = z
  .string()
  .min(1, 'UID cannot be empty')
  .max(100, 'UID too long')
  .regex(/^[\w\-]+$/, 'UID contains invalid characters — only letters, digits, dashes, underscores allowed');

/**
 * A UUID v4 string — used for user IDs, temp-link IDs, etc.
 */
export const uuidSchema = z.string().uuid('Invalid ID format');

// ── Track stage bodies ────────────────────────────────────

/**
 * Winding details body.
 * All fields optional (partial save is allowed).
 * Strings are trimmed; numbers/dates validated if present.
 */
export const windingBodySchema = z.object({
  yarn_type:   z.string().max(200).optional(),
  yarn_id:     z.string().uuid().nullable().optional(),
  company:     z.string().max(200).optional(),
  company_id:  z.string().uuid().nullable().optional(),
  denier:      z.number().optional(),
  lots:        z.number().int().optional(),
  bags:        z.number().int().optional(),
  remark:      z.string().max(1000).optional(),
}).passthrough();

/**
 * TFO details body.
 */
export const tfoBodySchema = z.object({
  tfo_no:          z.number().nullable().optional(),
  loading_date:    z.string().nullable().optional(),
  unloading_date:  z.string().nullable().optional(),
  tpm:             z.number().nullable().optional(),
  cops:            z.number().nullable().optional(),
  color_s:         z.string().max(200).nullable().optional(),
  color_s_id:      z.string().uuid().nullable().optional(),
  color_z:         z.string().max(200).nullable().optional(),
  color_z_id:      z.string().uuid().nullable().optional(),
  location:        z.string().max(200).nullable().optional(),
  twist_per_meter: z.number().optional(),
  direction:       z.enum(['S', 'Z']).optional(),
  speed:           z.number().optional(),
  remark:          z.string().max(1000).optional(),
}).passthrough();

/**
 * Boiler details body.
 */
export const boilerBodySchema = z.object({
  temperature: z.number().optional(),
  pressure:    z.number().optional(),
  duration:    z.number().optional(),
  remark:      z.string().max(1000).optional(),
}).passthrough();

/**
 * Warping details body.
 */
export const warpingBodySchema = z.object({
  beam_count:  z.number().int().optional(),
  length:      z.number().optional(),
  speed:       z.number().optional(),
  remark:      z.string().max(1000).optional(),
}).passthrough();

/**
 * A single machine log row.
 */
export const machineRowSchema = z.object({
  sr_no:         z.number().int().min(1).optional(),
  date_and_time: z.string().max(100).nullable().optional(),
  company:       z.string().max(200).nullable().optional(),
  cops:          z.number().nullable().optional(),
  name:          z.string().max(200).nullable().optional(),
});

export const machineBodySchema = z.object({
  rows: z.array(machineRowSchema).max(500, 'Too many machine rows'),
});

// ── Machines registry ───────────────────────────────────────

/**
 * Machine create body — machine_number is required, rest optional.
 */
export const machineCreateSchema = z.object({
  machine_number: z.number().int().positive('Machine number must be a positive integer'),
  max_capacity:   z.number().int().positive().nullable().optional(),
  vendor_name:    z.string().max(200).optional().nullable(),
  vendor_phone:   z.string().max(50).optional().nullable(),
  purchase_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'purchase_date must be YYYY-MM-DD').optional().nullable(),
  enabled:        z.boolean().optional(),
});

/**
 * Machine update body — all fields optional (partial edit).
 * occupancy_status is intentionally NOT included — system-managed only.
 */
export const machineUpdateSchema = z.object({
  machine_number: z.number().int().positive().optional(),
  max_capacity:   z.number().int().positive().nullable().optional(),
  vendor_name:    z.string().max(200).optional().nullable(),
  vendor_phone:   z.string().max(50).optional().nullable(),
  purchase_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'purchase_date must be YYYY-MM-DD').optional().nullable(),
  enabled:        z.boolean().optional(),
});

// ── User management ───────────────────────────────────────

export const userStatusBodySchema = z.object({
  status: z.enum(['pending', 'approved', 'suspended', 'rejected'], {
    message: 'Status must be one of: pending, approved, suspended, rejected',
  }),
});

export const permissionBodySchema = z.object({
  granted: z.boolean({ message: 'granted must be a boolean' }),
});

// ── Temp links ────────────────────────────────────────────

const KNOWN_PAGES = ['dashboard', 'track', 'users', 'profile'] as const;

export const tempLinkCreateSchema = z.object({
  label:         z.string().max(200).optional(),
  expires_at:    z
    .string()
    .datetime({ message: 'expires_at must be a valid ISO 8601 datetime' })
    .refine((val) => new Date(val) > new Date(), {
      message: 'expires_at must be in the future',
    }),
  max_uses:      z.number().int().positive().nullable().optional(),
  allowed_pages: z
    .array(z.enum(KNOWN_PAGES))
    .min(1, 'At least one page must be allowed')
    .optional(),
});

// ── Validation helper ──────────────────────────────────────

/**
 * Parse and validate a Zod schema against raw data.
 * Returns { success: true, data: T } or { success: false, issues: string[] }.
 */
export function validateData<T>(
  data: unknown,
  schema: z.ZodType<T>
): { success: true; data: T } | { success: false; issues: string[] } {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { success: false, issues };
  }
  return { success: true, data: result.data };
}
