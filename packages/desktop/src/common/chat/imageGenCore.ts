/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared image generation logic used by both:
 * - The built-in MCP server (imageGenServer.ts)
 * - The legacy Gemini-specific tool (img-gen.ts)
 */

import * as fs from 'fs';
import * as path from 'path';
import { jsonrepair } from 'jsonrepair';
import OpenAI, { toFile } from 'openai';
import { ClientFactory, type RotatingClient } from '@/common/api/ClientFactory';
import type { TProviderWithModel } from '@/common/config/storage';
import type { UnifiedChatCompletionResponse } from '@/common/api/RotatingApiClient';
import { IMAGE_EXTENSIONS, MIME_TYPE_MAP, MIME_TO_EXT_MAP, DEFAULT_IMAGE_EXTENSION } from '@/common/config/constants';
import { getImageGenerationApiMode } from '@/common/utils/imageModelAllowlist';

const API_TIMEOUT_MS = 120000;
const IMAGE_SIZE_PATTERN = /(\d{1,5})\s*(?:x|X|×|\*)\s*(\d{1,5})/;

type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

// ===== Path Boundary Helpers =====

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const resolveSafePath = async (workspaceDir: string, candidate: string): Promise<string> => {
  const resolved = path.resolve(workspaceDir, candidate);
  if (!isWithin(workspaceDir, resolved)) {
    throw new Error(`Path traversal blocked: "${candidate}" resolves outside workspace`);
  }

  const realWorkspaceDir = await fs.promises.realpath(workspaceDir);
  let realTarget: string;
  try {
    realTarget = await fs.promises.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved;
    }
    throw error;
  }
  if (!isWithin(realWorkspaceDir, realTarget)) {
    throw new Error(`Path traversal blocked: "${candidate}" resolves outside workspace`);
  }
  return realTarget;
};

// ===== Utility Functions =====

export function safeJsonParse<T = unknown>(jsonString: string, fallbackValue: T): T {
  if (!jsonString || typeof jsonString !== 'string') return fallbackValue;
  try {
    return JSON.parse(jsonString) as T;
  } catch (_error) {
    try {
      const repairedJson = jsonrepair(jsonString);
      return JSON.parse(repairedJson) as T;
    } catch (_repairError) {
      console.warn('[ImageGen] JSON parse failed:', jsonString.substring(0, 50));
      return fallbackValue;
    }
  }
}

export function isImageFile(file_path: string): boolean {
  const ext = path.extname(file_path).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext as ImageExtension);
}

export function isHttpUrl(str: string): boolean {
  return str.startsWith('http://') || str.startsWith('https://');
}

export async function fileToBase64(file_path: string): Promise<string> {
  try {
    const fileBuffer = await fs.promises.readFile(file_path);
    return fileBuffer.toString('base64');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
      throw new Error(`Image file not found: ${file_path}`, { cause: error });
    }
    throw new Error(`Failed to read image file: ${errorMessage}`, { cause: error });
  }
}

export function getImageMimeType(file_path: string): string {
  const ext = path.extname(file_path).toLowerCase();
  return MIME_TYPE_MAP[ext] || MIME_TYPE_MAP[DEFAULT_IMAGE_EXTENSION];
}

export function getFileExtensionFromDataUrl(dataUrl: string): string {
  const mimeTypeMatch = dataUrl.match(/^data:image\/([^;]+);base64,/);
  if (mimeTypeMatch && mimeTypeMatch[1]) {
    const mimeType = mimeTypeMatch[1].toLowerCase();
    return MIME_TO_EXT_MAP[mimeType] || DEFAULT_IMAGE_EXTENSION;
  }
  return DEFAULT_IMAGE_EXTENSION;
}

export function normalizeImageSize(size?: string): string | undefined {
  if (!size || typeof size !== 'string') return undefined;
  const match = size.match(IMAGE_SIZE_PATTERN);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  return `${width}x${height}`;
}

async function saveGeneratedImageBuffer(imageBuffer: Buffer, workspaceDir: string, fileExtension: string): Promise<string> {
  const timestamp = Date.now();
  const file_name = `img-${timestamp}${fileExtension}`;
  const resolvedDir = path.resolve(workspaceDir);
  const file_path = path.join(resolvedDir, file_name);
  try {
    await fs.promises.writeFile(file_path, imageBuffer);
    return file_path;
  } catch (error) {
    console.error('[ImageGen] Failed to save image file:', error);
    throw new Error(`Failed to save image: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function saveGeneratedImage(base64Data: string, workspaceDir: string): Promise<string> {
  const fileExtension = getFileExtensionFromDataUrl(base64Data);
  const base64WithoutPrefix = base64Data.replace(/^data:image\/[^;]+;base64,/, '');
  const imageBuffer = Buffer.from(base64WithoutPrefix, 'base64');
  return saveGeneratedImageBuffer(imageBuffer, workspaceDir, fileExtension);
}

function getFileExtensionFromRemoteImage(imageUrl: string, contentType: string | null): string {
  const normalizedContentType = contentType?.split(';')[0].trim().toLowerCase();
  if (normalizedContentType?.startsWith('image/')) {
    const subtype = normalizedContentType.slice('image/'.length);
    const extension = MIME_TO_EXT_MAP[subtype];
    if (extension) return extension;
  }
  try {
    const urlExtension = path.extname(new URL(imageUrl).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(urlExtension as ImageExtension)) return urlExtension;
  } catch (_error) {}
  return DEFAULT_IMAGE_EXTENSION;
}

async function saveGeneratedImageFromUrl(imageUrl: string, workspaceDir: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(imageUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download generated image: HTTP ${response.status} ${response.statusText}`);
  }
  const imageBuffer = Buffer.from(await response.arrayBuffer());
  const fileExtension = getFileExtensionFromRemoteImage(imageUrl, response.headers.get('content-type'));
  return saveGeneratedImageBuffer(imageBuffer, workspaceDir, fileExtension);
}

interface ImageContent {
  type: 'image_url';
  image_url: { url: string; detail: 'auto' | 'low' | 'high' };
}

export async function processImageUri(imageUri: string, workspaceDir: string): Promise<ImageContent | null> {
  if (isHttpUrl(imageUri)) {
    return { type: 'image_url', image_url: { url: imageUri, detail: 'auto' } };
  }

  let processedUri = imageUri;
  if (imageUri.startsWith('@')) processedUri = imageUri.substring(1);
  const fullPath = await resolveSafePath(workspaceDir, processedUri);

  try {
    await fs.promises.access(fullPath, fs.constants.F_OK);
    if (!isImageFile(fullPath)) throw new Error(`File is not a supported image type: ${fullPath}`);
    const base64Data = await fileToBase64(fullPath);
    const mimeType = getImageMimeType(fullPath);
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}`, detail: 'auto' } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes('Path traversal blocked') ||
      errorMessage.includes('Image file not found') ||
      errorMessage.includes('not a supported image type')
    ) {
      throw error;
    }
    const possiblePaths = [imageUri, path.resolve(workspaceDir, imageUri)].filter((p, i, arr) => arr.indexOf(p) === i);
    throw new Error(
      `Image file not found. Searched paths:\n${possiblePaths.map((p) => `- ${p}`).join('\n')}\n\nPlease ensure the image file exists and has a valid image extension (.jpg, .png, .gif, .webp, etc.)`,
      { cause: error }
    );
  }
}

interface ImageUploadSource {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

async function loadImageUploadSource(imageUri: string, workspaceDir: string, signal?: AbortSignal): Promise<ImageUploadSource> {
  if (isHttpUrl(imageUri)) {
    const response = await fetch(imageUri, { signal });
    if (!response.ok) throw new Error(`Failed to download input image: HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const mimeType = contentType?.startsWith('image/') ? contentType : 'image/png';
    let filename = 'input.png';
    try {
      filename = path.basename(new URL(imageUri).pathname) || filename;
    } catch (_error) {}
    return { buffer: Buffer.from(await response.arrayBuffer()), filename, mimeType };
  }

  const normalizedUri = imageUri.startsWith('@') ? imageUri.substring(1) : imageUri;
  const fullPath = await resolveSafePath(workspaceDir, normalizedUri);
  await fs.promises.access(fullPath, fs.constants.F_OK);
  if (!isImageFile(fullPath)) throw new Error(`File is not a supported image type: ${fullPath}`);
  return {
    buffer: await fs.promises.readFile(fullPath),
    filename: path.basename(fullPath),
    mimeType: getImageMimeType(fullPath),
  };
}

export interface ImageGenParams {
  prompt: string;
  image_uris?: string[] | string;
  size?: string;
}

export interface ImageGenResult {
  success: boolean;
  text: string;
  imagePath?: string;
  relativeImagePath?: string;
  error?: string;
}

function resolveImageSize(params: ImageGenParams): string | undefined {
  const explicitSize = normalizeImageSize(params.size);
  if (explicitSize) return explicitSize;
  return normalizeImageSize(params.prompt);
}

async function saveImagesApiResponse(
  response: OpenAI.Images.ImagesResponse,
  provider: TProviderWithModel,
  workspaceDir: string,
  operation: 'generated' | 'edited',
  signal?: AbortSignal
): Promise<ImageGenResult> {
  const firstImage = response.data?.[0];
  if (!firstImage) {
    return { success: false, text: `No image was returned by the Images API (${operation}).`, error: 'No image returned' };
  }

  let imagePath: string;
  if (firstImage.b64_json) {
    const imageData = firstImage.b64_json.startsWith('data:image/')
      ? firstImage.b64_json
      : `data:image/png;base64,${firstImage.b64_json}`;
    imagePath = await saveGeneratedImage(imageData, workspaceDir);
  } else if (firstImage.url) {
    if (firstImage.url.startsWith('data:image/')) {
      imagePath = await saveGeneratedImage(firstImage.url, workspaceDir);
    } else {
      const resolvedImageUrl = isHttpUrl(firstImage.url)
        ? firstImage.url
        : new URL(firstImage.url, provider.base_url).toString();
      imagePath = await saveGeneratedImageFromUrl(resolvedImageUrl, workspaceDir, signal);
    }
  } else {
    return { success: false, text: 'Images API response contains neither b64_json nor url.', error: 'Invalid Images API response' };
  }

  const relativeImagePath = path.relative(workspaceDir, imagePath);
  const responseText = firstImage.revised_prompt || `Image ${operation} successfully.`;
  return {
    success: true,
    text: `${responseText}\n\n${operation === 'edited' ? 'Edited' : 'Generated'} image saved to: ${imagePath}`,
    imagePath,
    relativeImagePath,
  };
}

async function executeImagesApiGeneration(
  params: ImageGenParams,
  provider: TProviderWithModel,
  rotatingClient: RotatingClient,
  workspaceDir: string,
  signal?: AbortSignal
): Promise<ImageGenResult> {
  if (!('createImage' in rotatingClient)) {
    throw new Error(`Provider ${provider.platform} does not support the OpenAI Images API client.`);
  }
  const imageSize = resolveImageSize(params);
  const response = await rotatingClient.createImage(
    {
      model: provider.use_model,
      prompt: params.prompt,
      ...(imageSize ? { size: imageSize as OpenAI.Images.ImageGenerateParams['size'] } : {}),
    },
    { signal, timeout: API_TIMEOUT_MS }
  );
  return saveImagesApiResponse(response, provider, workspaceDir, 'generated', signal);
}

async function executeImagesApiEdit(
  params: ImageGenParams,
  imageUris: string[],
  provider: TProviderWithModel,
  rotatingClient: RotatingClient,
  workspaceDir: string,
  signal?: AbortSignal
): Promise<ImageGenResult> {
  if (!('createImageEdit' in rotatingClient)) {
    throw new Error(`Provider ${provider.platform} does not support the OpenAI Images Edit API client.`);
  }
  const sources = await Promise.all(imageUris.map((imageUri) => loadImageUploadSource(imageUri, workspaceDir, signal)));
  const uploads = await Promise.all(sources.map((source) => toFile(source.buffer, source.filename, { type: source.mimeType })));
  const imageSize = resolveImageSize(params);
  const response = await rotatingClient.createImageEdit(
    {
      model: provider.use_model,
      prompt: params.prompt,
      image: uploads.length === 1 ? uploads[0] : uploads,
      ...(imageSize ? { size: imageSize as OpenAI.Images.ImageEditParams['size'] } : {}),
    },
    { signal, timeout: API_TIMEOUT_MS }
  );
  return saveImagesApiResponse(response, provider, workspaceDir, 'edited', signal);
}

export async function executeImageGeneration(
  params: ImageGenParams,
  provider: TProviderWithModel,
  workspaceDir: string,
  proxy?: string,
  signal?: AbortSignal
): Promise<ImageGenResult> {
  if (signal?.aborted) {
    return { success: false, text: 'Image generation was cancelled.', error: 'cancelled' };
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolvedWorkspaceDir);
  } catch {
    return {
      success: false,
      text: `Workspace directory not found: ${resolvedWorkspaceDir}`,
      error: `Workspace directory not found: ${resolvedWorkspaceDir}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      success: false,
      text: `Workspace path is not a directory: ${resolvedWorkspaceDir}`,
      error: `Workspace path is not a directory: ${resolvedWorkspaceDir}`,
    };
  }

  try {
    let imageUris: string[] = [];
    if (params.image_uris) {
      if (typeof params.image_uris === 'string') {
        const parsed = safeJsonParse<string[]>(params.image_uris, null);
        imageUris = Array.isArray(parsed) ? parsed : [params.image_uris];
      } else if (Array.isArray(params.image_uris)) {
        imageUris = params.image_uris;
      }
    }

    const hasImages = imageUris.length > 0;
    const imageSize = resolveImageSize(params);
    const sizeInstruction = imageSize ? ` Output image size: ${imageSize}.` : '';
    const enhancedPrompt = hasImages
      ? `Analyze/Edit image: ${params.prompt}${sizeInstruction}`
      : `Generate image: ${params.prompt}${sizeInstruction}`;

    const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: enhancedPrompt }];

    if (hasImages) {
      const imageResults = await Promise.allSettled(imageUris.map((uri) => processImageUri(uri, resolvedWorkspaceDir)));
      const successful: ImageContent[] = [];
      const errors: string[] = [];
      imageResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          successful.push(result.value);
        } else {
          const error = result.status === 'rejected' ? result.reason : 'Unknown error';
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`Image ${index + 1} (${imageUris[index]}): ${errorMessage}`);
        }
      });
      successful.forEach((imageContent) => contentParts.push(imageContent));
      if (successful.length === 0) {
        return { success: false, text: `Error: Failed to process any images. Errors:\n${errors.join('\n')}`, error: errors.join('\n') };
      }
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content: contentParts }];

    const rotatingClient: RotatingClient = await ClientFactory.createRotatingClient(provider, {
      proxy,
      rotatingOptions: { maxRetries: 3, retryDelay: 1000 },
    });

    const imageApiMode = getImageGenerationApiMode(provider, provider.use_model);
    if (imageApiMode === 'images_generations') {
      if (hasImages) {
        return await executeImagesApiEdit(params, imageUris, provider, rotatingClient, resolvedWorkspaceDir, signal);
      }
      return await executeImagesApiGeneration(params, provider, rotatingClient, resolvedWorkspaceDir, signal);
    }

    const completion: UnifiedChatCompletionResponse = await rotatingClient.createChatCompletion(
      { model: provider.use_model, messages: messages as any },
      { signal, timeout: API_TIMEOUT_MS }
    );

    const choice = completion.choices[0];
    if (!choice) return { success: false, text: 'No response from image generation API', error: 'No response' };

    const responseText = choice.message.content || 'Image generated successfully.';
    let images = choice.message.images;

    if ((!images || images.length === 0) && responseText) {
      const dataUrlRegex = /!\[[^\]]*\]\((data:image\/[^;]+;base64,[^)]+)\)/g;
      const dataUrlMatches = [...responseText.matchAll(dataUrlRegex)];
      if (dataUrlMatches.length > 0) {
        images = dataUrlMatches.map((match) => ({ type: 'image_url' as const, image_url: { url: match[1] } }));
      } else {
        const file_pathRegex = /!\[[^\]]*\]\(([^)]+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff|svg))\)/gi;
        const file_pathMatches = [...responseText.matchAll(file_pathRegex)];
        if (file_pathMatches.length > 0) {
          const processedImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
          for (const match of file_pathMatches) {
            const file_path = match[1];
            try {
              const fullPath = await resolveSafePath(resolvedWorkspaceDir, file_path);
              await fs.promises.access(fullPath);
              const base64Data = await fileToBase64(fullPath);
              const mimeType = getImageMimeType(fullPath);
              processedImages.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } });
            } catch (_fileError) {
              console.warn(`[ImageGen] Could not load image file: ${file_path}`);
            }
          }
          if (processedImages.length > 0) images = processedImages;
        }
      }
    }

    if (!images || images.length === 0) {
      const warningMessage = `Image generation did not produce any images.\n\nModel response: ${responseText}\n\nTip: Make sure your image generation model supports this type of request. Current model: ${provider.use_model}`;
      return { success: true, text: warningMessage };
    }

    const firstImage = images[0];
    if (firstImage.type === 'image_url' && firstImage.image_url?.url) {
      const imagePath = await saveGeneratedImage(firstImage.image_url.url, resolvedWorkspaceDir);
      const relativeImagePath = path.relative(resolvedWorkspaceDir, imagePath);
      const cleanText = responseText.replace(/!\[[^\]]*\]\(data:image\/[^;]+;base64,[^)]+\)/g, '[embedded image extracted]');
      return {
        success: true,
        text: `${cleanText}\n\nGenerated image saved to: ${imagePath}`,
        imagePath,
        relativeImagePath,
      };
    }

    return { success: true, text: responseText };
  } catch (error) {
    if (signal?.aborted) return { success: false, text: 'Image generation was cancelled.', error: 'cancelled' };
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ImageGen] API call failed:`, error);
    return { success: false, text: `Error generating image: ${errorMessage}`, error: errorMessage };
  }
}
