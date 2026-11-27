import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CDP_PORT,
  Sidecar,
  validatePort,
} from './sidecar/index.mjs';

/**
 * Parse CLI flags (`--port <n>`, `--port=<n>`, `-h`/`--help`) and `T3_CDP_PORT`.
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  let rawPort = env.T3_CDP_PORT !== undefined ? env.T3_CDP_PORT : DEFAULT_CDP_PORT;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--port') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --port');
      }
      rawPort = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      rawPort = arg.slice('--port='.length);
      continue;
    }
    throw new Error(`Unknown CLI argument: ${arg}`);
  }

  return {
    port: validatePort(rawPort),
    help,
  };
}

/**
 * Run the T3AgyMonitor Sidecar CLI and return an exit code.
 */
export async function runCli(
  argv = process.argv.slice(2),
  env = process.env,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    SidecarClass = Sidecar,
    logger = console,
    registerSignals = true,
  } = {},
) {
  let options;
  try {
    options = parseCliArgs(argv, env);
  } catch (error) {
    stderr.write(`Error: ${error.message}\n`);
    return 1;
  }

  if (options.help) {
    stdout.write(
      `Usage: t3-agy-monitor [--port <1-65535>]\n\n` +
      `Options:\n` +
      `  --port <n>    CDP debugging port (env: T3_CDP_PORT, default: ${DEFAULT_CDP_PORT})\n` +
      `  -h, --help    Show this help message\n`,
    );
    return 0;
  }

  const sidecar = new SidecarClass({ port: options.port, logger });
  if (registerSignals) {
    const shutdown = () => {
      void sidecar.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  await sidecar.start();
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const exitCode = await runCli();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
