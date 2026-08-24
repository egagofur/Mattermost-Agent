#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import { MattermostAutomationService } from '../application/mattermost/services/automation-service';
import { loadConfig, MattermostConfig } from '../config/env';
import { MattermostError } from '../domain/mattermost/errors';
import { ChannelConfigLoader } from '../infrastructure/mattermost/services/channel-config-loader';

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
  .description('Send a message to a channel as personal user (e.g. `mattermost send per-fe-an "Hello"`)')
  .option('-c, --channel <channel>', 'Channel name, slug, or ID')
  .option('-m, --message <message>', 'Message body to send')
  .option('-r, --root-id <rootId>', 'Root ID to reply inside a thread')
  .option('--team <teamId>', 'Team ID or slug')
  .option('--idempotency-key <key>', 'Custom idempotency key to avoid duplicate sends')
  .action(async (posChannel, posMessage, opts) => {
    const targetChannel = posChannel || opts.channel;
    const targetMessage = posMessage || opts.message;

    if (!targetChannel || !targetMessage) {
      console.error('\n❌ Error: Channel and Message are required.');
      console.error('   Usage: npm run cli -- send <channel> "<message>"');
      console.error('   Or:    npm run cli -- send -c <channel> -m "<message>"\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const result = await service.sendMessage({
        channel: targetChannel,
        message: targetMessage,
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
  .description('Reply to a message thread in a channel (e.g. `mattermost reply per-fe-an <rootId> "Reply text"`)')
  .option('-c, --channel <channel>', 'Channel name, slug, or ID')
  .option('-r, --root-id <rootId>', 'Root thread ID to reply to')
  .option('-m, --message <message>', 'Message body to send')
  .option('--team <teamId>', 'Team ID or slug')
  .option('--idempotency-key <key>', 'Custom idempotency key')
  .action(async (posChannel, posRootId, posMessage, opts) => {
    const targetChannel = posChannel || opts.channel;
    const targetRootId = posRootId || opts.rootId;
    const targetMessage = posMessage || opts.message;

    if (!targetChannel || !targetRootId || !targetMessage) {
      console.error('\n❌ Error: Channel, Root ID, and Message are required.');
      console.error('   Usage: npm run cli -- reply <channel> <rootId> "<message>"');
      console.error('   Or:    npm run cli -- reply -c <channel> -r <rootId> -m "<message>"\n');
      process.exit(1);
    }

    const service = getService();
    try {
      const result = await service.replyToMessage({
        channel: targetChannel,
        rootId: targetRootId,
        message: targetMessage,
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

program.parse(process.argv);
