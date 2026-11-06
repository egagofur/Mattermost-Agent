#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import { MattermostAutomationService } from '../application/mattermost/services/automation-service';
import { loadConfig, MattermostConfig } from '../config/env';
import { MattermostError } from '../domain/mattermost/errors';
import { ChannelConfigLoader } from '../infrastructure/mattermost/services/channel-config-loader';
import { ThreadService } from '../infrastructure/mattermost/services/thread-service';

const program = new Command();

program
  .name('mattermost')
  .description('Personal Account Automation CLI for Mattermost (Playwright & API)')
  .version('1.0.0')
  .option('--json', 'Output results in structured JSON format', false)
  .option('-u, --url <url>', 'Mattermost server URL override')
  .option('-t, --token <token>', 'Personal Access Token override')
  .option('-p, --provider <provider>', 'Provider override ("api" | "playwright")')
  .option('--team-id <teamId>', 'Team ID override')
  .option('--channels-config <path>', 'Custom channels YAML config path')
  .option('--env <environment>', 'Active environment overlay (e.g. dev, staging, prod)');

function getService(overrides: Partial<MattermostConfig> = {}): MattermostAutomationService {
  const globalOpts = program.opts();
  if (globalOpts.url) overrides.MATTERMOST_URL = globalOpts.url;
  if (globalOpts.token) overrides.MATTERMOST_TOKEN = globalOpts.token;
  if (globalOpts.provider) overrides.MATTERMOST_PROVIDER = globalOpts.provider;
  if (globalOpts.teamId) overrides.MATTERMOST_TEAM_ID = globalOpts.teamId;
  if (globalOpts.channelsConfig) overrides.MATTERMOST_CHANNELS_CONFIG = globalOpts.channelsConfig;
  if (globalOpts.env) overrides.MATTERMOST_ENV = globalOpts.env;

  try {
    const config = loadConfig(overrides);
    return new MattermostAutomationService({ config });
  } catch (err) {
    console.error(`\n❌ Configuration Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

function handleOutput(data: unknown, jsonMode = false): void {
  if (jsonMode || program.opts().json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function handleError(err: unknown): void {
  const isJson = program.opts().json;
  if (err instanceof MattermostError) {
    if (isJson) {
      console.error(
        JSON.stringify(
          { success: false, error: { code: err.code, message: err.message, details: err.details } },
          null,
          2
        )
      );
    } else {
      console.error(`\n❌ Error [${err.code}]: ${err.message}`);
      if (err.details && Object.keys(err.details).length > 0) {
        console.error(`   Details:`, err.details);
      }
      if (err.code === 'CHANNEL_DISABLED') {
        const chan = (err.details?.channelIdentifier || err.details?.alias || 'channel') as string;
        console.error(`\n💡 Tip: Run 'npm run cli -- enable ${chan}' to enable this channel.`);
      } else if (err.code === 'CHANNEL_NOT_FOUND') {
        console.error(`\n💡 Tip: Run 'npm run cli -- sync' to auto-discover all accessible channels.`);
      } else if (err.code === 'AUTH_FAILED') {
        console.error(`\n💡 Tip: Run 'npm run cli -- login' to authenticate your browser session.`);
      }
      console.error('');
    }
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.error(JSON.stringify({ success: false, error: { code: 'UNEXPECTED_ERROR', message: msg } }, null, 2));
    } else {
      console.error(`\n❌ Unexpected Error: ${msg}\n`);
    }
  }
  process.exit(1);
}

// whoami
program
  .command('whoami')
  .description('Verify personal identity and display current account')
  .action(async () => {
    const service = getService();
    try {
      const user = await service.whoami();
      if (program.opts().json) {
        handleOutput(user, true);
      } else {
        console.log('\n✅ Mattermost Identity Verified');
        console.log(`   User ID:   ${user.id}`);
        console.log(`   Username:  ${user.username}`);
        if (user.firstName || user.lastName) {
          console.log(`   Name:      ${[user.firstName, user.lastName].filter(Boolean).join(' ')}`);
        }
        if (user.email) {
          console.log(`   Email:     ${user.email}`);
        }
        if (user.roles) {
          console.log(`   Roles:     ${user.roles}`);
        }
        console.log('');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// send
program
  .command('send [channel] [message]')
  .description('Send a message to a channel as personal user (e.g. `mattermost send per-fe-an "Hello" --from "AI"`)')
  .option('-c, --channel <channel>', 'Channel name, slug, or ID')
  .option('-m, --message <message>', 'Message body to send')
  .option('--from <sender>', 'Sender attribution label (e.g. "AI" -> "_~ from AI_")')
  .option('--no-from', 'Suppress sender attribution footer')
  .option('-r, --root-id <rootId>', 'Root ID to reply inside a thread')
  .option('--team <teamId>', 'Team ID or slug')
  .option('--idempotency-key <key>', 'Custom idempotency key to avoid duplicate sends')
  .action(async (posChannel, posMessage, opts) => {
    const targetChannel = posChannel || opts.channel;
    const targetMessage = posMessage || opts.message;

    if (!targetChannel || !targetMessage) {
      console.error('\n❌ Error: Channel and Message are required.');
      console.error('   Usage: npm run cli -- send <channel> "<message>" [--from "AI"]');
      console.error('   Or:    npm run cli -- send -c <channel> -m "<message>"\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const fromLabel = opts.from === false ? '' : opts.from;
      const result = await service.sendMessage({
        channel: targetChannel,
        message: targetMessage,
        from: fromLabel,
        rootId: opts.rootId,
        teamId: opts.team,
        idempotencyKey: opts.idempotencyKey,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log('\n✅ Message sent successfully');
        console.log(`   Message ID:  ${result.id}`);
        console.log(`   Channel ID:  ${result.channelId}`);
        console.log(`   User ID:     ${result.userId}`);
        if (result.rootId) console.log(`   Root ID:     ${result.rootId}`);
        console.log(`   Created At:  ${result.createdAt.toISOString()}`);
        console.log('');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// reply
program
  .command('reply [channel] [rootId] [message]')
  .description('Reply to a message thread (e.g. `mattermost reply per-fe-an :1 "Reply text" --from "AI"`)')
  .option('-c, --channel <channel>', 'Channel name, slug, or ID')
  .option('-r, --root-id <rootId>', 'Root thread ID, permalink URL, or shortcut (:1, :latest, :last)')
  .option('-f, --find <keyword>', 'Find thread matching keyword (e.g. -f "Standup")')
  .option('--from <sender>', 'Sender attribution label (e.g. "AI" -> "_~ from AI_")')
  .option('--no-from', 'Suppress sender attribution footer')
  .option('--last', 'Reply to the last message sent in this session')
  .option('-m, --message <message>', 'Message body to send')
  .option('--team <teamId>', 'Team ID or slug')
  .option('--idempotency-key <key>', 'Custom idempotency key')
  .action(async (posChannel, posRootId, posMessage, opts) => {
    let targetChannel = posChannel || opts.channel;
    let targetRootId = posRootId || opts.rootId;
    let targetMessage = posMessage || opts.message;

    // Support: mattermost reply --last "My message" or mattermost reply <channel> --last "My message"
    if (opts.last || targetChannel === ':last' || targetChannel === '--last' || targetChannel === 'last') {
      const threadService = new ThreadService(null as any);
      const lastState = threadService.getLastThread();
      if (!targetMessage && (posRootId || posChannel)) {
        targetMessage = posRootId || posChannel;
      }
      targetRootId = ':last';
      if (!targetChannel || targetChannel === ':last' || targetChannel === '--last' || targetChannel === 'last') {
        targetChannel = lastState?.channelId;
      }
    }

    // Support: mattermost reply <channel> -f "Standup" "My message"
    if (opts.find) {
      targetRootId = `find:${opts.find}`;
      if (!targetMessage && posRootId) {
        targetMessage = posRootId;
      }
    }

    // Support: permalink URL as first argument
    if (targetChannel && targetChannel.startsWith('http')) {
      const extracted = ThreadService.extractPostIdFromPermalink(targetChannel);
      if (extracted) {
        targetRootId = extracted;
        targetMessage = posRootId || posMessage || opts.message;
        if (opts.channel) {
          targetChannel = opts.channel;
        } else {
          // Resolve actual channel from the thread itself instead of guessing
          const tempService = getService();
          try {
            const threadView = await tempService.getThread(extracted);
            targetChannel = threadView.channelId;
          } catch {
            targetChannel = '';
          } finally {
            await tempService.close();
          }
        }
      }
    }

    if (!targetChannel || !targetRootId || !targetMessage) {
      console.error('\n❌ Error: Channel, Thread Target, and Message are required.');
      console.error('   Usage:');
      console.error('     • By shortcut:  npm run reply -- <channel> :1 "<message>" [--from "AI"]');
      console.error('     • By keyword:   npm run reply -- <channel> --find "<keyword>" "<message>"');
      console.error('     • By post ID:   npm run reply -- <channel> <rootId> "<message>"');
      console.error('     • To last post: npm run reply -- <channel> --last "<message>"\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const fromLabel = opts.from === false ? '' : opts.from;
      const result = await service.replyToMessage({
        channel: targetChannel,
        rootId: targetRootId,
        message: targetMessage,
        from: fromLabel,
        teamId: opts.team,
        idempotencyKey: opts.idempotencyKey,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log('\n✅ Thread reply sent successfully');
        console.log(`   Message ID:  ${result.id}`);
        console.log(`   Root ID:     ${result.rootId}`);
        console.log(`   Channel ID:  ${result.channelId}`);
        console.log(`   Created At:  ${result.createdAt.toISOString()}`);
        console.log('');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// edit
program
  .command('edit <postIdOrPermalink> <message>')
  .description('Edit an existing post/message in Mattermost by post ID or permalink URL')
  .option('--from <sender>', 'Sender attribution label (e.g. "AI" -> "_~ from AI_")')
  .option('--no-from', 'Suppress sender attribution footer')
  .action(async (postIdOrPermalink, message, opts) => {
    if (!postIdOrPermalink || !message) {
      console.error('\n❌ Error: Post ID/Permalink and Message are required.');
      console.error('   Usage: mattermost edit <postIdOrPermalink> "<message>" [--from "AI Agent"]\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const fromLabel = opts.from === false ? '' : opts.from;
      const result = await service.editMessage({
        postId: postIdOrPermalink,
        message,
        from: fromLabel,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log('\n✅ Message edited successfully');
        console.log(`   Message ID:  ${result.id}`);
        console.log(`   Channel ID:  ${result.channelId}`);
        console.log(`   User ID:     ${result.userId}`);
        console.log(`   Updated At:  ${result.updatedAt.toISOString()}`);
        console.log('');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// threads (Thread Inspector)
program
  .command('threads [channel] [query]')
  .description('List and search active threads in a channel')
  .option('-l, --limit <limit>', 'Number of posts to scan (max 100)', '50')
  .option('--team <teamId>', 'Team ID or slug')
  .action(async (channelArg, queryArg, opts) => {
    if (!channelArg) {
      console.error('\n❌ Error: Channel is required.');
      console.error('   Usage: npm run threads -- <channel> [search_query]\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const result = await service.getThreads({
        channel: channelArg,
        limit: parseInt(opts.limit, 10),
        query: queryArg,
        teamId: opts.team,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        const { channel, threads } = result;
        const queryLabel = queryArg ? ` matching '${queryArg}'` : '';
        console.log(`\n🧵 Active Threads in #${channel.displayName} (${threads.length} threads${queryLabel}):`);
        console.log('-----------------------------------------------------------------------------------------');

        if (threads.length === 0) {
          console.log(`   No active threads found in #${channel.displayName}.`);
        } else {
          for (const t of threads) {
            const repliesText = t.replyCount === 1 ? '1 reply' : `${t.replyCount} replies`;
            console.log(`[${t.index}] ${t.rootId} • ${t.relativeTime} • (${repliesText})`);
            console.log(`    "${t.messageSnippet}"`);
            if (t.lastReplySnippet) {
              console.log(`    ↳ Last reply (${t.lastReplyRelativeTime}): "${t.lastReplySnippet}"`);
            }
            console.log('');
          }
        }

        console.log('-----------------------------------------------------------------------------------------');
        console.log('💡 Quick Reply Shortcuts:');
        console.log(`   • Reply to latest:   npm run reply -- ${channel.name} :1 "<your message>"`);
        console.log(`   • Reply by keyword:  npm run reply -- ${channel.name} --find "<keyword>" "<your message>"\n`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// thread (Read full thread sequentially)
program
  .command('thread <permalinkOrId>')
  .description('Read entire sequential thread by post ID or permalink URL')
  .option('-l, --limit <limit>', 'Maximum number of posts to fetch (default: 200)', '200')
  .action(async (permalinkOrId, opts) => {
    if (!permalinkOrId) {
      console.error('\n❌ Error: Post ID or permalink URL is required.');
      console.error('   Usage: npm run -s cli -- thread <permalinkOrId> [--limit 200] [--json]\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const limit = parseInt(opts.limit, 10);
      const result = await service.getThread(permalinkOrId, isNaN(limit) ? 200 : limit);

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n🧵 Thread: ${result.rootId} (Channel: ${result.channelId})`);
        console.log(`   Total Posts: ${result.totalPosts}${result.truncated ? ' (Truncated: true)' : ''}\n`);

        result.posts.forEach((p, idx) => {
          const time = ThreadService.formatRelativeTime(p.createAt);
          const author = p.username ? `@${p.username}` : p.userId;
          console.log(`[${idx + 1}/${result.posts.length}] ${author} (${time}):`);
          console.log(`   ${p.message.replace(/\n/g, '\n   ')}`);
          if (p.files && p.files.length > 0) {
            const fileList = p.files.map((f) => f.name).join(', ');
            console.log(`   📎 Files: ${fileList}`);
          }
          if (p.reactions && p.reactions.length > 0) {
            const reactionList = p.reactions.map((r) => `:${r.emojiName}:`).join(' ');
            console.log(`   ✨ Reactions: ${reactionList}`);
          }
          console.log('');
        });
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// mentions
program
  .command('mentions')
  .description('List recent posts mentioning your account')
  .option('-s, --since <since>', 'Filter mentions since duration or timestamp (e.g. 24h, 7d, 1h)', '24h')
  .option('-l, --limit <limit>', 'Maximum number of mentions to return (default: 50)', '50')
  .option('--team <teamId>', 'Team ID or slug')
  .action(async (opts) => {
    const service = getService();
    try {
      let sinceMs: number | undefined;
      if (opts.since) {
        const rawSince = String(opts.since).trim().toLowerCase();
        const durationMatch = rawSince.match(/^(\d+)(h|d|m)$/);
        if (durationMatch) {
          const num = parseInt(durationMatch[1], 10);
          const unit = durationMatch[2];
          const multiplier = unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 60000;
          sinceMs = Date.now() - num * multiplier;
        } else if (/^\d+$/.test(rawSince)) {
          sinceMs = parseInt(rawSince, 10);
        }
      }

      const limit = parseInt(opts.limit, 10);
      const result = await service.getMentions({
        since: sinceMs,
        limit: isNaN(limit) ? 50 : limit,
        teamId: opts.team,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n🔔 Mentions: Found ${result.total} post(s) mentioning you\n`);
        if (result.mentions.length === 0) {
          console.log('   No mentions found in the specified timeframe.\n');
          return;
        }

        result.mentions.forEach((m, idx) => {
          const status = m.hasReplied ? '✅ REPLIED' : '⏳ UNREPLIED';
          const time = ThreadService.formatRelativeTime(m.createAt);
          const author = m.username ? `@${m.username}` : m.userId;
          console.log(`[${idx + 1}] [${status}] ${author} in #${m.channelName || m.channelId} (${time}):`);
          console.log(`    ${m.message.replace(/\n/g, '\n    ')}`);
          console.log(`    Post ID: ${m.id} | Root ID: ${m.rootId || m.id}\n`);
        });
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// search
program
  .command('search [terms...]')
  .description('Search posts across accessible channels with optional user, channel, and date filters')
  .option('-f, --from <user>', 'Filter by author username')
  .option('-c, --in <channel>', 'Filter by channel name')
  .option('-a, --after <date>', 'Filter after date (YYYY-MM-DD)')
  .option('-b, --before <date>', 'Filter before date (YYYY-MM-DD)')
  .option('-l, --limit <limit>', 'Maximum number of results to return (default: 20)', '20')
  .option('--team <teamId>', 'Team ID or slug')
  .action(async (termsArray, opts) => {
    const rawTerms = Array.isArray(termsArray) ? termsArray.join(' ') : termsArray || '';
    const service = getService();
    try {
      const limit = parseInt(opts.limit, 10);
      const result = await service.search({
        terms: rawTerms || undefined,
        from: opts.from,
        in: opts.in,
        after: opts.after,
        before: opts.before,
        limit: isNaN(limit) ? 20 : limit,
        teamId: opts.team,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n🔍 Search Results: Found ${result.total} post(s) for query: "${result.query}"\n`);
        if (result.posts.length === 0) {
          console.log('   No matching posts found.\n');
          return;
        }

        result.posts.forEach((p, idx) => {
          const time = ThreadService.formatRelativeTime(p.createAt);
          const author = p.username ? `@${p.username}` : p.userId;
          console.log(`[${idx + 1}/${result.posts.length}] ${author} in #${p.channelId} (${time}):`);
          console.log(`   ${p.message.replace(/\n/g, '\n   ')}`);
          console.log(`   Post ID: ${p.id}${p.rootId ? ` | Root ID: ${p.rootId}` : ''}\n`);
        });
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// unread
program
  .command('unread')
  .description('Summarize all channels with unread messages or mentions')
  .action(async () => {
    const service = getService();
    try {
      const result = await service.getUnreadSummary();

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n📬 Unread Channels: ${result.totalUnreadChannels} channel(s) with unread messages/mentions\n`);
        if (result.channels.length === 0) {
          console.log('   All caught up! No unread messages or mentions.\n');
          return;
        }

        result.channels.forEach((c, idx) => {
          const mentionBadge = c.hasMention ? `🔴 ${c.mentionCount} MENTION(S)` : '⚪';
          console.log(`[${idx + 1}] #${c.displayName || c.channelName} (${c.channelId}):`);
          console.log(`    Unread Messages: ${c.unreadCount} | ${mentionBadge}\n`);
        });
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// post
program
  .command('post <postIdOrPermalink>')
  .description('View a single post with surrounding contextual messages in the channel')
  .option('-c, --context <number>', 'Number of messages before and after to include (default: 3)', '3')
  .action(async (postIdOrPermalink, opts) => {
    const service = getService();
    try {
      const contextCount = parseInt(opts.context, 10);
      const result = await service.getPostWithContext(postIdOrPermalink, isNaN(contextCount) ? 3 : contextCount);
      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n📌 Post View with Channel Context (${result.totalContextPosts} context posts)\n`);
        if (result.before.length > 0) {
          console.log('--- Previous Messages ---');
          result.before.forEach((p) => {
            const author = p.username ? `@${p.username}` : p.userId;
            const time = ThreadService.formatRelativeTime(p.createAt);
            console.log(`[${time}] ${author}: ${p.message}`);
          });
          console.log('');
        }

        console.log('>>> TARGET POST <<<');
        const targetAuthor = result.post.username ? `@${result.post.username}` : result.post.userId;
        const targetTime = ThreadService.formatRelativeTime(result.post.createAt);
        console.log(`ID:      ${result.post.id}`);
        console.log(`Author:  ${targetAuthor}`);
        console.log(`Time:    ${targetTime}`);
        console.log(`Message:\n${result.post.message}\n`);

        if (result.after.length > 0) {
          console.log('--- Following Messages ---');
          result.after.forEach((p) => {
            const author = p.username ? `@${p.username}` : p.userId;
            const time = ThreadService.formatRelativeTime(p.createAt);
            console.log(`[${time}] ${author}: ${p.message}`);
          });
          console.log('');
        }
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// user
program
  .command('user <usernameOrId>')
  .description('Lookup user profile, roles, and position by username or user ID')
  .action(async (usernameOrId) => {
    const service = getService();
    try {
      const result = await service.getUser(usernameOrId);
      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log('\n👤 Mattermost User Profile');
        console.log(`   ID:        ${result.id}`);
        console.log(`   Username:  @${result.username}`);
        if (result.firstName || result.lastName) {
          console.log(`   Name:      ${[result.firstName, result.lastName].filter(Boolean).join(' ')}`);
        }
        if (result.nickname) console.log(`   Nickname:  ${result.nickname}`);
        if (result.position) console.log(`   Position:  ${result.position}`);
        if (result.email) console.log(`   Email:     ${result.email}`);
        if (result.roles) console.log(`   Roles:     ${result.roles}`);
        console.log('');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// channel
program
  .command('channel')
  .description('Look up and resolve a channel by name or ID')
  .argument('<channel>', 'Channel name, slug, or ID')
  .option('--team <teamId>', 'Team ID or slug')
  .action(async (channelArg, opts) => {
    const service = getService();
    try {
      const channel = await service.getChannel(channelArg, opts.team);
      if (program.opts().json) {
        handleOutput(channel, true);
      } else {
        console.log('\n📁 Mattermost Channel Details');
        console.log(`   ID:           ${channel.id}`);
        console.log(`   Name:         ${channel.name}`);
        console.log(`   Display Name: ${channel.displayName}`);
        console.log(`   Type:         ${channel.type}`);
        if (channel.header) console.log(`   Header:       ${channel.header}`);
        if (channel.purpose) console.log(`   Purpose:      ${channel.purpose}`);
        console.log('');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// read
program
  .command('read')
  .description('Read recent messages from a channel')
  .argument('<channel>', 'Channel name, slug, or ID')
  .option('-l, --limit <limit>', 'Number of messages to retrieve (max 100)', '10')
  .option('--since <timestamp>', 'Retrieve posts created after epoch timestamp ms')
  .option('--team <teamId>', 'Team ID or slug')
  .action(async (channelArg, opts) => {
    const service = getService();
    try {
      const result = await service.readChannel({
        channel: channelArg,
        limit: parseInt(opts.limit, 10),
        since: opts.since ? parseInt(opts.since, 10) : undefined,
        teamId: opts.team,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n💬 Recent messages in #${result.channel.displayName} (${result.messages.length} posts):`);
        console.log('-------------------------------------------------------------');
        for (const msg of result.messages) {
          const dateStr = new Date(msg.createAt).toLocaleTimeString();
          console.log(`[${dateStr}] [${msg.userId}]: ${msg.message}`);
          if (msg.rootId) console.log(`   ↳ (thread reply to ${msg.rootId})`);
        }
        console.log('-------------------------------------------------------------\n');
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// action (JSON input / agent execution)
program
  .command('action')
  .description('Execute a domain action directly via JSON argument or stdin')
  .argument('[jsonPayload]', 'Action payload as JSON string')
  .action(async (jsonArg) => {
    const service = getService();
    try {
      let rawJson = jsonArg;

      if (!rawJson) {
        // Read from stdin
        rawJson = fs.readFileSync(0, 'utf-8');
      }

      const payload = JSON.parse(rawJson);
      const actionResult = await service.executeAction(payload);
      handleOutput(actionResult, true);

      if (!actionResult.success) {
        process.exit(1);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// enable
program
  .command('enable <channel>')
  .description('Enable a channel in channels.yml (allow sending messages)')
  .action(async (channel) => {
    const service = getService();
    try {
      const ok = service.toggleChannel(channel, true);
      if (ok) {
        console.log(`\n🟢 Channel '${channel}' is now [ENABLED] in channels.yml\n`);
      } else {
        console.log(`\n❌ Channel '${channel}' was not found in channels.yml.`);
        console.log(`💡 Run 'npm run cli -- sync' to auto-discover channels first.\n`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// disable
program
  .command('disable <channel>')
  .description('Disable a channel in channels.yml (prevent sending messages)')
  .action(async (channel) => {
    const service = getService();
    try {
      const ok = service.toggleChannel(channel, false);
      if (ok) {
        console.log(`\n⚪ Channel '${channel}' is now [DISABLED] in channels.yml\n`);
      } else {
        console.log(`\n❌ Channel '${channel}' was not found in channels.yml.\n`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// sync / discover
program
  .command('sync')
  .alias('discover')
  .description('Auto-discover all accessible Mattermost channels and generate/update channels.yml')
  .option('-o, --output <file>', 'Output YAML file path', 'channels.yml')
  .option('--disable-all', 'Set all newly discovered channels to enabled: false')
  .option('--no-merge', 'Do not merge with existing channels.yml (overwrite)')
  .action(async (opts) => {
    const service = getService();
    try {
      console.log('\n🔍 Discovering all accessible channels from Mattermost...');
      const result = await service.syncChannels({
        filePath: opts.output,
        defaultEnabled: !opts.disableAll,
        mergeExisting: opts.merge,
      });

      if (program.opts().json) {
        handleOutput(result, true);
      } else {
        console.log(`\n✅ Channels Synchronized Successfully!`);
        console.log(`   File:       ${result.filePath}`);
        console.log(`   Discovered: ${result.totalDiscovered} channels across ${result.totalTeams} team(s)`);
        console.log(`   Status:     ${result.enabledCount} enabled, ${result.disabledCount} disabled\n`);
        console.log('-------------------------------------------------------------');
        for (const m of result.mappings) {
          const statusIcon = m.enabled ? '🟢 [ENABLED] ' : '⚪ [DISABLED]';
          const teamInfo = m.team ? ` (team: ${m.team})` : '';
          console.log(`   ${statusIcon} ${m.alias.padEnd(25)} ➔ #${m.channel}${teamInfo}`);
        }
        console.log('-------------------------------------------------------------');
        console.log(`💡 You can now easily toggle 'enabled: true/false' or use 'mattermost enable/disable <channel>'.\n`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// login (Playwright interactive setup)
program
  .command('login')
  .description('Open browser window for one-time manual login (Playwright provider)')
  .action(async () => {
    const service = getService({ MATTERMOST_PROVIDER: 'playwright', MATTERMOST_HEADLESS: false });
    try {
      await service.interactiveLogin();

      // Post-login automatic channel discovery
      console.log('\n🔄 Automatically discovering accessible channels...');
      try {
        const syncResult = await service.syncChannels();
        console.log(`✅ Auto-generated channels.yml with ${syncResult.totalDiscovered} channels!`);
      } catch (syncErr) {
        console.log(`ℹ️ You can run 'mattermost sync' anytime to discover channels.`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

// channels / aliases / list
program
  .command('channels [query]')
  .alias('aliases')
  .alias('list')
  .alias('channels-map')
  .description('List and search configured channels in channels.yml')
  .action(async (query) => {
    try {
      const globalOpts = program.opts();
      const configLoader = new ChannelConfigLoader({
        configPath: globalOpts.channelsConfig || process.env.MATTERMOST_CHANNELS_CONFIG,
        envName: globalOpts.env || process.env.MATTERMOST_ENV,
      });

      let aliases = configLoader.getAllMappings();
      if (query) {
        const q = query.toLowerCase();
        aliases = aliases.filter(
          (a) =>
            a.alias.toLowerCase().includes(q) ||
            a.channel.toLowerCase().includes(q) ||
            (a.displayName && a.displayName.toLowerCase().includes(q)) ||
            (a.description && a.description.toLowerCase().includes(q))
        );
      }

      if (program.opts().json) {
        handleOutput(aliases, true);
      } else {
        const total = configLoader.getAllMappings().length;
        console.log(`\n📋 Mattermost Channels (${aliases.length} of ${total} channels${query ? ` matching '${query}'` : ''}):`);
        if (configLoader.getDefaultTeam()) {
          console.log(`   Default Team:     ${configLoader.getDefaultTeam()}`);
        }
        if (configLoader.getFallbackChannel()) {
          console.log(`   Fallback Channel: #${configLoader.getFallbackChannel()}`);
        }
        console.log('-------------------------------------------------------------------------------');
        if (aliases.length === 0) {
          console.log('   No matching channels found. Run `mattermost sync` to fetch channels.');
        } else {
          for (const a of aliases) {
            const status = a.enabled ? '🟢' : '⚪';
            const team = a.team ? `[team: ${a.team.slice(0, 8)}]` : '';
            const desc = a.description ? ` - ${a.description.split('\n')[0].slice(0, 45)}` : '';
            console.log(`   ${status} ${a.alias.padEnd(28)} ➔ #${a.channel.padEnd(28)} ${team}${desc}`);
          }
        }
        console.log('-------------------------------------------------------------------------------');
        console.log('💡 Quick Commands:');
        console.log('   • Send:    npm run cli -- send <channel> "<message>"');
        console.log('   • Toggle:  npm run cli -- enable <channel>  |  npm run cli -- disable <channel>\n');
      }
    } catch (err) {
      handleError(err);
    }
  });

// cron command group
const cronCmd = program
  .command('cron')
  .description('Manage and run scheduled Mattermost automation cron jobs');

cronCmd
  .command('start')
  .description('Start the cron scheduler daemon process to run recurring jobs')
  .action(() => {
    console.log('\n🚀 Starting Mattermost Cron Scheduler Daemon...');
    const service = getService();
    service.startCronScheduler(true);
    console.log('   Scheduler is active. Press Ctrl+C to stop.\n');
  });

cronCmd
  .command('list [query]')
  .description('List configured cron jobs, schedules, next execution times, and status')
  .action((query) => {
    const service = getService();
    const jobs = service.listCronJobs();
    let filtered = jobs;
    if (query) {
      const q = query.toLowerCase();
      filtered = jobs.filter(
        (j) =>
          j.name.toLowerCase().includes(q) ||
          j.channel.toLowerCase().includes(q) ||
          (j.description && j.description.toLowerCase().includes(q))
      );
    }

    if (program.opts().json) {
      handleOutput(filtered, true);
    } else {
      console.log(`\n⏰ Scheduled Cron Jobs (${filtered.length} jobs):`);
      console.log('-------------------------------------------------------------------------------------------------');
      if (filtered.length === 0) {
        console.log('   No cron jobs configured. Check `cron.example.yml` and create `cron.yml`.');
      } else {
        for (const j of filtered) {
          const statusIcon = j.enabled ? '🟢' : '⚪';
          const nextRun = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : (j.enabled ? 'Calculating...' : 'Disabled');
          const lastStatus = j.lastStatus === 'success' ? '✅' : j.lastStatus === 'failed' ? '❌' : '⏳';
          console.log(`   ${statusIcon} [${j.name}]`);
          console.log(`      Schedule:    ${j.schedule} (${j.timezone})`);
          console.log(`      Channel:     #${j.channel} ${j.from ? `(from: ${j.from})` : ''}`);
          console.log(`      Next Run:    ${nextRun}`);
          console.log(`      Last Run:    ${j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'Never'} [${lastStatus} ${j.lastStatus}] (Total runs: ${j.executionCount})`);
          if (j.description) console.log(`      Description: ${j.description}`);
          console.log('');
        }
      }
      console.log('-------------------------------------------------------------------------------------------------');
      console.log('💡 Quick Commands:');
      console.log('   • Start Daemon:  npm run cron:start');
      console.log('   • Trigger Once:  npm run cli -- cron run <job_name>');
      console.log('   • Toggle:        npm run cli -- cron enable <job_name> | cron disable <job_name>\n');
    }
  });

cronCmd
  .command('run <jobName>')
  .description('Trigger a single immediate test run of a configured cron job')
  .action(async (jobName) => {
    const service = getService();
    console.log(`\n⏳ Triggering cron job '${jobName}' immediately...`);
    try {
      const result = await service.runCronJob(jobName);
      if (result.success) {
        console.log(`\n✅ Cron job '${jobName}' executed successfully!`);
        if (result.messageId) console.log(`   Message ID: ${result.messageId}`);
        console.log('');
      } else {
        console.error(`\n❌ Cron job '${jobName}' failed: ${result.error}\n`);
        process.exit(1);
      }
    } catch (err) {
      handleError(err);
    } finally {
      await service.close();
    }
  });

cronCmd
  .command('enable <jobName>')
  .description('Enable a cron job in cron.yml')
  .action((jobName) => {
    const service = getService();
    const success = service.toggleCronJob(jobName, true);
    if (success) {
      console.log(`\n🟢 Enabled cron job '${jobName}' in cron.yml\n`);
    } else {
      console.error(`\n❌ Job '${jobName}' was not found in cron configuration.\n`);
      process.exit(1);
    }
  });

cronCmd
  .command('disable <jobName>')
  .description('Disable a cron job in cron.yml')
  .action((jobName) => {
    const service = getService();
    const success = service.toggleCronJob(jobName, false);
    if (success) {
      console.log(`\n⚪ Disabled cron job '${jobName}' in cron.yml\n`);
    } else {
      console.error(`\n❌ Job '${jobName}' was not found in cron configuration.\n`);
      process.exit(1);
    }
  });

// ui / server / web dashboard command
program
  .command('ui')
  .alias('server')
  .alias('web')
  .description('Start the Web Dashboard & REST API Gateway')
  .option('-p, --port <port>', 'HTTP server port', '3000')
  .option('-h, --host <host>', 'HTTP server host', '0.0.0.0')
  .action(async (opts) => {
    try {
      const { startMattermostHttpServer } = await import('../ui/server');
      const port = Number(opts.port) || 3000;
      const host = opts.host || '0.0.0.0';

      console.log('\n🚀 Launching Mattermost Agent Web UI & API Gateway...');
      const server = await startMattermostHttpServer({ port, host });

      console.log(`\n🌐 Web Dashboard:  http://localhost:${port}`);
      console.log(`📡 REST API Docs:   http://localhost:${port}#api`);
      console.log(`📋 OpenAPI Spec:    http://localhost:${port}/api/openapi.json`);
      console.log('\n💡 Press Ctrl+C to stop the server.\n');

      const shutdown = async () => {
        console.log('\nStopping Mattermost Web UI...');
        await server.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
