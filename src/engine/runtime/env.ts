// Clean environment for spawning CLI subprocesses
// Strips Claude Code nesting detection variables that prevent child claude processes from starting

export function getCleanSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  return env;
}
