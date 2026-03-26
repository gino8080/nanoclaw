/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): bind to 0.0.0.0 so containers can reach the proxy.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // Docker Desktop (macOS): bind to 0.0.0.0 so containers can reach the proxy.
  if (os.platform() === 'darwin') return '0.0.0.0';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/**
 * Stop a container by name.
 * - Validates name against shell-safe regex (upstream a4fd4f2 security fix).
 * - Times out after 10s and falls back to `docker kill` to avoid blocking
 *   the main loop if the Docker daemon is unresponsive.
 */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      'killed' in err &&
      (err as Record<string, unknown>).killed;
    if (isTimeout) {
      logger.warn(
        { containerName: name },
        'docker stop timed out (10s), forcing kill',
      );
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} kill ${name}`, {
          stdio: 'pipe',
          timeout: 5_000,
        });
      } catch {
        logger.warn({ containerName: name }, 'docker kill also failed');
      }
    } else {
      throw err;
    }
  }
}

/** Ensure the container runtime is running. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Container runtime not available');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime not available                        ║',
    );
    console.error(
      '║  Ensure Docker Desktop is running, then restart NanoClaw.      ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter "name=nanoclaw-" --format "{{.Names}}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const running = output
      .trim()
      .split('\n')
      .filter((n) => n.startsWith('nanoclaw-'));
    for (const name of running) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (running.length > 0) {
      logger.info(
        { count: running.length, names: running },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
