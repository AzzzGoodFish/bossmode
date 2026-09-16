// Environment helpers for spawning CLI subprocesses

export function getPiSpawnEnv(piAgentDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(piAgentDir ? { PI_CODING_AGENT_DIR: piAgentDir } : {}),
  };
}
