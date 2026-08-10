/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { IMcpServer } from '@/common/config/storage';
import type { CreateAssistantRequest } from '@/common/types/agent/assistantTypes';
import type { CreateProviderRequest } from '@/common/types/provider/providerApi';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type PresetMcpConfiguration = {
  name: string;
  description: string;
  url: string;
  enabled: boolean;
};

type PresetSkillConfiguration = {
  name: string;
  content: string;
};

type PresetAssistantConfiguration = {
  id: string;
  name: string;
  description: string;
  avatar: string;
  recommended_prompts: string[];
};

export type PresetConfiguration = {
  provider: Omit<CreateProviderRequest, 'api_key'>;
  defaultModel: string;
  mcp: PresetMcpConfiguration;
  skill: PresetSkillConfiguration;
  assistant: PresetAssistantConfiguration;
};

/**
 * aionCore currently requires a non-empty API key when a non-Bedrock provider
 * row is created. This value is deliberately not a credential: it only lets us
 * materialize the preset provider so the user can see it and replace this marker
 * with their own API key in Settings.
 */
export const PRESET_API_KEY_PLACEHOLDER = '__AIONUI_USER_API_KEY_REQUIRED__';

/**
 * Deployment-specific preset values.
 *
 * Do not add user credentials here. The packaged application should only carry
 * non-sensitive connection metadata; each user fills the model API key and MCP
 * Authorization header in the existing Settings UI after installation.
 *
 * Before producing the internal installation package, fill only the three
 * deployment-specific fields below:
 *   1. provider.base_url
 *   2. provider.models + defaultModel
 *   3. mcp.url
 */
export const PRESET_CONFIGURATION: PresetConfiguration = {
  provider: {
    id: 'computing-platform',
    platform: 'new-api',
    name: '计算平台模型服务',
    base_url: '',
    models: [],
    enabled: true,
  },
  defaultModel: '',
  mcp: {
    name: 'computing-platform',
    description: '计算平台 MCP 服务',
    url: '',
    enabled: true,
  },
  skill: {
    name: 'computing-platform',
    content: `---
name: computing-platform
description: 使用计算平台 MCP 查询资源、任务状态、分析任务失败原因并执行平台操作。
---

# 计算平台

当用户询问计算平台上的资源、任务、日志、模型服务或需要执行平台操作时，优先使用计算平台 MCP 提供的工具获取实时信息，不要根据历史对话猜测当前状态。

## 工作原则

- 查询类请求优先直接调用对应 MCP 工具，并基于工具返回的结构化结果回答。
- 分析任务失败时，先获取任务详情和状态，再按需获取事件、日志或相关资源信息，最后给出根因与处理建议。
- 提交、停止、删除、修改等会改变平台状态的操作，在执行前明确复述关键参数；存在歧义时不要自行猜测。
- 不在回复中泄露 API Key、Authorization、Access Token 或其他敏感凭证。
- 工具返回信息不足时，明确说明缺失信息，并优先继续通过 MCP 获取，而不是编造结果。
`,
  },
  assistant: {
    id: 'computing-platform-assistant',
    name: '计算平台助手',
    description: '通过自然语言查询和操作计算平台，包括任务查询、故障分析、资源查看和任务提交。',
    avatar: '🖥️',
    recommended_prompts: [
      '查看我的训练任务',
      '帮我分析最近失败的任务',
      '查询当前可用的 GPU 资源',
      '帮我提交一个训练任务',
    ],
  },
};

type PresetMcpServer = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;

export function getPresetConfigurationValidationErrors(config: PresetConfiguration): string[] {
  const errors: string[] = [];
  if (!config.provider.base_url.trim()) errors.push('provider.base_url');
  if (!config.provider.models || config.provider.models.length === 0) errors.push('provider.models');
  if (!config.defaultModel.trim()) errors.push('defaultModel');
  if (config.provider.models && !config.provider.models.includes(config.defaultModel)) {
    errors.push('defaultModel must exist in provider.models');
  }
  if (!config.mcp.url.trim()) errors.push('mcp.url');
  return errors;
}

function buildPresetMcpServer(config: PresetConfiguration): PresetMcpServer {
  const transport = {
    type: 'http' as const,
    url: config.mcp.url,
    // Authorization is intentionally absent. Each user fills it in Settings.
    headers: {},
  };
  const serverConfig = {
    type: 'streamable_http',
    url: config.mcp.url,
  };

  return {
    name: config.mcp.name,
    description: config.mcp.description,
    enabled: config.mcp.enabled,
    // Keep this editable: the user must add their Authorization header.
    builtin: false,
    transport,
    original_json: JSON.stringify({ mcpServers: { [config.mcp.name]: serverConfig } }, null, 2),
  };
}

async function ensurePresetProvider(config: PresetConfiguration): Promise<void> {
  const providers = await ipcBridge.mode.listProviders.invoke();
  const exists = (providers ?? []).some(
    (provider) => provider.id === config.provider.id || provider.name === config.provider.name
  );
  if (exists) return;

  await ipcBridge.mode.createProvider.invoke({
    ...config.provider,
    api_key: PRESET_API_KEY_PLACEHOLDER,
  });
}

async function ensurePresetMcp(config: PresetConfiguration): Promise<IMcpServer> {
  const existing = await mcpService.listServers.invoke();
  const matched = (existing ?? []).find((server) => server.name === config.mcp.name);
  if (matched) return matched;

  const imported = await mcpService.batchImportServers.invoke({ servers: [buildPresetMcpServer(config)] });
  const created = imported.find((server) => server.name === config.mcp.name);
  if (created) return created;

  const refreshed = await mcpService.listServers.invoke();
  const refreshedMatch = refreshed.find((server) => server.name === config.mcp.name);
  if (!refreshedMatch) {
    throw new Error(`Preset MCP server was not created: ${config.mcp.name}`);
  }
  return refreshedMatch;
}

async function ensurePresetSkill(config: PresetConfiguration): Promise<void> {
  const existing = await ipcBridge.fs.listAvailableSkills.invoke();
  if ((existing ?? []).some((skill) => skill.name === config.skill.name)) return;

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aionui-preset-skill-'));
  try {
    const skillDir = path.join(tempRoot, config.skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), config.skill.content, 'utf8');
    await ipcBridge.fs.importSkills.invoke({ skill_path: skillDir });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensurePresetAssistant(config: PresetConfiguration, mcpServer: IMcpServer): Promise<void> {
  const assistants = await ipcBridge.assistants.list.invoke();
  const exists = (assistants ?? []).some(
    (assistant) => assistant.id === config.assistant.id || assistant.name === config.assistant.name
  );
  if (exists) return;

  const request: CreateAssistantRequest = {
    id: config.assistant.id,
    name: config.assistant.name,
    description: config.assistant.description,
    avatar: config.assistant.avatar,
    custom_skill_names: [config.skill.name],
    recommended_prompts: config.assistant.recommended_prompts,
    defaults: {
      model: { mode: 'fixed', value: config.defaultModel },
      skills: { mode: 'fixed', value: [config.skill.name] },
      mcps: { mode: 'fixed', value: [mcpServer.id] },
    },
  };

  await ipcBridge.assistants.create.invoke(request);
}

/**
 * Idempotently installs the enterprise preset without overwriting user edits.
 * Existing provider/MCP/skill/assistant records are left untouched, which is
 * especially important for the API key and Authorization header users add later.
 */
export async function ensurePresetConfiguration(
  config: PresetConfiguration = PRESET_CONFIGURATION
): Promise<boolean> {
  const validationErrors = getPresetConfigurationValidationErrors(config);
  if (validationErrors.length > 0) {
    console.warn(
      '[Preset] configuration is incomplete; skipping bootstrap. Fill: %s',
      validationErrors.join(', ')
    );
    return false;
  }

  await ensurePresetProvider(config);
  const mcpServer = await ensurePresetMcp(config);
  await ensurePresetSkill(config);
  await ensurePresetAssistant(config, mcpServer);
  console.info('[Preset] computing platform configuration is ready');
  return true;
}
