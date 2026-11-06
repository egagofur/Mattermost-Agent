import { User } from '../../../domain/mattermost/entities';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { Logger, defaultLogger } from './logger';

export class UserCacheService {
  private cache = new Map<string, User>();
  private provider: MattermostProvider;
  private logger: Logger;

  constructor(provider: MattermostProvider, logger?: Logger) {
    this.provider = provider;
    this.logger = logger ?? defaultLogger;
  }

  public setProvider(provider: MattermostProvider): void {
    this.provider = provider;
  }

  public primeUser(user: User): void {
    if (user && user.id) {
      this.cache.set(user.id, user);
    }
  }

  public getUser(userId: string): User | undefined {
    return this.cache.get(userId);
  }

  public getUsername(userId: string): string {
    return this.cache.get(userId)?.username || userId;
  }

  public async resolveUsers(userIds: string[]): Promise<Map<string, User>> {
    const uniqueIds = Array.from(new Set(userIds.filter((id) => Boolean(id) && typeof id === 'string')));
    const missingIds = uniqueIds.filter((id) => !this.cache.has(id));

    if (missingIds.length > 0 && typeof this.provider.getUsersByIds === 'function') {
      try {
        const fetched = await this.provider.getUsersByIds(missingIds);
        if (Array.isArray(fetched)) {
          for (const u of fetched) {
            if (u && u.id) {
              this.cache.set(u.id, u);
            }
          }
        }
      } catch (err) {
        this.logger.debug('Failed to batch resolve users by IDs', { error: String(err) });
      }
    }

    const result = new Map<string, User>();
    for (const id of uniqueIds) {
      const u = this.cache.get(id);
      if (u) {
        result.set(id, u);
      }
    }
    return result;
  }
}
