import * as fs from 'fs';
import * as path from 'path';
import { CronJobExecutionState } from './cron-config-schema';
import { resolveAppPath } from '../../../config/paths';
import { Logger, defaultLogger } from '../services/logger';

export class CronStateManager {
  private filePath: string;
  private states: Map<string, CronJobExecutionState> = new Map();
  private logger: Logger;

  constructor(filePath?: string, logger?: Logger) {
    this.logger = logger ?? defaultLogger;
    this.filePath = filePath ? resolveAppPath(filePath) : resolveAppPath('data/cron_state.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [name, state] of Object.entries(parsed)) {
          this.states.set(name, state as CronJobExecutionState);
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to parse cron state file at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const obj: Record<string, CronJobExecutionState> = {};
      for (const [name, state] of this.states.entries()) {
        obj[name] = state;
      }

      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(`Failed to save cron state file at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public getState(jobName: string): CronJobExecutionState | undefined {
    return this.states.get(jobName);
  }

  public recordSuccess(jobName: string, messageId?: string): void {
    const existing = this.states.get(jobName) || {
      name: jobName,
      executionCount: 0,
      failureCount: 0,
    };

    existing.lastRunAt = new Date().toISOString();
    existing.lastStatus = 'success';
    existing.lastError = undefined;
    existing.lastMessageId = messageId;
    existing.executionCount += 1;

    this.states.set(jobName, existing);
    this.save();
  }

  public recordFailure(jobName: string, errorMessage: string): void {
    const existing = this.states.get(jobName) || {
      name: jobName,
      executionCount: 0,
      failureCount: 0,
    };

    existing.lastRunAt = new Date().toISOString();
    existing.lastStatus = 'failed';
    existing.lastError = errorMessage;
    existing.failureCount += 1;

    this.states.set(jobName, existing);
    this.save();
  }

  public getAllStates(): Map<string, CronJobExecutionState> {
    return new Map(this.states);
  }

  public clear(): void {
    this.states.clear();
    this.save();
  }
}
