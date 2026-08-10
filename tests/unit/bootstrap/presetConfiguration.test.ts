import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMcpServer } from '@/common/config/storage';
import type { LoadedPresetConfiguration, PresetConfiguration } from '@/process/utils/presetConfiguration';
import {
  ensurePresetConfiguration,
  getPresetConfigurationValidationErrors,
  PRESET_API_KEY_PLACEHOLDER,
  resolveSkillRelease,
} from '@/process/utils/presetConfiguration';

const {
  batchImportServersMock,
  createAssistantMock,
  createProviderMock,
  getAssistantMock,
  httpRequestMock,
  importSkillsMock,
  listAssistantsMock,
  listAvailableSkillsMock,
  listProvidersMock,
  listServersMock,
  mkdtempMock,
  netFetchMock,
  readFileMock,
  rmMock,
  setAssistantStateMock,
  writeAssistantRuleMock,
  writeFileMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  createAssistantMock: vi.fn(),
  createProviderMock: vi.fn(),
  getAssistantMock: vi.fn(),
  httpRequestMock: vi.fn(),
  importSkillsMock: vi.fn(),
  listAssistantsMock: vi.fn(),
  listAvailableSkillsMock: vi.fn(),
  listProvidersMock: vi.fn(),
  listServersMock: vi.fn(),
  mkdtempMock: vi.fn(),
  netFetchMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn(),
  setAssistantStateMock: vi.fn(),
  writeAssistantRuleMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mode: {
    listProviders: { invoke: listProvidersMock },
    createProvider: { invoke: createProviderMock },
  },
  fs: {
    listAvailableSkills: { invoke: listAvailableSkillsMock },
    importSkills: { invoke: importSkillsMock },
    writeAssistantRule: { invoke: writeAssistantRuleMock },
  },
  assistants: {
    list: { invoke: listAssistantsMock },
    get: { invoke: getAssistantMock },
    create: { invoke: createAssistantMock },
    setState: { invoke: setAssistantStateMock },
  },
  mcpService: {
    listServers: { invoke: listServersMock },
    batchImportServers: { invoke: batchImportServersMock },
  },
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app',
  },
  net: {
    fetch: netFetchMock,
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mkdtempMock,
  readFile: readFileMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

const bufferArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const mockResponse = (body: string | Buffer, headers: Record<string, string> = {}): Response => {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => buffer.toString('utf8'),
    arrayBuffer: async () => bufferArrayBuffer(buffer),
  } as unknown as Response;
};

const validConfig = (): PresetConfiguration => ({
  version: 1,
  provider: {
    id: 'computing-platform',
    platform: 'custom',
    name: '计算平台模型服务',
    base_url: 'https://server-v3.computingplatform.com/api/v1/openai/v1',
    models: ['qwen3.6-35b-a3b-fp8'],
    enabled: true,
    is_full_url: false,
  },
  mcp: {
    name: 'computing-platform',
    description: '计算平台 MCP 服务',
    url: 'https://mcp.computingplatform.com/mcp',
    enabled: false,
    headers: { Authorization: '' },
  },
  skills: {
    enabled: false,
    name_prefix: 'computing-platform-',
    update: {
      enabled: true,
      manifest_url: 'https://mirrors.computingplatform.com/repository/files/software/AionUi/skills/latest.yml',
      download_url_template:
        'https://mirrors.computingplatform.com/repository/files/software/AionUi/skills/SKILL-{version}.zip',
      timeout_ms: 10_000,
      max_download_bytes: 64 * 1024 * 1024,
      require_sha512: false,
    },
  },
  assistant: {
    id: 'computing-platform-assistant',
    name: '计算平台助手',
    description: '计算平台助手测试配置',
    avatar: '🖥️',
    enabled: false,
    agent_id: 'aionrs',
    default_model: 'qwen3.6-35b-a3b-fp8',
    recommended_prompts: ['查看任务'],
    rules_file: 'assistant-rules.md',
  },
});

const loadedPreset = (config = validConfig()): LoadedPresetConfiguration => ({
  config,
  rules: '# 计算平台助手规则\n\n优先通过 MCP 获取实时信息。\n',
});

const presetMcpServer = (headers: Record<string, string> = { Authorization: '' }): IMcpServer => ({
  id: 'mcp-preset-id',
  name: 'computing-platform',
  description: '计算平台 MCP 服务',
  enabled: false,
  builtin: false,
  transport: {
    type: 'http',
    url: 'https://mcp.computingplatform.com/mcp',
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
  importSkillsMock.mockResolvedValue({
    skill_names: ['computing-platform-tasks', 'computing-platform-resources'],
  });
  createAssistantMock.mockResolvedValue(undefined);
  setAssistantStateMock.mockResolvedValue(undefined);
  writeAssistantRuleMock.mockResolvedValue(true);
  getAssistantMock.mockResolvedValue({ rules: { content: 'user rule' } });
  mkdtempMock.mockResolvedValue('/tmp/aionui-preset-skills-test');
  writeFileMock.mockResolvedValue(undefined);
  readFileMock.mockResolvedValue('');
  rmMock.mockResolvedValue(undefined);

  httpRequestMock.mockImplementation(async (method: string, requestPath: string) => {
    if (method === 'GET' && requestPath === '/api/settings/client') return {};
    return undefined;
  });

  netFetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('latest.yml')) {
      return mockResponse('version: 0.0.1\n');
    }
    return mockResponse(Buffer.from('mock-skill-zip'));
  });
});

describe('getPresetConfigurationValidationErrors', () => {
  it('accepts the computing-platform deployment configuration', () => {
    expect(getPresetConfigurationValidationErrors(validConfig())).toEqual([]);
  });

  it('requires the assistant default model to exist in the provider model list', () => {
    const config = validConfig();
    config.assistant.default_model = 'other-model';

    expect(getPresetConfigurationValidationErrors(config)).toContain(
      'assistant.default_model must exist in provider.models'
    );
  });
});

describe('resolveSkillRelease', () => {
  it('supports a latest.yml containing only the semantic version', () => {
    const config = validConfig().skills.update;

    expect(resolveSkillRelease('0.0.1\n', config)).toEqual({
      version: '0.0.1',
      downloadUrl: 'https://mirrors.computingplatform.com/repository/files/software/AionUi/skills/SKILL-0.0.1.zip',
      sha512: undefined,
      size: undefined,
    });
  });

  it('supports electron-updater style files metadata and resolves relative ZIP URLs', () => {
    const config = validConfig().skills.update;

    expect(
      resolveSkillRelease(
        [
          'version: 0.0.2',
          'files:',
          '  - url: SKILL-0.0.2.zip',
          '    sha512: abc123',
          '    size: 123',
          '',
        ].join('\n'),
        config
      )
    ).toEqual({
      version: '0.0.2',
      downloadUrl: 'https://mirrors.computingplatform.com/repository/files/software/AionUi/skills/SKILL-0.0.2.zip',
      sha512: 'abc123',
      size: 123,
    });
  });
});

describe('ensurePresetConfiguration', () => {
  it('creates the preset and downloads/imports the latest Skills without enabling them', async () => {
    const preset = loadedPreset();

    await expect(ensurePresetConfiguration(preset)).resolves.toBe(true);

    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'computing-platform',
        platform: 'custom',
        base_url: 'https://server-v3.computingplatform.com/api/v1/openai/v1',
        api_key: PRESET_API_KEY_PLACEHOLDER,
        models: ['qwen3.6-35b-a3b-fp8'],
        is_full_url: false,
      })
    );

    expect(batchImportServersMock).toHaveBeenCalledWith({
      servers: [
        expect.objectContaining({
          name: 'computing-platform',
          enabled: false,
          builtin: false,
          transport: {
            type: 'http',
            url: 'https://mcp.computingplatform.com/mcp',
            headers: { Authorization: '' },
          },
        }),
      ],
    });

    expect(netFetchMock).toHaveBeenCalledTimes(2);
    expect(importSkillsMock).toHaveBeenCalledWith({
      skill_path: '/tmp/aionui-preset-skills-test/SKILL-0.0.1.zip',
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/aionui-preset-skills-test/SKILL-0.0.1.zip',
      expect.any(Buffer)
    );
    expect(httpRequestMock).toHaveBeenCalledWith('PUT', '/api/settings/client', {
      'preset.computingPlatform.skills.version': '0.0.1',
      'preset.computingPlatform.skills.names': ['computing-platform-tasks', 'computing-platform-resources'],
    });

    expect(createAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'computing-platform-assistant',
        agent_id: 'aionrs',
        custom_skill_names: [],
        defaults: {
          model: { mode: 'fixed', value: 'qwen3.6-35b-a3b-fp8' },
          skills: { mode: 'fixed', value: [] },
          mcps: { mode: 'fixed', value: ['mcp-preset-id'] },
        },
      })
    );
    expect(setAssistantStateMock).toHaveBeenCalledWith({ id: 'computing-platform-assistant', enabled: false });
    expect(writeAssistantRuleMock).toHaveBeenCalledWith({
      assistant_id: 'computing-platform-assistant',
      content: preset.rules,
    });
  });

  it('checks latest.yml but does not re-download a Skill package already at the latest version', async () => {
    httpRequestMock.mockImplementation(async (method: string, requestPath: string) => {
      if (method === 'GET' && requestPath === '/api/settings/client') {
        return {
          'preset.computingPlatform.skills.version': '0.0.1',
          'preset.computingPlatform.skills.names': ['computing-platform-tasks'],
        };
      }
      return undefined;
    });

    await ensurePresetConfiguration(loadedPreset());

    expect(netFetchMock).toHaveBeenCalledTimes(1);
    expect(String(netFetchMock.mock.calls[0][0])).toContain('latest.yml');
    expect(importSkillsMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('does not overwrite existing user model or MCP credentials', async () => {
    const config = validConfig();
    listProvidersMock.mockResolvedValue([
      {
        ...config.provider,
        api_key: 'user-model-api-key',
      },
    ]);
    listServersMock.mockResolvedValue([presetMcpServer({ Authorization: 'Bearer user-mcp-token' })]);
    listAssistantsMock.mockResolvedValue([
      {
        id: 'computing-platform-assistant',
        name: '计算平台助手',
      },
    ]);
    httpRequestMock.mockImplementation(async (method: string, requestPath: string) => {
      if (method === 'GET' && requestPath === '/api/settings/client') {
        return {
          'preset.computingPlatform.skills.version': '0.0.1',
          'preset.computingPlatform.skills.names': ['computing-platform-tasks'],
        };
      }
      return undefined;
    });

    await ensurePresetConfiguration(loadedPreset(config));

    expect(createProviderMock).not.toHaveBeenCalled();
    expect(batchImportServersMock).not.toHaveBeenCalled();
    expect(importSkillsMock).not.toHaveBeenCalled();
    expect(createAssistantMock).not.toHaveBeenCalled();
    expect(writeAssistantRuleMock).not.toHaveBeenCalled();
  });

  it('skips bootstrap when the external preset configuration is invalid', async () => {
    const config = validConfig();
    config.provider.base_url = '';

    await expect(ensurePresetConfiguration(loadedPreset(config))).resolves.toBe(false);

    expect(listProvidersMock).not.toHaveBeenCalled();
    expect(listServersMock).not.toHaveBeenCalled();
    expect(netFetchMock).not.toHaveBeenCalled();
  });
});
