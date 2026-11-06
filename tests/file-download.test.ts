import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import { MattermostValidationError } from '../src/domain/mattermost/errors';
import { createMattermostMcpServer } from '../src/mcp/server';
import { MattermostActionSchema } from '../src/application/mattermost/dto/action-schemas';
import { MattermostApiProvider } from '../src/infrastructure/mattermost/api/api-provider';
import { MattermostApiClient } from '../src/infrastructure/mattermost/api/client';

describe('Phase 2 - Secure Attachment File Download', () => {
  let mockProvider: MattermostProvider;
  let tmpDir: string;
  const sampleFileId = '31ewigbaoigepj5qsh3xb9bbjo';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-download-'));
    mockProvider = {
      getMe: vi.fn(),
      getChannel: vi.fn(),
      listChannels: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn(),
      replyToMessage: vi.fn(),
      editMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
      getPostThread: vi.fn(),
      searchPosts: vi.fn(),
      downloadFile: vi.fn(),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  describe('Security Guardrails in downloadFile implementation', () => {
    it('validates fileId must be 26-char alphanumeric hash', async () => {
      const mockClient = {
        getFileInfo: vi.fn(),
        downloadFileData: vi.fn(),
      } as unknown as MattermostApiClient;
      const apiProvider = new MattermostApiProvider(mockClient);

      await expect(apiProvider.downloadFile('invalid/path', tmpDir)).rejects.toThrow(
        MattermostValidationError
      );
      await expect(apiProvider.downloadFile('../escape', tmpDir)).rejects.toThrow(
        'Invalid file ID'
      );
      expect(mockClient.getFileInfo).not.toHaveBeenCalled();
    });

    it('rejects files exceeding size limit based on file info metadata', async () => {
      const mockClient = {
        getFileInfo: vi.fn().mockResolvedValue({
          id: sampleFileId,
          name: 'large_archive.zip',
          size: 100 * 1024 * 1024, // 100MB
          mime_type: 'application/zip',
        }),
        downloadFileData: vi.fn(),
      } as unknown as MattermostApiClient;
      const apiProvider = new MattermostApiProvider(mockClient);

      await expect(
        apiProvider.downloadFile(sampleFileId, tmpDir, 50 * 1024 * 1024)
      ).rejects.toThrow(/exceeds maximum allowed limit/);
      expect(mockClient.downloadFileData).not.toHaveBeenCalled();
    });

    it('sanitizes malicious filename with path traversal characters', async () => {
      const sampleContent = Buffer.from('console.log("hello");');
      const mockClient = {
        getFileInfo: vi.fn().mockResolvedValue({
          id: sampleFileId,
          name: '../../../../etc/cron.d/evil.sh',
          size: sampleContent.length,
          mime_type: 'application/x-sh',
        }),
        downloadFileData: vi.fn().mockResolvedValue(sampleContent),
      } as unknown as MattermostApiClient;
      const apiProvider = new MattermostApiProvider(mockClient);

      const result = await apiProvider.downloadFile(sampleFileId, tmpDir);

      // Filename should be stripped of directory traversal prefixes
      expect(result.filename).toBe('evil.sh');
      expect(result.savedPath).toBe(path.join(tmpDir, 'evil.sh'));
      expect(fs.existsSync(result.savedPath)).toBe(true);
      expect(fs.readFileSync(result.savedPath, 'utf-8')).toBe('console.log("hello");');
    });

    it('rejects downloaded data buffer exceeding size limit', async () => {
      const oversizedBuffer = Buffer.alloc(1000);
      const mockClient = {
        getFileInfo: vi.fn().mockResolvedValue({
          id: sampleFileId,
          name: 'data.bin',
          size: 500, // Claimed 500
          mime_type: 'application/octet-stream',
        }),
        downloadFileData: vi.fn().mockResolvedValue(oversizedBuffer), // Actual 1000
      } as unknown as MattermostApiClient;
      const apiProvider = new MattermostApiProvider(mockClient);

      await expect(
        apiProvider.downloadFile(sampleFileId, tmpDir, 800)
      ).rejects.toThrow(/exceeds maximum allowed limit/);
    });
  });

  describe('MattermostActionSchema parsing', () => {
    it('parses get_file action payload successfully', () => {
      const payload = {
        action: 'get_file',
        fileId: sampleFileId,
        outputDir: '/custom/downloads',
        maxSizeBytes: 10485760,
      };
      const parsed = MattermostActionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });
  });

  describe('MCP Tool: mattermost_get_file', () => {
    it('handles mattermost_get_file MCP call', async () => {
      (mockProvider.downloadFile as any).mockResolvedValue({
        fileId: sampleFileId,
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        savedPath: '/downloads/report.pdf',
      });

      const automationService = new MattermostAutomationService({ provider: mockProvider });
      const mcpServer = createMattermostMcpServer(automationService);
      const handler = (mcpServer as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_get_file',
          arguments: {
            fileId: sampleFileId,
            outputDir: '/downloads',
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.fileId).toBe(sampleFileId);
      expect(content.filename).toBe('report.pdf');
      expect(content.savedPath).toBe('/downloads/report.pdf');
    });
  });
});
