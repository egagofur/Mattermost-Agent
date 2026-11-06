import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  CronConfigFileSchema,
  NormalizedCronJob,
  RawCronConfigFile,
  RawCronJobDefinition,
} from './cron-config-schema';
import { MattermostValidationError } from '../../../domain/mattermost/errors';
import { getPackageRoot, resolveAppPath, resolveConfigFile } from '../../../config/paths';
import { Logger, defaultLogger } from '../services/logger';

export interface CronConfigLoaderOptions {
  configPath?: string;
  defaultTimezone?: string;
  logger?: Logger;
}

export class CronConfigLoader {
  public static readonly DEFAULT_CONFIG_LOCATIONS = [
    'cron.yml',
    'cron.yaml',
    '.mattermost/cron.yml',
    '.mattermost/cron.yaml',
    'config/cron.yml',
  ];

  private configPath?: string;
  private loadedPath?: string;
  private defaultTimezone: string = 'UTC';
  private jobs: Map<string, NormalizedCronJob> = new Map();
  private searchedLocations: string[] = [];
  private loadWarning?: string;
  private logger: Logger;

  constructor(options: CronConfigLoaderOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
    this.defaultTimezone = options.defaultTimezone ?? 'UTC';
    this.configPath = options.configPath;

    this.autoLoad();
  }

  private autoLoad(): void {
    const resolution = resolveConfigFile(
      CronConfigLoader.DEFAULT_CONFIG_LOCATIONS,
      this.configPath,
      'MATTERMOST_CRON_CONFIG'
    );
    this.searchedLocations = resolution.searchedLocations;

    if (resolution.resolvedPath) {
      this.loadFromFile(resolution.resolvedPath);
      return;
    }

    this.loadWarning = `cron.yml was not found in searched locations: [${this.searchedLocations.join(', ')}]`;
    this.logger.warn(this.loadWarning);
  }

  public loadFromFile(filePath: string): boolean {
    let resolved = filePath;
    if (!path.isAbsolute(resolved)) {
      const inCwd = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(inCwd)) {
        resolved = inCwd;
      } else {
        const inPkg = path.resolve(getPackageRoot(), filePath);
        if (fs.existsSync(inPkg)) {
          resolved = inPkg;
        } else {
          resolved = inCwd;
        }
      }
    }

    if (!this.searchedLocations.includes(resolved)) {
      this.searchedLocations.push(resolved);
    }

    if (!fs.existsSync(resolved)) {
      return false;
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      this.loadFromContent(content);
      this.configPath = resolved;
      this.loadedPath = resolved;
      return true;
    } catch (err) {
      if (err instanceof MattermostValidationError) {
        throw err;
      }
      throw new MattermostValidationError(
        `Failed to read cron config at '${filePath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public loadFromContent(yamlContent: string): this {
    let parsed: unknown;
    try {
      parsed = YAML.parse(yamlContent);
    } catch (err) {
      throw new MattermostValidationError(
        `Failed to parse YAML cron config: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      return this;
    }

    const result = CronConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues.map((i) => `[${i.path.join('.')}] ${i.message}`).join('; ');
      throw new MattermostValidationError(`Invalid cron configuration schema: ${details}`);
    }

    const data = result.data;
    if (data.default_timezone) {
      this.defaultTimezone = data.default_timezone;
    }

    this.jobs.clear();
    for (const [name, def] of Object.entries(data.jobs || {})) {
      this.jobs.set(name.toLowerCase(), {
        name,
        schedule: def.schedule,
        channel: def.channel,
        message: def.message,
        from: def.from,
        rootId: def.rootId,
        team: def.team,
        enabled: def.enabled !== false,
        timezone: def.timezone || this.defaultTimezone,
        description: def.description,
      });
    }

    return this;
  }

  public getJobs(): NormalizedCronJob[] {
    return Array.from(this.jobs.values());
  }

  public getJob(name: string): NormalizedCronJob | undefined {
    return this.jobs.get(name.toLowerCase().trim());
  }

  public setJob(name: string, def: RawCronJobDefinition): void {
    this.jobs.set(name.toLowerCase().trim(), {
      name,
      schedule: def.schedule,
      channel: def.channel,
      message: def.message,
      from: def.from,
      rootId: def.rootId,
      team: def.team,
      enabled: def.enabled !== false,
      timezone: def.timezone || this.defaultTimezone,
      description: def.description,
    });
  }

  public toggleJob(name: string, enabled: boolean): boolean {
    const job = this.jobs.get(name.toLowerCase().trim());
    if (!job) {
      return false;
    }
    job.enabled = enabled;
    this.jobs.set(name.toLowerCase().trim(), job);

    const targetPath = this.loadedPath || this.configPath || resolveAppPath('cron.yml');
    this.saveToFile(targetPath);
    return true;
  }

  public getDefaultTimezone(): string {
    return this.defaultTimezone;
  }

  public getConfigPath(): string | undefined {
    return this.configPath || this.loadedPath;
  }

  public getLoadedPath(): string | undefined {
    return this.loadedPath;
  }

  public getSearchedLocations(): string[] {
    return [...this.searchedLocations];
  }

  public getLoadWarning(): string | undefined {
    return this.loadWarning;
  }

  public assertHasJobs(contextHint?: string): void {
    if (this.jobs.size === 0) {
      const hint = contextHint ? ` (${contextHint})` : '';
      const searched =
        this.searchedLocations.length > 0
          ? ` Searched locations: [${this.searchedLocations.join(', ')}].`
          : '';
      throw new MattermostValidationError(
        `No configured cron jobs found in cron.yml${hint}.${searched}`
      );
    }
  }

  public toYamlObject(): RawCronConfigFile {
    const jobsObj: Record<string, RawCronJobDefinition> = {};
    for (const job of this.jobs.values()) {
      jobsObj[job.name] = {
        schedule: job.schedule,
        channel: job.channel,
        message: job.message,
        from: job.from,
        rootId: job.rootId,
        team: job.team,
        enabled: job.enabled,
        timezone: job.timezone,
        description: job.description,
      };
    }

    return {
      default_timezone: this.defaultTimezone,
      jobs: jobsObj,
    };
  }

  public saveToFile(filePath?: string): void {
    const target = filePath
      ? resolveAppPath(filePath)
      : this.loadedPath || this.configPath || resolveAppPath('cron.yml');
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const doc = new YAML.Document(this.toYamlObject());
    fs.writeFileSync(target, doc.toString(), 'utf-8');
    this.configPath = target;
    this.loadedPath = target;
    this.logger.debug(`Saved cron configuration to '${target}'`);
  }
}
