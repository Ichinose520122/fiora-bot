const port = Number(process.env.QQ_AGENT_PORT) || 3220;
try {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || !(await response.text()).includes('<html')) process.exit(1);
} catch { process.exit(1); }
