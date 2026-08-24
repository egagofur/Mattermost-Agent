import { Channel } from '../../../domain/mattermost/entities';
import { MattermostChannelDisabledError, MattermostChannelNotFoundError } from '../../../domain/mattermost/errors';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { ChannelConfigLoader, NormalizedChannelMapping } from './channel-config-loader';
import { Logger, defaultLogger } from './logger';

export interface ChannelResolverOptions {
  cacheTtlMs?: number;
  defaultTeamId?: string;
  configLoader?: ChannelConfigLoader;
  channelsConfigPath?: string;
  envName?: string;
  logger?: Logger;
}

interface CacheEntry {
  channel: Channel;
  expiresAt: number;
}

export class ChannelResolver {
  private provider: MattermostProvider;
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private defaultTeamId?: string;
  private configLoader: ChannelConfigLoader;
  private logger: Logger;

  constructor(provider: MattermostProvider, options: ChannelResolverOptions = {}) {
    this.provider = provider;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.defaultTeamId = options.defaultTeamId;
    this.logger = options.logger ?? defaultLogger;

    this.configLoader =
      options.configLoader ??
      new ChannelConfigLoader({
        configPath: options.channelsConfigPath,
        envName: options.envName,
        logger: this.logger,
      });
  }

  public setProvider(provider: MattermostProvider): void {
    this.provider = provider;
    this.clearCache();
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public getConfigLoader(): ChannelConfigLoader {
    return this.configLoader;
  }

  public toggleChannel(alias: string, enabled: boolean): boolean {
    return this.configLoader.toggleChannel(alias, enabled);
  }

  public getAliases(): NormalizedChannelMapping[] {
    return this.configLoader.getAllMappings();
  }

  public getMapping(alias: string): NormalizedChannelMapping | undefined {
    return this.configLoader.getMapping(alias);
  }

  private isChannelId(identifier: string): boolean {
    // Mattermost IDs are 26 character base32/alphanumeric strings
    return /^[a-z0-9]{26}$/i.test(identifier);
  }

  private normalizeIdentifier(identifier: string): string {
    return identifier.trim().replace(/^~/, ''); // remove leading ~ if passed like ~engineering
  }

  private getCacheKey(identifier: string, teamId?: string): string {
    return `${teamId ?? 'global'}:${identifier.toLowerCase()}`;
  }

  /**
   * Resolves a channel name, display name, YAML alias, or channel ID to a Channel entity.
   */
  public async resolve(identifier: string, teamId?: string, isFallbackAttempt = false): Promise<Channel> {
    const rawCleanId = this.normalizeIdentifier(identifier);

    // 1. Check YAML channel mapping alias first
    let targetIdentifier = rawCleanId;
    let mappedTeam: string | undefined;

    const yamlMapping = this.configLoader.getMapping(rawCleanId);
    if (yamlMapping) {
      if (yamlMapping.enabled === false) {
        throw new MattermostChannelDisabledError(identifier, {
          alias: rawCleanId,
          targetChannel: yamlMapping.channel,
          team: yamlMapping.team,
        });
      }
      this.logger.debug(`Matched YAML alias '${rawCleanId}' -> target '${yamlMapping.channel}' (team: ${yamlMapping.team || 'default'})`);
      targetIdentifier = this.normalizeIdentifier(yamlMapping.channel);
      mappedTeam = yamlMapping.team;
    }

    const effectiveTeamId = teamId || mappedTeam || this.defaultTeamId || this.configLoader.getDefaultTeam();
    const cacheKey = this.getCacheKey(targetIdentifier, effectiveTeamId);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.logger.debug(`Channel cache hit for '${identifier}' -> '${cached.channel.id}'`);
      return cached.channel;
    }

    this.logger.debug(`Resolving channel '${targetIdentifier}' (team: ${effectiveTeamId || 'any'})...`);

    // 2. Direct Channel ID lookup
    if (this.isChannelId(targetIdentifier)) {
      try {
        const channel = await this.provider.getChannel({ channelId: targetIdentifier });
        if (channel) {
          this.setCache(channel, effectiveTeamId, rawCleanId);
          return channel;
        }
      } catch (err) {
        this.logger.debug(`Direct channel ID lookup failed for '${targetIdentifier}', falling back to name search`);
      }
    }

    // 3. Direct lookup by name with teamId if provided
    if (effectiveTeamId) {
      try {
        const channel = await this.provider.getChannel({ channelName: targetIdentifier, teamId: effectiveTeamId });
        if (channel) {
          this.setCache(channel, effectiveTeamId, rawCleanId);
          return channel;
        }
      } catch {
        // Fallback to channel list matching
      }
    }

    // 4. Search channels list
    try {
      const channels = await this.provider.listChannels(effectiveTeamId);
      const lower = targetIdentifier.toLowerCase();

      // Exact match on name or ID or display name
      const matched = channels.find(
        (c) =>
          c.id.toLowerCase() === lower ||
          c.name.toLowerCase() === lower ||
          c.displayName.toLowerCase() === lower
      );

      if (matched) {
        this.setCache(matched, effectiveTeamId, rawCleanId);
        return matched;
      }
    } catch (err) {
      this.logger.warn(`Failed to list channels while resolving '${targetIdentifier}'`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. Fallback channel resolution
    const fallback = this.configLoader.getFallbackChannel();
    if (fallback && !isFallbackAttempt && fallback.toLowerCase() !== targetIdentifier.toLowerCase()) {
      this.logger.warn(`Channel '${identifier}' was not found. Attempting fallback to configured channel '${fallback}'...`);
      try {
        const fallbackChannel = await this.resolve(fallback, effectiveTeamId, true);
        if (fallbackChannel) {
          return fallbackChannel;
        }
      } catch {
        // Continue to throw primary not found error
      }
    }

    throw new MattermostChannelNotFoundError(identifier, {
      teamId: effectiveTeamId,
      resolvedIdentifier: targetIdentifier,
      yamlAlias: yamlMapping?.alias,
    });
  }

  private setCache(channel: Channel, teamId?: string, originalAlias?: string): void {
    const expiresAt = Date.now() + this.cacheTtlMs;
    const entry: CacheEntry = { channel, expiresAt };

    // Cache by ID
    this.cache.set(this.getCacheKey(channel.id, teamId), entry);
    // Cache by Name
    this.cache.set(this.getCacheKey(channel.name, teamId), entry);
    // Cache by Display Name
    this.cache.set(this.getCacheKey(channel.displayName, teamId), entry);

    // Cache by original YAML alias if different
    if (originalAlias && originalAlias.toLowerCase() !== channel.name.toLowerCase()) {
      this.cache.set(this.getCacheKey(originalAlias, teamId), entry);
    }
  }
}
