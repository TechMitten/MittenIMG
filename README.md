<div align="center">

<img src="media/icon.svg" width="64" height="64" alt="ImageMitten icon" />

# ImageMitten

**Generate images for your project without leaving VS Code.**

ImageMitten reads your codebase for context, enhances your prompt with an LLM, and generates an image — right from the sidebar.

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Configuration](#configuration) • [How it works](#how-it-works)

</div>

---

## Features

- 🖼️ **In-editor image generation** — describe what you want in a sidebar panel and get an image back, no browser tab required.
- 🧠 **Codebase-aware prompts** — optionally scans your open workspace and feeds it to an LLM so the generated prompt reflects your project's actual context (framework, theme, naming, etc.), not just your raw text.
- ✏️ **Image editing / iteration** — take a generated image and use it as the base for a follow-up edit, so you can refine results turn by turn.
- 📐 **Size presets & custom dimensions** — square, landscape, portrait, high-res, or set your own width/height.
- 🔄 **Format conversion** — convert and save results as PNG, JPEG, or WebP with adjustable quality, directly from the panel.
- 💾 **Auto-save to workspace** — every generated image is written to an `imagemitten/` folder in your project.
- 📄 **Built-in logging** — an output channel shows exactly what was sent and received for easy debugging.

## Installation

> ImageMitten is not yet published to the VS Code Marketplace. To try it locally:

```bash
git clone https://github.com/TechMitten/image-extension.git
cd image-extension
npm install
```

Then, in VS Code:

1. Open the folder in VS Code.
2. Press `F5` to launch an Extension Development Host with ImageMitten loaded.

Or package it yourself:

```bash
npm run package
npx vsce package
```

This produces a `.vsix` file you can install via **Extensions → ... → Install from VSIX**.

## Usage

1. Open the **ImageMitten** icon in the Activity Bar.
2. Type a description of the image you want in the prompt box.
3. Pick a size preset (or choose **Custom...** to set your own width/height).
4. Click **Generate**.
5. Once the image appears:
   - Click **Edit This Image** to use it as the base for a follow-up generation.
   - Expand **🔄 Convert to another format** to save it as PNG, JPEG, or WebP.
   - Expand **Prompt Used** to see exactly what prompt was sent to the image model.

Use the toolbar buttons to **📄 View Logs** (open the output channel), open **⚙️ Settings**, or toggle **🌐 Context** (codebase-aware prompting) on/off.

Generated images are automatically saved to an `imagemitten/` folder at the root of your workspace.

## Configuration

Configure ImageMitten under **Settings → Extensions → ImageMitten**, or by editing `settings.json`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `imagemitten.useCodebaseContext` | `boolean` | `true` | When enabled, scans your workspace files and uses an LLM to enrich your prompt with project context before generating an image. When disabled, your prompt is sent as-is. |
| `imagemitten.pollinationsApiKey` | `string` | `""` | Your Pollinations API key, used for LLM prompt enhancement, image editing, and authenticated image generation. |

```json
{
  "imagemitten.useCodebaseContext": true,
  "imagemitten.pollinationsApiKey": "YOUR_API_KEY"
}
```

> **Note:** Without an API key, ImageMitten skips prompt enhancement and image editing but will still attempt basic image generation.

## How it works

```mermaid
flowchart LR
    A[Your prompt] --> B{Codebase context enabled?}
    B -- yes --> C[Scan workspace files]
    C --> D[Send prompt + context to LLM]
    D --> E[Enhanced prompt]
    B -- no --> E
    E --> F[Request image from Pollinations]
    F --> G[Save to workspace<br/>imagemitten/]
    F --> H[Preview in sidebar]
```

1. **Context gathering** — if enabled, ImageMitten walks your workspace (excluding `node_modules`, `.git`, `dist`, `out`) and builds a text blob of file contents, capped at a reasonable size.
2. **Prompt enhancement** — that context, along with your prompt, is sent to a text model via the Pollinations API, which returns a richer, more specific image-generation prompt.
3. **Image generation** — the enhanced prompt is sent to Pollinations' image endpoint, with support for custom dimensions and, when editing, a base image.
4. **Delivery** — the resulting image is streamed back into the sidebar and saved into an `imagemitten/` folder in your workspace.

All requests and responses are logged to the **ImageMitten** output channel for transparency and troubleshooting.

## Requirements

- VS Code `^1.74.0` or later
- A [Pollinations](https://pollinations.ai) API key (optional, but required for prompt enhancement and image editing)

## Development

```bash
npm install       # install dependencies
npm run watch     # webpack in watch mode
npm run lint      # lint the source
npm test          # compile and run the test suite
```

Press `F5` in VS Code to launch the Extension Development Host and iterate live.

## Privacy note

When codebase context is enabled, file contents from your open workspace are sent to a third-party LLM endpoint (via Pollinations) to enhance your prompt. Disable **🌐 Context** in the sidebar, or set `imagemitten.useCodebaseContext` to `false`, if you'd rather your prompt be sent as-is.

## License

No license has been specified for this project yet.
