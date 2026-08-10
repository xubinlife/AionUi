import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMcpServer } from '@/common/config/storage';
import type { PresetConfiguration } from '@/process/utils/presetConfiguration';
import {
  ensurePresetConfiguration,
  getPresetConfigurationValidationErrors,
  PRESET_API_KEY_PLACEHOLDER,
} from '@/process/utils/presetConfiguration';

const {
  batchImportServersMock,
  createAssistantMock,
  createProviderMock,
  importSkillsMock,
  listAssistantsMock,
  listAvailableSkillsMock,
  listProvidersMock,
  listServersMock,
  mkdirMock,
  mkdtempMock,
  rmMock,
  writeFileMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  createAssistantMock: vi.fn(),
  createProviderMock: vi.fn(),
  importSkillsMock: vi.fn(),
  listAssistantsMock: vi.fn(),
  listAvailableSkillsMock: vi.fn(),
  listProvidersMock: vi.fn(),
  listServersMock: vi.fn(),
  mkdirMock: vi.fn(),
  mkdtempMock: vi.fn(),
  rmMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    mode: {
      listProviders: { invoke: listProvidersMock },
      createProvider: { invoke: createProviderMock },
    },
    fs: {
      listAvailableSkills: { invoke: listAvailableSkillsMock },
      importSkills: { invoke: importSkillsMock },
    },
    assistants: {
      list: { invoke: listAssistantsMock },
      create: { invoke: createAssistantMock },
    },
  },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    listServers: { invoke: listServersMock },
    batchImportServers: { invoke: batchImportServersMock },
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  mkdtemp: mkdtempMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

const validConfig = (): PresetConfiguration => ({
  provider: {
    id: 'computing-platform',
    platform: 'new-api',
    name: '计算平台模型服务',
    base_url: 'https://models.example.test/v1',
    models: ['qwen-test'],
    enabled: true,
  },
  defaultModel: 'qwen-test',
  mcp: {
    name: 'computing-platform',
    description: '计算平台 MCP 服务',
    url: 'https://mcp.example.test/mcp',
    enabled: true,
  },
  skill: {
    name: 'computing-platform',
    content: '---\nname: computing-platform\ndescription: test\n---\n\n# test\n',
  },
  assistant: {
    id: 'computing-platform-assistant',
    name: '计算平台助手',
    description: '计算平台助手测试配置',
    avatar: '🖥️',
    recommended_prompts: ['查看任务'],
  },
});

const presetMcpServer = (headers: Record<string, string> = {}): IMcpServer => ({
  id: 'mcp-preset-id',
  name: 'computing-platform',
  description: '计算平台 MCP 服务',
  enabled: true,
  builtin: false,
  transport: {
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    headers,
  },
  created_at: 1,
  updated_at: 1,
  original_json: '{}',
});

beforeEach(() => {
  vi.clearAllMocks();
  listProvidersMock.mockResolvedValue([]);
  listServersMock.mockResolvedValue([]);
  listAvailableSkillsMock.mockResolvedValue([]);
  listAssistantsMock.mockResolvedValue([]);
  createProviderMock.mockResolvedValue(undefined);
  batchImportServersMock.mockResolvedValue([presetMcpServer()]);
  importSkillsMock.mockResolvedValue({ skill_name: 'computing-platform' });
  createAssistantMock.mockResolvedValue(undefined);
  mkdtempMock.mockResolvedValue('/tmp/aionui-preset-skill-test');
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
});

describe('getPresetConfigurationValidationErrors', () => {
  it('requires the deployment-specific non-secret fields', () => {
    const config = validConfig();
    config.provider.base_url = '';
    config.provider.models = [];
    config.defaultModel = '';
    config.mcp.url = '';

    expect(getPresetConfigurationValidationErrors(config)).toEqual([
      'provider.base_url',
      'provider.models',
      'defaultModel',
      'mcp.url',
    ]);
  });

  it('requires the assistant default model to exist in the preset provider model list', () => {
    const config = validConfig();
    config.defaultModel = 'other-model';

    expect(getPresetConfigurationValidationErrors(config)).toContain('defaultModel must exist in provider.models');
  });
});

describe('ensurePresetConfiguration', () => {
  it('creates missing resources without packaging user model or MCP credentials', async () => {
    const config = validConfig();

    await expect(ensurePresetConfiguration(config)).resolves.toBe(true);

    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'computing-platform',
        base_url: 'https://models.example.test/v1',
        api_key: PRESET_API_KEY_PLACEHOLDER,
        models: ['qwen-test'],
      })
    );
    expect(PRESET_API_KEY_PLACEHOLDER).toBe('__AIONUI_USER_API_KEY_REQUIRED__');

    expect(batchImportServersMock).toHaveBeenCalledWith({
      servers: [
        expect.objectContaining({
          name: 'computing-platform',
          builtin: false,
          transport: {
            type: 'http',
            url: 'https://mcp.example.test/mcp',
            headers: {},
          },
        }),
      ],
    });

    const importedMcp = batchImportServersMock.mock.calls[0][0].servers[0];
    expect(importedMcp.original_json).not.toContain('Authorization');
    expect(importedMcp.original_json).not.toContain('Bearer');

    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/aionui-preset-skill-test/computing-platform/SKILL.md',
      config.skill.content,
      'utf8'
    );
    expect(importSkillsMock).toHaveBeenCalledWith({
      skill_path: '/tmp/aionui-preset-skill-test/computing-platform',
    });
    expect(rmMock).toHaveBeenCalledWith('/tmp/aionui-preset-skill-test', { recursive: true, force: true });

    expect(createAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'computing-platform-assistant',
        custom_skill_names: ['computing-platform'],
        defaults: {
          model: { mode: 'fixed', value: 'qwen-test' },
          skills: { mode: 'fixed', value: ['computing-platform'] },
          mcps: { mode: 'fixed', value: ['mcp-preset-id'] },
        },
      })
    );
  });

  it('does not overwrite existing user credentials or customized preset resources', async () => {
    const config = validConfig();
    listProvidersMock.mockResolvedValue([
      {
        ...config.provider,
        api_key: 'user-model-api-key',
      },
    ]);
    listServersMock.mockResolvedValue([presetMcpServer({ Authorization: 'Bearer user-mcp-token' })]);
    listAvailableSkillsMock.mockResolvedValue([
      {
        name: 'computing-platform',
        description: 'user customized skill',
        location: '/user/skills/computing-platform/SKILL.md',
        is_auto_inject: false,
        is_custom: true,
        source: 'custom',
      },
    ]);
    listAssistantsMock.mockResolvedValue([
      {
        id: 'computing-platform-assistant',
        name: '计算平台助手',
      },
    ]);

    await expect(ensurePresetConfiguration(config)).resolves.toBe(true);

    expect(createProviderMock).not.toHaveBeenCalled();
    expect(batchImportServersMock).not.toHaveBeenCalled();
    expect(importSkillsMock).not.toHaveBeenCalled();
    expect(createAssistantMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('skips bootstrap instead of writing invalid placeholder endpoints', async () => {
    const config = validConfig();
    config.provider.base_url = '';

    await expect(ensurePresetConfiguration(config)).resolves.toBe(false);

    expect(listProvidersMock).not.toHaveBeenCalled();
    expect(listServersMock).not.toHaveBeenCalled();
    expect(createProviderMock).not.toHaveBeenCalled();
    expect(batchImportServersMock).not.toHaveBeenCalled();
  });
});
