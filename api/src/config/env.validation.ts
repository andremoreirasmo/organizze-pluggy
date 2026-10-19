type EnvShape = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_ALLOWED_EMAILS: string;
  SESSION_SECRET: string;
  PORT?: string;
  NODE_ENV?: string;
  ORGANIZZE_EMAIL: string;
  ORGANIZZE_API_TOKEN: string;
  ORGANIZZE_USER_AGENT: string;
  PLUGGY_CLIENT_ID: string;
  PLUGGY_CLIENT_SECRET: string;
  DATABASE_URL?: string;
  /** Optional: Cloud Run Job trigger for Meu Pluggy Playwright refresh. */
  GCP_PROJECT_ID?: string;
  GCP_REGION?: string;
  MEU_PLUGGY_REFRESH_JOB?: string;
  /** Force local Playwright script even when GCP_PROJECT_ID is set. */
  MEU_PLUGGY_REFRESH_LOCAL?: string;
  MEU_PLUGGY_STORAGE_STATE_GCS?: string;
  MEU_PLUGGY_PROGRESS_GCS?: string;
};

export function validateEnv(config: Record<string, unknown>): EnvShape {
  const required = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_ALLOWED_EMAILS',
    'SESSION_SECRET',
    'ORGANIZZE_EMAIL',
    'ORGANIZZE_API_TOKEN',
    'ORGANIZZE_USER_AGENT',
    'PLUGGY_CLIENT_ID',
    'PLUGGY_CLIENT_SECRET',
  ] as const;

  for (const key of required) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Missing or empty env var: ${key}`);
    }
  }

  const sessionSecret = String(config.SESSION_SECRET);
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  return {
    GOOGLE_CLIENT_ID: String(config.GOOGLE_CLIENT_ID),
    GOOGLE_ALLOWED_EMAILS: String(config.GOOGLE_ALLOWED_EMAILS),
    SESSION_SECRET: sessionSecret,
    PORT: config.PORT ? String(config.PORT) : undefined,
    NODE_ENV: config.NODE_ENV ? String(config.NODE_ENV) : undefined,
    ORGANIZZE_EMAIL: String(config.ORGANIZZE_EMAIL),
    ORGANIZZE_API_TOKEN: String(config.ORGANIZZE_API_TOKEN),
    ORGANIZZE_USER_AGENT: String(config.ORGANIZZE_USER_AGENT),
    PLUGGY_CLIENT_ID: String(config.PLUGGY_CLIENT_ID),
    PLUGGY_CLIENT_SECRET: String(config.PLUGGY_CLIENT_SECRET),
    DATABASE_URL: config.DATABASE_URL
      ? String(config.DATABASE_URL)
      : undefined,
    GCP_PROJECT_ID: config.GCP_PROJECT_ID
      ? String(config.GCP_PROJECT_ID)
      : undefined,
    GCP_REGION: config.GCP_REGION ? String(config.GCP_REGION) : undefined,
    MEU_PLUGGY_REFRESH_JOB: config.MEU_PLUGGY_REFRESH_JOB
      ? String(config.MEU_PLUGGY_REFRESH_JOB)
      : undefined,
    MEU_PLUGGY_REFRESH_LOCAL: config.MEU_PLUGGY_REFRESH_LOCAL
      ? String(config.MEU_PLUGGY_REFRESH_LOCAL)
      : undefined,
    MEU_PLUGGY_STORAGE_STATE_GCS: config.MEU_PLUGGY_STORAGE_STATE_GCS
      ? String(config.MEU_PLUGGY_STORAGE_STATE_GCS)
      : undefined,
    MEU_PLUGGY_PROGRESS_GCS: config.MEU_PLUGGY_PROGRESS_GCS
      ? String(config.MEU_PLUGGY_PROGRESS_GCS)
      : undefined,
  };
}
