/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as adapter from '@/common/adapter/ipcBridge';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IMcpServer } from '@/common/config/storage';
import type { CreateAssistantRequest } from '@/common/types/agent/assistantTypes';
import type { CreateProviderRequest } from '@/common/types/provider/providerApi';
import { app, net } from 'electron';
import log from 'electron-log';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { gt, valid as isValidSemver } from 'semver';

type PresetMcpConfiguration = {
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  headers?: Record<string, string>;
};

type PresetSkillsUpdateConfiguration = {
  enabled: boolean;
  manifest_url: string;
  download_url_template: string;
  timeout_ms?: number;
  max_download_bytes?: number;
  require_sha512?: boolean;
};

type PresetSkillsConfiguration = {
  /** Whether the imported custom skills are selected on the preset assistant by default. */
  enabled: boolean;
  /** Prefix used only as a fallback when the recorded imported-name list is unavailable. */
  name_prefix?: string;
  update: PresetSkillsUpdateConfiguration;
};

type PresetAssistantConfiguration = {
  id: string;
  name: string;
  description: string;
  avatar: string;
  enabled: boolean;
  agent_id: string;
  default_model: string;
  recommended_prompts: string[];
  rules_file: string;
};

export type PresetConfiguration = {
  version: number;
  provider: Omit<CreateProviderRequest, 'api_key'>;
  mcp: PresetMcpConfiguration;
  skills: PresetSkillsConfiguration;
  assistant: PresetAssistantConfiguration;
};

export type LoadedPresetConfiguration = {
  config: PresetConfiguration;
  rules: string;
};

type SkillReleaseFile = {
  url?: string;
  sha512?: string;
  size?: number;
};

type SkillLatestManifest = {
  version?: string;
  path?: string;
  sha512?: string;
  size?: number;
  files?: SkillReleaseFile[];
};

export type ResolvedSkillRelease = {
  version: string;
  downloadUrl: string;
  sha512?: string;
  size?: number;
};

type SkillImportResult = {
  skill_name?: string;
  skill_names?: string[];
  failed?: Array<{ source_name?: string; error?: string }>;
};

type SkillPresetState = {
  version?: string;
  names: string[];
};

const PRESET_DIRECTORY_NAME = 'preset';
const PRESET_CONFIG_FILE = 'computing-platform.json';
const SKILL_VERSION_SETTING_KEY = 'preset.computingPlatform.skills.version';
const SKILL_NAMES_SETTING_KEY = 'preset.computingPlatform.skills.names';
const DEFAULT_SKILL_UPDATE_TIMEOUT_MS = 10_000;
const DEFAULT_SKILL_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/**
 * aionCore currently requires a non-empty API key when a non-Bedrock provider
 * row is created. This value is deliberately not a credential: it only lets us
 * materialize the preset provider so the user can see it and replace this marker
 * with their own API key in Settings.
 */
export const PRESET_API_KEY_PLACEHOLDER = '__AIONUI_USER_API_KEY_REQUIRED__';

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes('..');
}

function resolvePresetRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, PRESET_DIRECTORY_NAME);
  }

  const candidates = [
    path.join(app.getAppPath(), 'public', PRESET_DIRECTORY_NAME),
    path.resolve(process.cwd(), 'public', PRESET_DIRECTORY_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export async function loadPresetConfiguration(): Promise<LoadedPresetConfiguration> {
  const presetRoot = resolvePresetRoot();
  const configPath = path.join(presetRoot, PRESET_CONFIG_FILE);
  const config = JSON.parse(await readFile(configPath, 'utf8')) as PresetConfiguration;

  if (!isSafeRelativePath(config.assistant.rules_file)) {
    throw new Error(`Invalid preset assistant rules path: ${config.assistant.rules_file}`);
  }

  const rules = await readFile(path.join(presetRoot, config.assistant.rules_file), 'utf8');
  return { config, rules };
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function getPresetConfigurationValidationErrors(config: PresetConfiguration): string[] {
  const errors: string[] = [];
  const models = config.provider.models ?? [];
  const defaultModel = config.assistant.default_model.trim();

  if (!Number.isInteger(config.version) || config.version < 1) errors.push('version');
  if (!config.provider.base_url.trim() || !isHttpUrl(config.provider.base_url)) errors.push('provider.base_url');
  if (models.length === 0) errors.push('provider.models');
  if (!config.mcp.url.trim() || !isHttpUrl(config.mcp.url)) errors.push('mcp.url');
  if (!defaultModel) errors.push('assistant.default_model');
  if (defaultModel && models.length > 0 && !models.includes(defaultModel)) {
    errors.push('assistant.default_model must exist in provider.models');
  }
  if (!config.assistant.agent_id.trim()) errors.push('assistant.agent_id');
  if (!config.assistant.rules_file.trim()) errors.push('assistant.rules_file');

  if (config.skills.update.enabled) {
    if (!isHttpUrl(config.skills.update.manifest_url)) errors.push('skills.update.manifest_url');
    if (
      !config.skills.update.download_url_template.trim() ||
      !config.skills.update.download_url_template.includes('{version}') ||
      !isHttpUrl(config.skills.update.download_url_template.replace('{version}', '0.0.0'))
    ) {
      errors.push('skills.update.download_url_template');
    }
  }

  return errors;
}

function buildPresetMcpServer(config: PresetConfiguration): Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'> {
  const headers = config.mcp.headers ?? { Authorization: '' };
  const transport = {
    type: 'http' as const,
    url: config.mcp.url,
    headers,
  };
  const serverConfig = {
    type: 'streamable_http',
    url: config.mcp.url,
    headers,
  };

  return {
    name: config.mcp.name,
    description: config.mcp.description,
    enabled: config.mcp.enabled,
    // Keep this editable: the user must fill their Authorization header.
    builtin: false,
    transport,
    original_json: JSON.stringify({ mcpServers: { [config.mcp.name]: serverConfig } }, null, 2),
  };
}

async function ensurePresetProvider(config: PresetConfiguration): Promise<void> {
  const providers = await adapter.mode.listProviders.invoke();
  const exists = (providers ?? []).some(
    (provider) => provider.id === config.provider.id || provider.name === config.provider.name
  );
  if (exists) return;

  await adapter.mode.createProvider.invoke({
    ...config.provider,
    api_key: PRESET_API_KEY_PLACEHOLDER,
  });
}

async function ensurePresetMcp(config: PresetConfiguration): Promise<IMcpServer> {
  const existing = await adapter.mcpService.listServers.invoke();
  const matched = (existing ?? []).find((server) => server.name === config.mcp.name);
  if (matched) return matched;

  const imported = await adapter.mcpService.batchImportServers.invoke({ servers: [buildPresetMcpServer(config)] });
  const created = imported.find((server) => server.name === config.mcp.name);
  if (created) return created;

  const refreshed = await adapter.mcpService.listServers.invoke();
  const refreshedMatch = refreshed.find((server) => server.name === config.mcp.name);
  if (!refreshedMatch) {
    throw new Error(`Preset MCP server was not created: ${config.mcp.name}`);
  }
  return refreshedMatch;
}

function resolveManifestVersion(parsed: unknown): { version: string; manifest: SkillLatestManifest } {
  if (typeof parsed === 'string') {
    return { version: parsed.trim(), manifest: {} };
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Skill latest.yml does not contain a version');
  }

  const manifest = parsed as SkillLatestManifest;
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  return { version, manifest };
}

export function resolveSkillRelease(
  manifestText: string,
  updateConfig: PresetSkillsUpdateConfiguration
): ResolvedSkillRelease {
  const parsed = parseYaml(manifestText);
  const { version, manifest } = resolveManifestVersion(parsed);
  if (!version || !isValidSemver(version)) {
    throw new Error(`Invalid Skill release version: ${version || '<empty>'}`);
  }

  const file = manifest.files?.find((candidate) => candidate.url?.toLowerCase().endsWith('.zip')) ?? manifest.files?.[0];
  const relativeOrAbsolutePath = file?.url || manifest.path;
  const downloadUrl = relativeOrAbsolutePath
    ? new URL(relativeOrAbsolutePath, updateConfig.manifest_url).href
    : updateConfig.download_url_template.replaceAll('{version}', version);

  if (!isHttpUrl(downloadUrl)) {
    throw new Error(`Invalid Skill release URL: ${downloadUrl}`);
  }

  return {
    version,
    downloadUrl,
    sha512: file?.sha512 || manifest.sha512,
    size: file?.size || manifest.size,
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function withCacheBust(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('_aionui_ts', Date.now().toString());
  return parsed.href;
}

async function fetchLatestSkillRelease(updateConfig: PresetSkillsUpdateConfiguration): Promise<ResolvedSkillRelease> {
  const timeoutMs = updateConfig.timeout_ms ?? DEFAULT_SKILL_UPDATE_TIMEOUT_MS;
  const response = await fetchWithTimeout(withCacheBust(updateConfig.manifest_url), timeoutMs);
  const manifestText = await response.text();
  return resolveSkillRelease(manifestText, updateConfig);
}

function verifySkillArchive(buffer: Buffer, release: ResolvedSkillRelease, updateConfig: PresetSkillsUpdateConfiguration) {
  const maxBytes = updateConfig.max_download_bytes ?? DEFAULT_SKILL_MAX_DOWNLOAD_BYTES;
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Skill archive is too large: ${buffer.byteLength} > ${maxBytes}`);
  }
  if (typeof release.size === 'number' && release.size >= 0 && buffer.byteLength !== release.size) {
    throw new Error(`Skill archive size mismatch: expected ${release.size}, got ${buffer.byteLength}`);
  }

  if (!release.sha512) {
    if (updateConfig.require_sha512 === true) {
      throw new Error('Skill release manifest is missing sha512');
    }
    log.warn('[preset-skills] latest.yml has no sha512; archive integrity verification was skipped');
    return;
  }

  const actual = createHash('sha512').update(buffer).digest('base64');
  if (actual !== release.sha512) {
    throw new Error('Skill archive sha512 mismatch');
  }
}

async function downloadSkillArchive(
  release: ResolvedSkillRelease,
  updateConfig: PresetSkillsUpdateConfiguration
): Promise<Buffer> {
  const timeoutMs = updateConfig.timeout_ms ?? DEFAULT_SKILL_UPDATE_TIMEOUT_MS;
  log.info('[preset-skills] downloading Skill package', { version: release.version, url: release.downloadUrl });
  const response = await fetchWithTimeout(release.downloadUrl, timeoutMs);

  const contentLength = Number(response.headers.get('content-length') || 0);
  const maxBytes = updateConfig.max_download_bytes ?? DEFAULT_SKILL_MAX_DOWNLOAD_BYTES;
  if (contentLength > 0 && contentLength > maxBytes) {
    throw new Error(`Skill archive Content-Length is too large: ${contentLength} > ${maxBytes}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  verifySkillArchive(buffer, release, updateConfig);
  return buffer;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

async function loadSkillPresetState(): Promise<SkillPresetState> {
  try {
    const settings = (await httpRequest<Record<string, unknown>>('GET', '/api/settings/client')) || {};
    const rawVersion = settings[SKILL_VERSION_SETTING_KEY];
    return {
      version: typeof rawVersion === 'string' ? rawVersion : undefined,
      names: asStringArray(settings[SKILL_NAMES_SETTING_KEY]),
    };
  } catch (error) {
    log.warn('[preset-skills] failed to read local Skill preset state', error);
    return { names: [] };
  }
}

async function saveSkillPresetState(version: string, names: string[]): Promise<void> {
  await httpRequest<void>('PUT', '/api/settings/client', {
    [SKILL_VERSION_SETTING_KEY]: version,
    [SKILL_NAMES_SETTING_KEY]: names,
  });
}

async function resolveManagedSkillNames(config: PresetConfiguration, stateNames: string[]): Promise<string[]> {
  if (stateNames.length > 0) return stateNames;
  if (!config.skills.name_prefix) return [];

  const available = await adapter.fs.listAvailableSkills.invoke();
  return (available ?? [])
    .filter((skill) => skill.source === 'custom' && skill.name.startsWith(config.skills.name_prefix || ''))
    .map((skill) => skill.name);
}

function getImportedSkillNames(result: SkillImportResult): string[] {
  const names = asStringArray(result.skill_names);
  if (names.length > 0) return names;
  return typeof result.skill_name === 'string' && result.skill_name.length > 0 ? [result.skill_name] : [];
}

async function ensurePresetSkills(config: PresetConfiguration): Promise<string[]> {
  const state = await loadSkillPresetState();
  let currentNames = await resolveManagedSkillNames(config, state.names);
  if (!config.skills.update.enabled) return currentNames;

  const release = await fetchLatestSkillRelease(config.skills.update);
  if (state.version && isValidSemver(state.version) && !gt(release.version, state.version)) {
    log.info('[preset-skills] Skill package is up to date', {
      installedVersion: state.version,
      latestVersion: release.version,
    });
    return currentNames;
  }

  const archive = await downloadSkillArchive(release, config.skills.update);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aionui-preset-skills-'));
  const archivePath = path.join(tempRoot, `SKILL-${release.version}.zip`);
  try {
    await writeFile(archivePath, archive);
    // AionUi's existing Skill import service accepts ZIP files directly and owns
    // extraction, validation, overwrite handling and import-history recording.
    const result = (await adapter.fs.importSkills.invoke({ skill_path: archivePath })) as SkillImportResult;
    if ((result.failed ?? []).length > 0) {
      throw new Error(`Skill import reported ${(result.failed ?? []).length} failed item(s)`);
    }

    const importedNames = getImportedSkillNames(result);
    if (importedNames.length === 0) {
      throw new Error('Skill archive import returned no Skill names');
    }

    currentNames = importedNames;
    await saveSkillPresetState(release.version, importedNames);
    log.info('[preset-skills] Skill package installed', {
      version: release.version,
      skills: importedNames,
    });
    return importedNames;
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensurePresetAssistant(
  config: PresetConfiguration,
  mcpServer: IMcpServer,
  skillNames: string[],
  rules: string
): Promise<void> {
  const assistants = await adapter.assistants.list.invoke();
  const existing = (assistants ?? []).find(
    (assistant) => assistant.id === config.assistant.id || assistant.name === config.assistant.name
  );

  if (existing) {
    // Retry only a missing rule file; never overwrite a rule the user has edited.
    try {
      const detail = await adapter.assistants.get.invoke({ id: existing.id });
      if (!detail.rules.content.trim() && rules.trim()) {
        await adapter.fs.writeAssistantRule.invoke({ assistant_id: existing.id, content: rules });
      }
    } catch (error) {
      log.warn('[Preset] failed to inspect/fill existing assistant rules', error);
    }
    return;
  }

  if (config.skills.enabled && skillNames.length === 0) {
    log.warn('[Preset] assistant creation deferred because preset Skills are enabled but unavailable');
    return;
  }

  const request: CreateAssistantRequest = {
    id: config.assistant.id,
    name: config.assistant.name,
    description: config.assistant.description,
    avatar: config.assistant.avatar,
    agent_id: config.assistant.agent_id,
    enabled_skills: [],
    custom_skill_names: config.skills.enabled ? skillNames : [],
    recommended_prompts: config.assistant.recommended_prompts,
    defaults: {
      model: { mode: 'fixed', value: config.assistant.default_model },
      // Custom skills are represented by custom_skill_names in the Assistant API.
      skills: { mode: 'fixed', value: [] },
      mcps: { mode: 'fixed', value: [mcpServer.id] },
    },
  };

  await adapter.assistants.create.invoke(request);
  await adapter.assistants.setState.invoke({ id: config.assistant.id, enabled: config.assistant.enabled });
  if (rules.trim()) {
    await adapter.fs.writeAssistantRule.invoke({ assistant_id: config.assistant.id, content: rules });
  }
}

/**
 * Idempotently installs the enterprise preset without overwriting user-entered
 * Provider/MCP credentials or customized existing resources. Remote Skills are
 * the exception: they are explicitly version-managed by the configured mirror.
 */
export async function ensurePresetConfiguration(loadedPreset?: LoadedPresetConfiguration): Promise<boolean> {
  const loaded = loadedPreset ?? (await loadPresetConfiguration());
  const { config, rules } = loaded;
  const validationErrors = getPresetConfigurationValidationErrors(config);
  if (validationErrors.length > 0) {
    console.warn('[Preset] configuration is incomplete; skipping bootstrap. Fix: %s', validationErrors.join(', '));
    return false;
  }

  await ensurePresetProvider(config);
  const mcpServer = await ensurePresetMcp(config);

  let skillNames: string[] = [];
  try {
    skillNames = await ensurePresetSkills(config);
  } catch (error) {
    log.warn('[preset-skills] Skill update failed; keeping the currently installed Skills', error);
    const state = await loadSkillPresetState();
    skillNames = await resolveManagedSkillNames(config, state.names);
  }

  await ensurePresetAssistant(config, mcpServer, skillNames, rules);
  console.info('[Preset] computing platform configuration is ready');
  return true;
}
