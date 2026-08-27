import { execFile } from 'child_process';
import * as fs from 'fs';
import { AgentExecutor, AgentResult } from './executor';
import { AgentTask } from './task';

export interface HermesExecutorOptions {
  cliPath?: string;
  invocationMode?: 'cli' | 'docker' | 'http';
  containerName?: string;
  apiUrl?: string;
  model?: string;
  yolo?: boolean;
  timeoutMs?: number;
}

/**
 * Strips ANSI color and formatting codes from CLI output.
 */
function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Hermes Agent Executor
 * Connects the Mattermost Integration layer directly to the local Hermes AI Agent.
 */
export class HermesAgentExecutor implements AgentExecutor {
  private cliPath: string;
  private invocationMode: 'cli' | 'docker' | 'http';
  private containerName: string;
  private apiUrl: string;
  private model?: string;
  private yolo: boolean;
  private timeoutMs: number;

  constructor(options?: HermesExecutorOptions) {
    // Resolve CLI path (check explicit option, common user path, or system path)
    let resolvedCli = options?.cliPath || process.env.HERMES_CLI_PATH || 'hermes';
    if (resolvedCli === 'hermes' && fs.existsSync('/Users/egagofur/.local/bin/hermes')) {
      resolvedCli = '/Users/egagofur/.local/bin/hermes';
    }

    this.cliPath = resolvedCli;
    this.invocationMode = options?.invocationMode || (process.env.HERMES_INVOCATION_MODE as any) || 'cli';
    this.containerName = options?.containerName || process.env.HERMES_CONTAINER_NAME || 'hermes-agent';
    this.apiUrl = (options?.apiUrl || process.env.HERMES_API_URL || 'http://localhost:8000').replace(/\/+$/, '');
    this.model = options?.model || process.env.HERMES_MODEL;
    this.yolo = options?.yolo !== undefined ? options.yolo : true;
    this.timeoutMs = options?.timeoutMs || 120000; // 2 minutes max execution
  }

  public async execute(task: AgentTask): Promise<AgentResult> {
    const prompt = this.buildPrompt(task);

    try {
      if (this.invocationMode === 'docker') {
        return await this.executeViaDocker(prompt, task.id);
      }
      if (this.invocationMode === 'http') {
        return await this.executeViaHttp(prompt, task.id);
      }
      return await this.executeViaCli(prompt, task.id);
    } catch (err: any) {
      console.error(`[ERROR] Hermes execution failed for task ${task.id}: ${err.message}`);
      return {
        success: false,
        message: "I couldn't complete that request.",
        metadata: { error: err.message, taskId: task.id },
      };
    }
  }

  /**
   * Constructs a contextual prompt including thread conversation history.
   */
  private buildPrompt(task: AgentTask): string {
    if (!task.threadContext || task.threadContext.length === 0) {
      return task.instruction;
    }

    const contextLines = task.threadContext
      .map((m) => `[${m.author}]: ${m.message}`)
      .join('\n');

    return `Thread Context:\n${contextLines}\n\nTask Instruction:\n${task.instruction}`;
  }

  /**
   * Invokes Hermes via the local CLI in one-shot mode (`hermes -z <prompt>`).
   */
  private executeViaCli(prompt: string, taskId: string): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-z', prompt];

      if (this.yolo) {
        args.push('--yolo');
      }
      if (this.model) {
        args.push('-m', this.model);
      }

      const env = {
        ...process.env,
        HERMES_ACCEPT_HOOKS: '1',
      };

      execFile(
        this.cliPath,
        args,
        {
          timeout: this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env,
        },
        (error, stdout, stderr) => {
          if (error) {
            return reject(new Error(`Hermes CLI exited with error: ${error.message} (stderr: ${stderr.slice(0, 300)})`));
          }

          const rawOutput = (stdout || '').trim();
          const cleanOutput = stripAnsi(rawOutput);

          if (!cleanOutput) {
            return reject(new Error('Hermes returned an empty response.'));
          }

          resolve({
            success: true,
            message: cleanOutput,
            metadata: {
              executor: 'hermes',
              mode: 'cli',
              cliPath: this.cliPath,
              taskId,
            },
          });
        }
      );
    });
  }

  /**
   * Invokes Hermes via Docker (`docker exec -i <container> hermes -z <prompt>`).
   */
  private executeViaDocker(prompt: string, taskId: string): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['exec', '-i', this.containerName, 'hermes', '-z', prompt];

      if (this.yolo) {
        args.push('--yolo');
      }
      if (this.model) {
        args.push('-m', this.model);
      }

      execFile(
        'docker',
        args,
        {
          timeout: this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            return reject(new Error(`Docker Hermes execution failed: ${error.message} (${stderr.slice(0, 300)})`));
          }

          const cleanOutput = stripAnsi((stdout || '').trim());
          if (!cleanOutput) {
            return reject(new Error('Hermes Docker container returned an empty response.'));
          }

          resolve({
            success: true,
            message: cleanOutput,
            metadata: {
              executor: 'hermes',
              mode: 'docker',
              container: this.containerName,
              taskId,
            },
          });
        }
      );
    });
  }

  /**
   * Invokes Hermes via HTTP Gateway endpoint.
   */
  private async executeViaHttp(prompt: string, taskId: string): Promise<AgentResult> {
    const res = await fetch(`${this.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: this.model || 'hermes',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Hermes HTTP Gateway returned status ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      throw new Error('Hermes HTTP Gateway returned an empty message.');
    }

    return {
      success: true,
      message: answer,
      metadata: {
        executor: 'hermes',
        mode: 'http',
        apiUrl: this.apiUrl,
        taskId,
      },
    };
  }
}
