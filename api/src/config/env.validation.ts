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
  };
}
