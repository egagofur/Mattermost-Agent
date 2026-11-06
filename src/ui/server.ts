import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { MattermostAutomationService } from '../application/mattermost/services/automation-service';
import { ChannelConfigLoader } from '../infrastructure/mattermost/services/channel-config-loader';
import { Logger, defaultLogger } from '../infrastructure/mattermost/services/logger';

export interface HttpServerOptions {
  port?: number;
  host?: string;
  automationService?: MattermostAutomationService;
  publicDir?: string;
  logger?: Logger;
}

export interface SseClient {
  id: string;
  res: http.ServerResponse;
}

export class MattermostHttpServer {
  private server?: http.Server;
  private port: number;
  private host: string;
  private automationService: MattermostAutomationService;
  private publicDir: string;
  private logger: Logger;
  private sseClients: Map<string, http.ServerResponse> = new Map();
  private isLoggingIn: boolean = false;

  constructor(options: HttpServerOptions = {}) {
    this.port = options.port || Number(process.env.PORT) || 3000;
    this.host = options.host || '0.0.0.0';
    this.logger = options.logger ?? defaultLogger;
    this.automationService = options.automationService ?? new MattermostAutomationService({ logger: this.logger });

    // Determine public directory (handling both dev and built distribution)
    if (options.publicDir) {
      this.publicDir = options.publicDir;
    } else {
      const candidates = [
        path.resolve(__dirname, '../../ui/public'),
        path.resolve(__dirname, '../../../ui/public'),
        path.resolve(process.cwd(), 'ui/public'),
      ];
      this.publicDir = candidates.find((dir) => fs.existsSync(dir)) || path.resolve(process.cwd(), 'ui/public');
    }
  }

  public broadcast(eventType: string, data: unknown): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, res] of this.sseClients.entries()) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(id);
      }
    }
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    const json = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(json);
  }

  private async parseBody<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) {
          reject(new Error('Request payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) {
          return resolve({} as T);
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON payload in request body'));
        }
      });
      req.on('error', reject);
    });
  }

  private serveStaticFile(reqPath: string, res: http.ServerResponse): void {
    let filePath = path.join(this.publicDir, reqPath === '/' ? 'index.html' : reqPath);

    // Prevent directory traversal
    if (!filePath.startsWith(this.publicDir)) {
      this.sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.publicDir, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      this.sendJson(res, 404, { error: 'UI files not found. Ensure ui/public exists.' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    stream.pipe(res);
  }

  public createServer(): http.Server {
    this.server = http.createServer(async (req, res) => {
      const parsedUrl = url.parse(req.url || '/', true);
      const pathname = parsedUrl.pathname || '/';
      const method = (req.method || 'GET').toUpperCase();

      // Handle CORS Preflight
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      // API Routes Dispatcher
      if (pathname.startsWith('/api/')) {
        try {
          await this.handleApiRoute(pathname, method, req, res, parsedUrl.query);
        } catch (err: any) {
          this.logger.error(`API error on ${method} ${pathname}: ${err.message}`);
          this.sendJson(res, 500, {
            success: false,
            error: err.message || 'Internal Server Error',
          });
        }
        return;
      }

      // Static UI Asset Serving
      this.serveStaticFile(pathname, res);
    });

    return this.server;
  }

  private async handleApiRoute(
    pathname: string,
    method: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: Record<string, any>
  ): Promise<void> {
    // 1. SSE Events Stream
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');

      const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.sseClients.set(clientId, res);

      req.on('close', () => {
        this.sseClients.delete(clientId);
      });
      return;
    }

    // 2. Status & Whoami
    if (pathname === '/api/status' && method === 'GET') {
      let whoami = null;
      let authenticated = false;

      try {
        whoami = await this.automationService.whoami();
        authenticated = true;
      } catch {
        authenticated = false;
      }

      this.sendJson(res, 200, {
        success: true,
        authenticated,
        isLoggingIn: this.isLoggingIn,
        user: whoami,
        provider: process.env.MATTERMOST_PROVIDER || 'playwright',
        mattermostUrl: process.env.MATTERMOST_URL || 'https://mattermost.example.com',
        defaultFrom: process.env.MATTERMOST_DEFAULT_FROM || 'AI Agent',
      });
      return;
    }

    if (pathname === '/api/whoami' && method === 'GET') {
      const user = await this.automationService.whoami();
      this.sendJson(res, 200, { success: true, data: user });
      return;
    }

    // 3. 1-Click Interactive Login
    if (pathname === '/api/auth/login' && method === 'POST') {
      if (this.isLoggingIn) {
        this.sendJson(res, 409, { success: false, message: 'Login flow is already in progress' });
        return;
      }

      this.isLoggingIn = true;
      this.broadcast('auth:starting', { message: 'Launching browser for interactive login...' });

      // Run login asynchronously so the HTTP response returns immediately to UI
      (async () => {
        try {
          await this.automationService.interactiveLogin();
          // Sync channels right after successful login
          try {
            await this.automationService.syncChannels();
          } catch {}
          const user = await this.automationService.whoami();
          this.broadcast('auth:success', {
            message: `Successfully logged in as @${user.username}!`,
            user,
          });
        } catch (err: any) {
          this.broadcast('auth:failed', {
            message: `Login failed: ${err.message}`,
          });
        } finally {
          this.isLoggingIn = false;
          this.broadcast('auth:finished', {});
        }
      })();

      this.sendJson(res, 202, {
        success: true,
        message: 'Browser login window launched. Please complete login in the opened browser window.',
      });
      return;
    }

    // 4. Channels API
    if (pathname === '/api/channels' && method === 'GET') {
      const configLoader = this.automationService.getChannelResolver().getConfigLoader();
      const mappings = configLoader.getAllMappings();
      this.sendJson(res, 200, {
        success: true,
        total: mappings.length,
        defaultTeam: configLoader.getDefaultTeam(),
        fallbackChannel: configLoader.getFallbackChannel(),
        channels: mappings,
      });
      return;
    }

    if (pathname === '/api/channels/sync' && method === 'POST') {
      const result = await this.automationService.syncChannels();
      this.broadcast('channels:synced', result);
      this.sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (pathname === '/api/channels/toggle' && method === 'POST') {
      const body = await this.parseBody<{ channel: string; enabled: boolean }>(req);
      const configLoader = this.automationService.getChannelResolver().getConfigLoader();
      const success = configLoader.toggleChannel(body.channel, body.enabled);
      this.broadcast('channels:toggled', { channel: body.channel, enabled: body.enabled });
      this.sendJson(res, success ? 200 : 404, { success, channel: body.channel, enabled: body.enabled });
      return;
    }

    // 5. Threads API
    if (pathname === '/api/threads' && method === 'GET') {
      const channel = String(query.channel || 'town-square');
      const limit = query.limit ? Number(query.limit) : 30;
      const q = typeof query.query === 'string' ? query.query : undefined;

      const result = await this.automationService.getThreads({
        channel,
        limit,
        query: q,
      });

      this.sendJson(res, 200, {
        success: true,
        channel: result.channel,
        threads: result.threads,
      });
      return;
    }

    // 6. Messages API (Send & Reply)
    if (pathname === '/api/messages/send' && method === 'POST') {
      const body = await this.parseBody<{
        channel: string;
        message: string;
        from?: string;
        teamId?: string;
      }>(req);

      if (!body.channel || !body.message) {
        this.sendJson(res, 400, { success: false, error: 'Channel and message are required' });
        return;
      }

      const result = await this.automationService.sendMessage({
        channel: body.channel,
        message: body.message,
        from: body.from,
        teamId: body.teamId,
      });

      this.broadcast('message:sent', {
        id: result.id,
        channel: body.channel,
        message: body.message,
        from: body.from,
      });

      this.sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (pathname === '/api/messages/reply' && method === 'POST') {
      const body = await this.parseBody<{
        channel: string;
        rootId: string;
        message: string;
        from?: string;
        teamId?: string;
      }>(req);

      if (!body.channel || !body.rootId || !body.message) {
        this.sendJson(res, 400, { success: false, error: 'Channel, rootId, and message are required' });
        return;
      }

      const result = await this.automationService.replyToMessage({
        channel: body.channel,
        rootId: body.rootId,
        message: body.message,
        from: body.from,
        teamId: body.teamId,
      });

      this.broadcast('message:replied', {
        id: result.id,
        channel: body.channel,
        rootId: body.rootId,
        message: body.message,
        from: body.from,
      });

      this.sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (pathname === '/api/messages/history' && method === 'GET') {
      const channel = String(query.channel || 'town-square');
      const limit = query.limit ? Number(query.limit) : 20;

      const result = await this.automationService.readChannel({
        channel,
        limit,
      });

      this.sendJson(res, 200, { success: true, total: result.messages.length, channel: result.channel, posts: result.messages });
      return;
    }

    // 7. Cron Scheduler API
    if (pathname === '/api/cron' && method === 'GET') {
      const queryStr = typeof query.query === 'string' ? query.query.toLowerCase() : undefined;
      const jobs = this.automationService.listCronJobs();

      let filtered = jobs;
      if (queryStr) {
        filtered = jobs.filter(
          (j) =>
            j.name.toLowerCase().includes(queryStr) ||
            j.channel.toLowerCase().includes(queryStr) ||
            (j.description && j.description.toLowerCase().includes(queryStr))
        );
      }

      this.sendJson(res, 200, { success: true, total: filtered.length, jobs: filtered });
      return;
    }

    if (pathname === '/api/cron/run' && method === 'POST') {
      const body = await this.parseBody<{ jobName: string }>(req);
      if (!body.jobName) {
        this.sendJson(res, 400, { success: false, error: 'jobName is required' });
        return;
      }

      const result = await this.automationService.runCronJob(body.jobName);
      if (!result.success) {
        this.sendJson(res, 422, { success: false, error: result.error });
        return;
      }

      this.broadcast('cron:executed', { jobName: body.jobName, result });
      this.sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (pathname === '/api/cron/toggle' && method === 'POST') {
      const body = await this.parseBody<{ jobName: string; enabled: boolean }>(req);
      if (!body.jobName || typeof body.enabled !== 'boolean') {
        this.sendJson(res, 400, { success: false, error: 'jobName and enabled boolean are required' });
        return;
      }

      const success = this.automationService.toggleCronJob(body.jobName, body.enabled);
      this.broadcast('cron:toggled', { jobName: body.jobName, enabled: body.enabled });
      this.sendJson(res, success ? 200 : 404, { success, jobName: body.jobName, enabled: body.enabled });
      return;
    }

    if ((pathname === '/api/cron/save' || pathname === '/api/cron/add') && method === 'POST') {
      const body = await this.parseBody<{
        name: string;
        schedule: string;
        channel: string;
        message: string;
        from?: string;
        rootId?: string;
        timezone?: string;
        enabled?: boolean;
        description?: string;
      }>(req);

      if (!body.name || !body.schedule || !body.channel || !body.message) {
        this.sendJson(res, 400, { success: false, error: 'name, schedule, channel, and message are required' });
        return;
      }

      const scheduler = this.automationService.getCronScheduler();
      const configLoader = scheduler.getConfigLoader();
      configLoader.setJob(body.name, {
        schedule: body.schedule,
        channel: body.channel,
        message: body.message,
        from: body.from,
        rootId: body.rootId,
        timezone: body.timezone,
        enabled: body.enabled !== false,
        description: body.description,
      });
      configLoader.saveToFile();

      this.broadcast('cron:saved', { jobName: body.name });
      this.sendJson(res, 200, { success: true, message: `Cron job '${body.name}' saved successfully.` });
      return;
    }

    // 8. OpenAPI Specification Endpoint
    if (pathname === '/api/openapi.json' && method === 'GET') {
      this.sendJson(res, 200, this.getOpenApiSpec());
      return;
    }

    this.sendJson(res, 404, { success: false, error: `API route not found: ${method} ${pathname}` });
  }

  private getOpenApiSpec(): Record<string, unknown> {
    return {
      openapi: '3.0.3',
      info: {
        title: 'Mattermost Agent REST API Gateway',
        description: 'Interactive REST API for sending messages, replying to threads, discovering channels, and managing automated cron jobs.',
        version: '1.2.0',
      },
      servers: [{ url: `http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}` }],
      paths: {
        '/api/status': {
          get: {
            summary: 'Get session connection and authentication status',
            responses: { 200: { description: 'Status info' } },
          },
        },
        '/api/auth/login': {
          post: {
            summary: 'Trigger 1-Click interactive browser login',
            responses: { 202: { description: 'Browser window opened' } },
          },
        },
        '/api/channels': {
          get: {
            summary: 'List configured channels and aliases',
            responses: { 200: { description: 'Channel list' } },
          },
        },
        '/api/threads': {
          get: {
            summary: 'List active threads in a channel with :1 shortcuts',
            parameters: [
              { name: 'channel', in: 'query', schema: { type: 'string' } },
              { name: 'limit', in: 'query', schema: { type: 'integer', default: 30 } },
              { name: 'query', in: 'query', schema: { type: 'string' } },
            ],
            responses: { 200: { description: 'Thread summaries' } },
          },
        },
        '/api/messages/send': {
          post: {
            summary: 'Send top-level message with sender attribution',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['channel', 'message'],
                    properties: {
                      channel: { type: 'string', example: 'town-square' },
                      message: { type: 'string', example: 'Hello from API!' },
                      from: { type: 'string', example: 'Automation Bot' },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: 'Sent message result' } },
          },
        },
        '/api/messages/reply': {
          post: {
            summary: 'Reply to a thread via ID, :1 shortcut, or permalink',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['channel', 'rootId', 'message'],
                    properties: {
                      channel: { type: 'string', example: 'per-fe-an' },
                      rootId: { type: 'string', example: ':1' },
                      message: { type: 'string', example: 'Approved and merged!' },
                      from: { type: 'string', example: 'GitLab CI' },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: 'Reply result' } },
          },
        },
        '/api/cron': {
          get: {
            summary: 'List configured recurring cron jobs',
            responses: { 200: { description: 'Cron job list' } },
          },
        },
        '/api/cron/run': {
          post: {
            summary: 'Manually trigger a cron job run',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['jobName'],
                    properties: { jobName: { type: 'string', example: 'daily-standup' } },
                  },
                },
              },
            },
            responses: { 200: { description: 'Execution result' } },
          },
        },
      },
    };
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.createServer();
      this.server?.listen(this.port, this.host, () => {
        this.logger.info(`Mattermost Web UI & API Gateway running at http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Mattermost HTTP Server stopped.');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

export async function startMattermostHttpServer(options: HttpServerOptions = {}): Promise<MattermostHttpServer> {
  const server = new MattermostHttpServer(options);
  await server.start();
  return server;
}
