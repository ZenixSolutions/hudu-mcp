/**
 * Environment configuration.
 *
 * Everything the server needs to run comes from the environment. Nothing is read
 * from disk, and no credential is ever accepted as a tool argument — an API key
 * supplied by a model would be a credential the model has seen.
 */

import { z } from 'zod';

/** Hudu's published rate limit, in requests per minute. */
export const HUDU_DOCUMENTED_RATE_LIMIT_PER_MINUTE = 300;

/**
 * Hudu documents `page_size` as a parameter but publishes no maximum for it.
 * We clamp to a value we have validated rather than guess at the server's
 * ceiling; see docs/limitations.md.
 */
export const MAX_PAGE_SIZE = 100;

/** Hudu's documented default page size. */
export const DEFAULT_PAGE_SIZE = 25;

const boolFromEnv = (raw: string | undefined): boolean =>
  raw !== undefined && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());

const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .url('HUDU_BASE_URL must be an absolute URL, for example https://hudu.example.com')
    .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
      message: 'HUDU_BASE_URL must use http or https',
    }),
  apiKey: z.string().min(1, 'HUDU_API_KEY must not be empty'),
  readOnly: z.boolean(),
  allowDestructive: z.boolean(),
  allowPasswordReveal: z.boolean(),
  /**
   * Deliberately independent of {@link allowPasswordReveal}.
   *
   * Reading a stored credential and writing one are different powers, and
   * collapsing them would force an operator who only wants an agent to
   * *document* a new credential to also grant it the ability to read every
   * existing one. Writing without reading is a legitimate posture; so is
   * reading without writing. Neither implies the other, so neither gate opens
   * the other.
   */
  allowPasswordWrite: z.boolean(),
  allowExports: z.boolean(),
  requestTimeoutMs: z.number().int().positive().max(600_000),
  maxConcurrency: z.number().int().positive().max(32),
  rateLimitPerMinute: z.number().int().positive().max(HUDU_DOCUMENTED_RATE_LIMIT_PER_MINUTE),
  maxRetries: z.number().int().min(0).max(10),
  userAgent: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

const intFromEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
};

/**
 * Normalise a Hudu instance URL into an API base.
 *
 * Accepts `https://hudu.example.com`, a trailing slash, or a URL that already
 * includes `/api/v1`, and always returns the origin with no trailing slash.
 * The `/api/v1` prefix is added by the client, so it must not be duplicated here.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/api\/v1$/i, '');
}

/**
 * Build configuration from an environment-like record.
 *
 * @throws {ConfigError} with every problem listed at once, so a misconfigured
 * install is fixed in one pass rather than one variable per restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): Config {
  const rawBaseUrl = env['HUDU_BASE_URL']?.trim() ?? '';

  const candidate = {
    baseUrl: rawBaseUrl === '' ? '' : normaliseBaseUrl(rawBaseUrl),
    apiKey: env['HUDU_API_KEY']?.trim() ?? '',
    readOnly: boolFromEnv(env['HUDU_READ_ONLY']),
    allowDestructive: boolFromEnv(env['HUDU_ALLOW_DESTRUCTIVE']),
    allowPasswordReveal: boolFromEnv(env['HUDU_ALLOW_PASSWORD_REVEAL']),
    allowPasswordWrite: boolFromEnv(env['HUDU_ALLOW_PASSWORD_WRITE']),
    allowExports: boolFromEnv(env['HUDU_ALLOW_EXPORTS']),
    requestTimeoutMs: intFromEnv(env['HUDU_REQUEST_TIMEOUT_MS'], 30_000),
    maxConcurrency: intFromEnv(env['HUDU_MAX_CONCURRENCY'], 4),
    rateLimitPerMinute: intFromEnv(env['HUDU_RATE_LIMIT_PER_MINUTE'], 120),
    maxRetries: intFromEnv(env['HUDU_MAX_RETRIES'], 3),
    userAgent: `hudu-mcp/${version} (+https://github.com/ZenixSolutions/hudu-mcp)`,
  };

  const result = ConfigSchema.safeParse(candidate);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.message}`).join('\n');
    throw new ConfigError(
      `Invalid configuration:\n${problems}\n\n` +
        'Required environment variables:\n' +
        '  HUDU_BASE_URL   Your Hudu instance URL, e.g. https://hudu.example.com\n' +
        '  HUDU_API_KEY    An API key from Hudu Admin -> Basic Information -> API Keys\n\n' +
        'See https://github.com/ZenixSolutions/hudu-mcp#configuration',
    );
  }

  if (result.data.readOnly && result.data.allowDestructive) {
    throw new ConfigError(
      'HUDU_READ_ONLY and HUDU_ALLOW_DESTRUCTIVE are both set. ' +
        'Read-only mode wins and destructive tools stay unregistered, but the ' +
        'combination is almost certainly a mistake — unset one of them.',
    );
  }

  return result.data;
}
