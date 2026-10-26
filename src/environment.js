// Non-empty deployment variables override config.json. Empty values preserve migrated settings.
export function applyEnvironment(config, env = process.env) {
  const fields = {
    FIORA_URL: ['fiora', 'url'], FIORA_BOT_KEY: ['fiora', 'apiKey'],
    MODEL_API_BASE_URL: ['api', 'baseUrl'], MODEL_API_KEY: ['api', 'apiKey'], MODEL_NAME: ['api', 'model'],
    QQ_AGENT_HOST: ['server', 'host'], QQ_AGENT_CONSOLE_TOKEN: ['server', 'token'],
  };
  for (const [name, [section, key]] of Object.entries(fields)) {
    const value = String(env[name] ?? '').trim();
    if (value) { config[section] ||= {}; config[section][key] = value; }
  }
  if (String(env.QQ_AGENT_PORT || '').trim()) {
    const port = Number(env.QQ_AGENT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QQ_AGENT_PORT must be between 1 and 65535');
    config.server ||= {}; config.server.port = port;
  }
  if (String(env.FIORA_ENABLED || '').trim()) {
    if (!/^(true|false|1|0)$/i.test(env.FIORA_ENABLED)) throw new Error('FIORA_ENABLED must be true or false');
    config.fiora ||= {}; config.fiora.enabled = /^(true|1)$/i.test(env.FIORA_ENABLED);
  }
  return config;
}
