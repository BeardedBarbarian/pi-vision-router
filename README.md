# pi-vision-router

![pi-vision-router logo](assets/logo.png)

Automatic vision model routing for [pi](https://github.com/earendil-works/pi) — delegates image analysis to vision-capable models when the primary LLM lacks image support.

## Problem

You ask your coding agent to read a screenshot. The `read` tool returns the image, but your model (e.g., DeepSeek) can't process images. You get:

> *"Current model does not support images. The image will be omitted."*

You have to manually switch models, re-ask, then switch back. Annoying.

## Solution

pi-vision-router intercepts image `read` results at the `tool_result` level. When the current model can't handle images, it:

1. Finds the cheapest vision-capable model in your registry
2. Makes a one-shot API call: *"Describe this image in detail"*
3. Replaces the image content with the text description
4. The primary LLM continues as if it could read images natively

All of this happens transparently — no model switching, no re-prompts.

```
User: "read the screenshot"
  → read returns image/png
  → router: deepseek can't do images → delegate to gemma-4-31b
  → gemma-4-31b: "This screenshot shows a Home Assistant dashboard..."
  → deepseek receives text description, continues working
```

## Installation

```bash
pi install github:BeardedBarbarian/pi-vision-router
```

Or symlink for development:

```bash
ln -sf ~/workspace/pi-vision-router/src/index.ts ~/.pi/agent/extensions/vision-router/index.ts
```

Then `/reload` in pi.

## Requirements

- pi with the `pi-mcp-adapter` extension installed
- At least one vision-capable model configured (e.g., `gemma-4-31b` on neuralwatt)

## How it works

### Architecture

```
pi-vision-router
  ├── tool_result hook (intercept read results)
  ├── Model resolution (find cheapest vision model)
  ├── Image extraction (handle base64, data URLs, pi internal format)
  ├── Vision API call (one-shot describe via complete())
  └── LRU cache (avoid re-describing the same image)
```

### Model selection

Priority order (cheapest first):

| Model | Provider | Input cost |
|-------|----------|------------|
| Gemma 4 31B | neuralwatt | $0.14/M |
| Qwen3.6 35B Fast | neuralwatt | $0.29/M |
| Kimi K2.6 Fast | neuralwatt | $0.69/M |
| Kimi K2.7 Code | neuralwatt | $0.95/M |

The first model that is (a) configured, (b) has an API key, and (c) lists `image` in its input capabilities is used. If none are available, the extension gracefully degrades with a text note.

### Caching

Image descriptions are cached by a content-based hash (FNV-1a over first + last 2KB of image data). This means:

- Reading the same screenshot twice only calls the vision model once
- Different images get different cache keys
- LRU eviction keeps the cache bounded at 50 entries

## Configuration

No configuration needed. It just works™.

To change the vision model priority, edit `VISION_CANDIDATES` in `src/index.ts`.

## License

MIT
