import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { MattermostAutomationService } from '../application/mattermost/services/automation-service';
import { loadConfig } from '../config/env';
import { ChannelConfigLoader } from '../infrastructure/mattermost/services/channel-config-loader';
import { ThreadService } from '../infrastructure/mattermost/services/thread-service';

export function createMattermostMcpServer(service?: MattermostAutomationService): Server {
  const automationService = service ?? new MattermostAutomationService({ config: loadConfig() });

  const server = new Server(
    {
      name: 'mattermost-agent',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const TOOLS: Tool[] = [
    {
      name: 'mattermost_whoami',
      description: 'Get current authenticated Mattermost user identity (username, user ID, email, and roles).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'mattermost_list_channels',
      description: 'List all configured and discovered Mattermost channels, including channel names, IDs, team slugs, enabled status, and descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional filter query to search channels by name, description, or team.',
          },
        },
      },
    },
    {
      name: 'mattermost_get_threads',
      description: 'List active threads in a channel with reply counts, last reply timestamps, root message preview, and quick reply index (:1, :2).',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel name, alias, slug (~channel), or 26-character Channel ID.',
          },
          query: {
            type: 'string',
            description: 'Optional keyword to search inside thread messages.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of recent posts to scan for threads (default: 30).',
          },
        },
        required: ['channel'],
      },
    },
    {
      name: 'mattermost_send_message',
      description: 'Send a message to a Mattermost channel under your personal account.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel name, alias, slug (~channel), or 26-character Channel ID.',
          },
          message: {
            type: 'string',
            description: 'Message markdown content to send.',
          },
          from: {
            type: 'string',
            description: 'Optional sender attribution label (e.g. "AI", "GitLab CI") to append "_~ from <label>_".',
          },
          rootId: {
            type: 'string',
            description: 'Optional Root Post ID if replying to a thread.',
          },
        },
        required: ['channel', 'message'],
      },
    },
    {
      name: 'mattermost_reply_thread',
      description: 'Reply to an existing thread in a Mattermost channel. Supports shortcut numbers (:1, :latest), keyword search, permalinks, or post ID.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel name, alias, slug, or ID.',
          },
          message: {
            type: 'string',
            description: 'Reply markdown content to send.',
          },
          rootId: {
            type: 'string',
            description: 'Target thread identifier: shortcut (e.g. ":1", ":latest", ":2"), post permalink URL, or 26-char post ID.',
          },
          find: {
            type: 'string',
            description: 'Keyword query to search for the target thread if rootId is not provided.',
          },
          from: {
            type: 'string',
            description: 'Optional sender attribution label (e.g. "AI", "Agent").',
          },
        },
        required: ['channel', 'message'],
      },
    },
    {
      name: 'mattermost_edit_message',
      description: 'Edit an existing post/message in Mattermost by post ID or permalink URL.',
      inputSchema: {
        type: 'object',
        properties: {
          postId: {
            type: 'string',
            description: 'Post ID (26-character alphanumeric) or permalink URL of the message to edit.',
          },
          message: {
            type: 'string',
            description: 'New updated markdown message content.',
          },
          from: {
            type: 'string',
            description: 'Optional sender attribution label (e.g. "AI", "AI Agent").',
          },
        },
        required: ['postId', 'message'],
      },
    },
    {
      name: 'mattermost_read_channel',
      description: 'Read recent messages and thread replies from a Mattermost channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel name, alias, slug, or ID.',
          },
          limit: {
            type: 'number',
            description: 'Number of recent messages to fetch (default: 20, max: 100).',
          },
        },
        required: ['channel'],
      },
    },
    {
      name: 'mattermost_sync_channels',
      description: 'Auto-discover all accessible channels across all teams from the Mattermost server and save/update channels.yml.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'mattermost_list_cron_jobs',
      description: 'List all configured Mattermost cron jobs, recurring schedules, next execution times, and status.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional search query to filter cron jobs by name, channel, or description.',
          },
        },
      },
    },
    {
      name: 'mattermost_run_cron_job',
      description: 'Trigger a single immediate execution of a configured Mattermost cron job.',
      inputSchema: {
        type: 'object',
        properties: {
          jobName: {
            type: 'string',
            description: 'Name of the cron job to execute.',
          },
        },
        required: ['jobName'],
      },
    },
    {
      name: 'mattermost_toggle_cron_job',
      description: 'Enable or disable a configured Mattermost cron job in cron.yml.',
      inputSchema: {
        type: 'object',
        properties: {
          jobName: {
            type: 'string',
            description: 'Name of the cron job to toggle.',
          },
          enabled: {
            type: 'boolean',
            description: 'Set to true to enable, or false to disable.',
          },
        },
        required: ['jobName', 'enabled'],
      },
    },
    {
      name: 'mattermost_get_thread',
      description: 'Retrieve the complete sequential message thread for a given post permalink URL or 26-character post ID, including user IDs, resolved usernames, timestamps, message content, attachments summary, and reactions.',
      inputSchema: {
        type: 'object',
        properties: {
          permalinkOrId: {
            type: 'string',
            description: 'Permalink URL (e.g. https://mattermost.com/.../pl/postid) or 26-character alphanumeric Post ID.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of posts to return (default: 200). Returns truncated: true if more posts exist.',
          },
        },
        required: ['permalinkOrId'],
      },
    },
    {
      name: 'mattermost_get_mentions',
      description: 'Retrieve recent posts mentioning the authenticated user, including user IDs, usernames, timestamps, message snippets, and whether you have already replied in the thread.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'number',
            description: 'Optional timestamp in milliseconds to filter mentions after (default: last 24 hours).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of mentions to return (default: 50).',
          },
          teamId: {
            type: 'string',
            description: 'Optional team ID to restrict search.',
          },
        },
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'mattermost_whoami': {
          const user = await automationService.whoami();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    roles: user.roles,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_list_channels': {
          const query = typeof args.query === 'string' ? args.query.toLowerCase() : undefined;
          const configLoader = new ChannelConfigLoader();
          const mappings = configLoader.getAllMappings();

          let filtered = mappings;
          if (query) {
            filtered = mappings.filter(
              (m) =>
                m.alias.toLowerCase().includes(query) ||
                m.channel.toLowerCase().includes(query) ||
                (m.description && m.description.toLowerCase().includes(query)) ||
                (m.team && m.team.toLowerCase().includes(query))
            );
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    total: filtered.length,
                    channels: filtered.map((c) => ({
                      alias: c.alias,
                      channel: c.channel,
                      team: c.team,
                      enabled: c.enabled,
                      description: c.description,
                      defaultRootId: c.defaultRootId,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_get_threads': {
          const channel = String(args.channel);
          const limit = typeof args.limit === 'number' ? args.limit : 30;
          const query = typeof args.query === 'string' ? args.query : undefined;

          const result = await automationService.getThreads({
            channel,
            limit,
            query,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    channel: result.channel.name,
                    channelId: result.channel.id,
                    totalThreads: result.threads.length,
                    threads: result.threads.map((t) => ({
                      index: t.index,
                      shortcut: `:${t.index}`,
                      rootId: t.rootId,
                      authorId: t.authorId,
                      message: t.fullMessage,
                      messageSnippet: t.messageSnippet,
                      replyCount: t.replyCount,
                      relativeTime: t.relativeTime,
                      lastReplySnippet: t.lastReplySnippet,
                      lastReplyRelativeTime: t.lastReplyRelativeTime,
                      lastReplyAuthorId: t.lastReplyAuthorId,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_send_message': {
          const channel = String(args.channel);
          const message = String(args.message);
          const from = typeof args.from === 'string' ? args.from : undefined;
          const rootId = typeof args.rootId === 'string' ? args.rootId : undefined;

          const result = await automationService.sendMessage({
            channel,
            message,
            from,
            rootId,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    messageId: result.id,
                    channelId: result.channelId,
                    userId: result.userId,
                    rootId: result.rootId,
                    createdAt: result.createdAt.toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_reply_thread': {
          const channel = String(args.channel);
          const message = String(args.message);
          const from = typeof args.from === 'string' ? args.from : undefined;
          let rootId = typeof args.rootId === 'string' ? args.rootId : undefined;

          if (!rootId && typeof args.find === 'string') {
            rootId = `find:${args.find}`;
          }

          if (!rootId) {
            rootId = ':1'; // Default to most recent thread if none specified
          }

          const result = await automationService.replyToMessage({
            channel,
            rootId,
            message,
            from,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    messageId: result.id,
                    channelId: result.channelId,
                    rootId: result.rootId,
                    createdAt: result.createdAt.toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_edit_message': {
          const postId = String(args.postId);
          const message = String(args.message);
          const from = typeof args.from === 'string' ? args.from : undefined;

          const actionResult = await automationService.executeAction({
            action: 'edit_message',
            postId,
            message,
            from,
          });

          if (!actionResult.success) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Error editing message: ${actionResult.error?.message || 'Unknown error'}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(actionResult.data, null, 2),
              },
            ],
          };
        }

        case 'mattermost_read_channel': {
          const channel = String(args.channel);
          const limit = typeof args.limit === 'number' ? args.limit : 20;

          const { channel: chanInfo, messages } = await automationService.readChannel({
            channel,
            limit,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    channel: {
                      id: chanInfo.id,
                      name: chanInfo.name,
                      displayName: chanInfo.displayName,
                    },
                    messagesCount: messages.length,
                    messages: messages.map((m) => ({
                      id: m.id,
                      userId: m.userId,
                      message: m.message,
                      rootId: m.rootId,
                      createdAt: new Date(m.createAt).toISOString(),
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_sync_channels': {
          const result = await automationService.syncChannels();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    filePath: result.filePath,
                    totalDiscovered: result.totalDiscovered,
                    enabledCount: result.enabledCount,
                    disabledCount: result.disabledCount,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_list_cron_jobs': {
          const query = typeof args.query === 'string' ? args.query.toLowerCase() : undefined;
          const jobs = automationService.listCronJobs();

          let filtered = jobs;
          if (query) {
            filtered = jobs.filter(
              (j) =>
                j.name.toLowerCase().includes(query) ||
                j.channel.toLowerCase().includes(query) ||
                (j.description && j.description.toLowerCase().includes(query))
            );
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    total: filtered.length,
                    jobs: filtered,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_run_cron_job': {
          const jobName = String(args.jobName);
          const result = await automationService.runCronJob(jobName);

          if (!result.success) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Failed to execute cron job '${jobName}': ${result.error}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    jobName,
                    messageId: result.messageId,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_toggle_cron_job': {
          const jobName = String(args.jobName);
          const enabled = Boolean(args.enabled);
          const success = automationService.toggleCronJob(jobName, enabled);

          if (!success) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Cron job '${jobName}' was not found in configuration.`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    jobName,
                    enabled,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'mattermost_get_thread': {
          const permalinkOrId = String(args.permalinkOrId || args.postId || '');
          const limit = typeof args.limit === 'number' ? args.limit : undefined;

          const result = await automationService.getThread(permalinkOrId, limit);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'mattermost_get_mentions': {
          const since = typeof args.since === 'number' ? args.since : undefined;
          const limit = typeof args.limit === 'number' ? args.limit : undefined;
          const teamId = typeof args.teamId === 'string' ? args.teamId : undefined;

          const result = await automationService.getMentions({ since, limit, teamId });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
          };
      }
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Mattermost error [${error.code || 'ERROR'}]: ${error.message}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function runStdioMcpServer(): Promise<void> {
  const server = createMattermostMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
