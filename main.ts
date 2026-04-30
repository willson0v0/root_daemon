import { load } from './src/config/index.js';
import { init as initDb } from './src/db/index.js';
import { createLogger } from './src/logger/index.js';
import { IpcServer } from './src/ipc/index.js';
import { TaskManager } from './src/task/index.js';
import { TokenService } from './src/sign/index.js';
import { Notifier } from './src/notifier/index.js';
import { Executor } from './src/executor/index.js';
import { InternalCallbackServer } from './src/approval/index.js';
import { AgentClient } from './src/ws/agent-client.js';

const log = createLogger('main');

async function main() {
  log.info('root-daemon starting');

  // Load config
  const config = load();

  // Init DB
  const dbPath = process.env['ROOT_DAEMON_DB'] ?? '/var/lib/root-daemon/root-daemon.db';
  const db = initDb(dbPath);

  // Core services
  const tokenService = new TokenService(config.hmacKey, db);
  const taskManager = new TaskManager(db, tokenService);

  // IPC server
  const socketPath = process.env['ROOT_DAEMON_SOCK'] ?? '/var/run/root-daemon.sock';
  const ipcServer = new IpcServer({ socketPath });
  await ipcServer.listen();
  log.info({ socketPath }, 'IPC server started');

  // Notifier
  const notifier = new Notifier(ipcServer, config);

  // Executor
  const executor = new Executor(taskManager, { notifier });

  // Internal callback server (C6)
  const callbackServer = new InternalCallbackServer(taskManager, executor, config);

  if (config.approvalWeb) {
    // WS mode: connect to remote approval-web
    log.info({ url: config.approvalWeb.url, machineLabel: config.approvalWeb.machineLabel }, 'Starting in WS mode');
    const agentClient = new AgentClient(config.approvalWeb, executor);
    agentClient.connect();
  } else {
    // IPC mode (original behavior)
    await callbackServer.start();

    // Handle IPC messages from agent
    ipcServer.on('message', async (message: unknown) => {
      const msg = message as { $schema?: string; type?: string; payload?: Record<string, unknown> };
      const payload = msg.payload ?? {};
      const sessionId = (payload['agentSessionId'] as string) ?? 'unknown';
      log.info({ sessionId, type: msg.type }, 'IPC message received');

      if (msg.type === 'SUBMIT_TASK') {
        const command = payload['command'] as string | undefined;
        if (!command) {
          log.warn({ msg }, 'Invalid SUBMIT_TASK: missing command');
          return;
        }
        const preAssignedTaskId = payload['preAssignedTaskId'] as string | undefined;
        const task = await taskManager.submit({
          command,
          description: (payload['description'] as string) ?? '',
          riskHint: payload['riskHint'] as string | undefined,
          agentSessionId: sessionId,
          timeoutSec: (payload['timeoutSec'] as number) ?? 60,
        }, preAssignedTaskId);
        log.info({ taskId: task.taskId }, 'Task submitted, awaiting approval');

        // Send TASK_ACCEPTED back to agent
        const approvalLink = `https://approval.willson0v0.com/approve?task_id=${task.taskId}`;
        ipcServer.send(sessionId, {
          $schema: 'ipc/v1/task_accepted',
          type: 'TASK_ACCEPTED',
          payload: {
            taskId: task.taskId,
            approvalLink,
            expiresAt: task.expiresAt,
          },
        });
      }
    });
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await callbackServer.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info('root-daemon ready');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
