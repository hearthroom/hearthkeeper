export interface Config {
  token: string;
  applicationId: string;
  guildId: string;
  metricsHost: '127.0.0.1';
  metricsPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  function required(key: string): string {
    const value=env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  function snowflake(key: string): string {
    const value=required(key);
    if (!/^\d{17,20}$/.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  }
  const token=required('DISCORD_TOKEN');
  const applicationId=snowflake('DISCORD_APPLICATION_ID');
  const guildId=snowflake('DISCORD_GUILD_ID');
  const rawPort=env.METRICS_PORT ?? '11940';
  if (!/^\d+$/.test(rawPort)) throw new Error('Invalid METRICS_PORT');
  const metricsPort=Number(rawPort);
  if (!Number.isInteger(metricsPort) || metricsPort<1024 || metricsPort>65535) {
    throw new Error('Invalid METRICS_PORT');
  }
  return {token, applicationId, guildId, metricsHost:'127.0.0.1', metricsPort};
}
