type EnvShape = {
  APP_USER: string;
  APP_PASSWORD: string;
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
    'APP_USER',
    'APP_PASSWORD',
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

  return {
    APP_USER: String(config.APP_USER),
    APP_PASSWORD: String(config.APP_PASSWORD),
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
