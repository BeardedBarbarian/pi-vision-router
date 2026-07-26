/**
 * pi-vision-router — Automatic vision model routing for pi
 *
 * Intercepts image read results and delegates to a vision-capable
 * model when the primary model lacks image support. Transparent
 * to the user — the primary LLM receives text descriptions as if
 * it could read images natively.
 *
 * @packageDocumentation
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

/** Vision-capable model candidates in priority order (cheapest first). */
const VISION_CANDIDATES: ReadonlyArray<{ provider: string; id: string }> = [
  { provider: "neuralwatt", id: "gemma-4-31b" },      // $0.14/M input — cheapest
  { provider: "neuralwatt", id: "qwen3.6-35b-fast" },  // $0.29/M input — balanced
  { provider: "neuralwatt", id: "kimi-k2.6-fast" },    // $0.69/M input — powerful
  { provider: "neuralwatt", id: "kimi-k2.7-code" },    // $0.95/M input — code-tuned
];

const DESCRIBE_PROMPT = [
  "Describe this image in detail. Include:",
  "- What is shown (people, objects, scenes, text, UI elements, charts, etc.)",
  "- Key visual details (colors, layout, positioning, states)",
  "- Any text visible in the image, transcribed verbatim if possible",
  "- Relevant context a developer or analyst would need to understand the image",
  "",
  "Be thorough but concise. The user cannot see this image and relies on your description.",
].join("\n");

/** Maximum retries for vision model calls. */
const MAX_RETRIES = 2;

/** Maximum image data length used for cache key computation. */
const CACHE_KEY_WINDOW = 2000;

// =============================================================================
// Types
// =============================================================================

interface ImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
  };
  image_url?: {
    url: string;
  };
}

interface TextBlock {
  type: "text";
  text: string;
}

type ContentBlock = ImageBlock | TextBlock | { type: string; [key: string]: unknown };

interface ResolvedModel {
  model: NonNullable<ReturnType<ExtensionAPI["modelRegistry"]> extends { find: infer F }
    ? F extends (...args: any[]) => infer R ? NonNullable<R> : never
    : never>;
  apiKey: string;
  headers?: Record<string, string>;
}

// =============================================================================
// Image extraction helpers
// =============================================================================

function computeCacheKey(block: ImageBlock): string {
  // Build a stable cache key from the first and last bytes of image data.
  const sources: string[] = [];

  if (block.data) {
    sources.push(block.data.slice(0, CACHE_KEY_WINDOW));
    if (block.data.length > CACHE_KEY_WINDOW) {
      sources.push(block.data.slice(-CACHE_KEY_WINDOW));
    }
  }
  if (block.source?.data) {
    sources.push(block.source.data.slice(0, CACHE_KEY_WINDOW));
    if (block.source.data.length > CACHE_KEY_WINDOW) {
      sources.push(block.source.data.slice(-CACHE_KEY_WINDOW));
    }
  }
  if (block.image_url?.url) {
    sources.push(block.image_url.url.slice(0, CACHE_KEY_WINDOW));
    if (block.image_url.url.length > CACHE_KEY_WINDOW) {
      sources.push(block.image_url.url.slice(-CACHE_KEY_WINDOW));
    }
  }

  // Simple FNV-1a style hash
  let hash = 2166136261;
  const joined = sources.join("\x00");
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function extractBase64(block: ImageBlock): { data: string; mimeType: string } | null {
  // Direct base64 data
  if (block.data) {
    return { data: block.data, mimeType: block.mimeType ?? "image/png" };
  }

  // OpenAI content-block format: { type: "image_url", image_url: { url: "data:..." } }
  if (block.image_url?.url) {
    const url = block.image_url.url;
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { data: match[2], mimeType: match[1] };
    }
    // URL image (not base64) — we can't describe those without fetching
    return null;
  }

  // pi internal format: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
  if (block.source?.data) {
    return {
      data: block.source.data,
      mimeType: block.source.media_type ?? "image/png",
    };
  }

  // Debug: log block shape when extraction fails
  console.log(
    "[vision-router] extractBase64 FAILED — block keys:",
    JSON.stringify(Object.keys(block)),
    "has data:", !!block.data,
    "has image_url:", !!block.image_url,
    "has source:", !!block.source,
    "source keys:", block.source ? JSON.stringify(Object.keys(block.source)) : "n/a",
  );

  return null;
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image" || block.type === "image_url";
}

// =============================================================================
// Model resolution — returns ALL vision-capable candidates, not just the first
// =============================================================================

async function resolveAllVisionModels(
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]> extends (event: any, ctx: infer C) => any ? C : never,
): Promise<ResolvedModel[]> {
  // ctx.modelRegistry might be undefined in older pi versions
  const registry = (ctx as any).modelRegistry;
  if (!registry?.find || !registry?.getApiKeyAndHeaders) {
    return [];
  }

  const resolved: ResolvedModel[] = [];

  for (const cand of VISION_CANDIDATES) {
    const model = registry.find(cand.provider, cand.id);
    if (!model) continue;

    // Verify this model actually supports images
    if (model.input && !model.input.includes("image")) continue;

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) continue;

    resolved.push({ model, apiKey: auth.apiKey, headers: auth.headers });
  }

  return resolved;
}

// =============================================================================
// Image description — cascades through candidates on failure
// =============================================================================

async function describeImage(
  block: ImageBlock,
  candidates: ResolvedModel[],
  signal: AbortSignal | undefined,
): Promise<{ description: string; modelId: string; error?: string }> {
  const extracted = extractBase64(block);
  if (!extracted) {
    return { description: "[Image: could not extract image data for description]", modelId: "none" };
  }

  const errors: string[] = [];

  for (const candidate of candidates) {
    let lastError = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await complete(
          candidate.model,
          {
            systemPrompt: DESCRIBE_PROMPT,
            messages: [
              {
                role: "user" as const,
                content: [
                  {
                    type: "text" as const,
                    text: "Please describe this image in detail.",
                  },
                  {
                    type: "image" as const,
                    data: extracted.data,
                    mimeType: extracted.mimeType,
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: candidate.apiKey,
            headers: candidate.headers,
            signal,
          },
        );

        // Debug: log raw response content types
        const contentTypes = (response.content ?? []).map((c: unknown) =>
          (c && typeof c === "object" ? (c as { type?: string }).type : typeof c)
        );
        console.log(
          `[vision-router] ${candidate.model.id} raw content types:`,
          JSON.stringify(contentTypes),
          `total blocks: ${(response.content ?? []).length}`,
        );

        const text = (response.content ?? [])
          .filter(
            (c: unknown): c is { type: "text"; text: string } =>
              !!c && typeof c === "object" && (c as { type?: string }).type === "text",
          )
          .map((c) => c.text)
          .join("\n")
          .trim();

        if (text) {
          return { description: text, modelId: candidate.model.id };
        }

        lastError = `empty response (blocks: ${(response.content ?? []).length}, types: [${contentTypes.join(", ")}])`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    errors.push(`${candidate.model.id}: ${lastError}`);
    console.log(`[vision-router] ${candidate.model.id} failed, trying next candidate...`);
  }

  return {
    description: `[Image description failed with all candidates]`,
    modelId: "none",
    error: errors.join("; "),
  };
}

// =============================================================================
// Cache
// =============================================================================

class DescriptionCache {
  private cache = new Map<string, string>();
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    // LRU-like eviction: if at capacity, delete oldest entry
    if (this.cache.size >= this.maxSize) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  const cache = new DescriptionCache();
  let activeCount = 0;

  pi.on("tool_result", async (event, ctx) => {
    // Only intercept built-in read tool
    if (event.toolName !== "read") return;

    // Guard: ensure content is an array
    if (!Array.isArray(event.content)) return;

    // Find image blocks
    const imageBlocks = event.content.filter(isImageBlock);
    if (imageBlocks.length === 0) return;

    // Check if current model already supports images
    const modelInput: string[] = (ctx.model as any)?.input ?? ["text"];
    if (modelInput.includes("image")) return;

    // Resolve all vision-capable models (cascaded fallback)
    const candidates = await resolveAllVisionModels(ctx);
    if (candidates.length === 0) {
      const newContent = event.content.map((block: ContentBlock) => {
        if (isImageBlock(block)) {
          return {
            type: "text" as const,
            text: `[Image present but no vision model available]`,
          };
        }
        return block;
      });
      return { content: newContent };
    }

    // Describe each image, using cache when possible
    activeCount++;
    const newContent: ContentBlock[] = [];

    for (const block of event.content) {
      if (!isImageBlock(block)) {
        newContent.push(block);
        continue;
      }

      const cacheKey = computeCacheKey(block);
      const cached = cache.get(cacheKey);
      if (cached) {
        newContent.push({ type: "text", text: cached });
        continue;
      }

      const result = await describeImage(block, candidates, ctx.signal);
      const label = result.modelId !== "none" ? result.modelId : "(failed)";
      let text: string;
      if (result.error) {
        text = `[🖼️ Image — all candidates failed: ${result.error}]`;
      } else {
        text = `[🖼️ Image described by ${label}]\n\n${result.description}`;
      }
      cache.set(cacheKey, text);
      newContent.push({ type: "text", text });
    }

    return { content: newContent };
  });

  // Status line: show active vision-routing count
  pi.on("agent_settled", () => {
    activeCount = 0;
  });
}
