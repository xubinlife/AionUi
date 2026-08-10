/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@/common/types/provider/authType';
import { getProviderAuthType } from '@/common/utils/platformAuthType';

/**
 * API mode used by the built-in image generation tool.
 *
 * - chat_completions: multimodal chat model returns images through message.images
 *   or markdown data URLs.
 * - images_generations: OpenAI-compatible POST /v1/images/generations.
 */
export type ImageGenerationApiMode = 'chat_completions' | 'images_generations';

type ProviderShape = {
  platform?: string;
  base_url?: string;
  name?: string;
  model_protocols?: Record<string, string>;
};

const CHAT_IMAGE_NAME_PATTERN = /(image|banana|imagine)/i;
const IMAGES_API_MODEL_PATTERN = /(image|imagine|dall|flux|diffusion|cogview|imagen)/i;

/** Providers whose image-capable models generate through chat completions. */
const CHAT_COMPLETIONS_RULES: Array<{
  id: string;
  match: (provider: ProviderShape) => boolean;
}> = [
  {
    id: 'gemini',
    match: (p) => p.platform === 'gemini' || p.platform === 'gemini-vertex-ai',
  },
  {
    id: 'openrouter',
    match: (p) => !!p.base_url?.includes('openrouter.ai'),
  },
  {
    id: 'antigravity',
    match: (p) => !!p.name?.toLowerCase().includes('antigravity'),
  },
];

/**
 * Resolve how the selected provider/model must be invoked.
 *
 * Existing Gemini/OpenRouter/Antigravity behavior takes priority. Other
 * OpenAI-compatible providers with an image-model name use Images API.
 */
export const getImageGenerationApiMode = (
  provider: ProviderShape,
  modelName: string
): ImageGenerationApiMode | null => {
  if (CHAT_IMAGE_NAME_PATTERN.test(modelName) && CHAT_COMPLETIONS_RULES.some((rule) => rule.match(provider))) {
    return 'chat_completions';
  }

  if (!IMAGES_API_MODEL_PATTERN.test(modelName)) {
    return null;
  }

  const authType = getProviderAuthType({
    platform: provider.platform || '',
    model_protocols: provider.model_protocols,
    use_model: modelName,
  });

  return authType === AuthType.USE_OPENAI ? 'images_generations' : null;
};

export const isImageGenSupported = (provider: ProviderShape, modelName: string): boolean => {
  return getImageGenerationApiMode(provider, modelName) !== null;
};
