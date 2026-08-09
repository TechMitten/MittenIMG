import * as vscode from 'vscode';
import axios from 'axios';
import { Buffer } from 'buffer';

const outputChannel = vscode.window.createOutputChannel('Image Generator');

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(outputChannel);

  const provider = new ImageGeneratorViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('image-generator-sidebar.view', provider)
  );

  let disposable = vscode.commands.registerCommand('image-generator-ext.start', () => {
    vscode.commands.executeCommand('image-generator-sidebar.view.focus');
  });

  context.subscriptions.push(disposable);
}

class ImageGeneratorViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    this._updateHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'generate':
          await this.handleGenerate(message.text, message.width, message.height, message.baseImageUrl);
          break;
        case 'showOutput':
          outputChannel.show();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'image-generator');
          break;
        case 'toggleContext':
          vscode.workspace.getConfiguration('image-generator').update('useCodebaseContext', message.value, vscode.ConfigurationTarget.Global);
          break;
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('image-generator.useCodebaseContext')) {
        const config = vscode.workspace.getConfiguration('image-generator');
        const useCodebaseContext = config.get<boolean>('useCodebaseContext', true);
        this._view?.webview.postMessage({ command: 'updateContextToggle', value: useCodebaseContext });
      }
    });
    
    webviewView.onDidDispose(() => {
      configListener.dispose();
    });
  }

  private _updateHtml() {
    if (!this._view) return;
    const config = vscode.workspace.getConfiguration('image-generator');
    const useCodebaseContext = config.get<boolean>('useCodebaseContext', true);
    this._view.webview.html = this._getMainHtml(useCodebaseContext);
  }

  private async handleGenerate(userPrompt: string, width?: string, height?: string, baseImageUrl?: string) {
    if (!this._view) return;

    outputChannel.appendLine('========================================');
    outputChannel.appendLine(`[Generation Started] Prompt: "${userPrompt}"`);

    let configVars: Record<string, string> = {
      POLLINATIONS_TEXT_MODEL: 'openai',
      POLLINATIONS_TEXT_ENDPOINT: 'https://gen.pollinations.ai/v1/chat/completions',
      POLLINATIONS_IMAGE_ENDPOINT: 'https://gen.pollinations.ai/image/',
      POLLINATIONS_IMAGE_MODEL: 'zimage',
      POLLINATIONS_IMAGE_WIDTH: width || '512',
      POLLINATIONS_IMAGE_HEIGHT: height || '512',
      POLLINATIONS_IMAGE_NOLOGO: 'true'
    };

    const config = vscode.workspace.getConfiguration('image-generator');
    const apiKey = config.get<string>('pollinationsApiKey');
    const useCodebaseContext = config.get<boolean>('useCodebaseContext', true);

    try {
      let enhancedPrompt = userPrompt;

      if (useCodebaseContext && !baseImageUrl) {
        let codebaseContext = "No workspace found.";
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        this._view.webview.postMessage({ command: 'status', text: 'Reading workspace files...' });
        outputChannel.appendLine('[Context] Reading workspace files...');
        
        const uris = await vscode.workspace.findFiles('**/*.*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}');
        let allCode = '';
        
        for (const uri of uris) {
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            const text = document.getText();
            allCode += `\n--- File: ${vscode.workspace.asRelativePath(uri)} ---\n${text}\n`;
            
            if (allCode.length > 100000) { 
              allCode += `\n... (truncated for context limits) ...\n`;
              break;
            }
          } catch (e) {
            // ignore files that can't be opened
          }
        }
        codebaseContext = allCode || "Workspace is empty.";
        outputChannel.appendLine(`[Context] Collected context (${codebaseContext.length} chars).`);
      }

      this._view.webview.postMessage({ command: 'status', text: 'Analyzing codebase and generating prompt...' });

      const llmEndpoint = configVars['POLLINATIONS_TEXT_ENDPOINT'];

      outputChannel.appendLine(`[Text LLM] Sending prompt enhancement request to ${llmEndpoint}...`);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        outputChannel.appendLine('[Auth] Using configured Pollinations API key.');
        
        try {
          const response = await axios.post(
            llmEndpoint,
            {
              model: configVars['POLLINATIONS_TEXT_MODEL'],
              messages: [
                {
                  role: 'system',
                  content: 'You are an AI assistant that helps developers generate images for their projects. Based on the codebase context and user prompt, create a highly detailed image generation prompt. Respond ONLY with the image prompt.'
                },
                {
                  role: 'user',
                  content: `Codebase Context:\n${codebaseContext}\n\nUser Request: ${userPrompt}\n\nProvide the image generation prompt:`
                }
              ]
            },
            { headers }
          );

          enhancedPrompt = response.data?.choices?.[0]?.message?.content?.trim() || userPrompt;
          outputChannel.appendLine(`[Text LLM Success] Enhanced prompt: "${enhancedPrompt}"`);
        } catch (llmError: any) {
          const status = llmError.response?.status;
          const errDetails = JSON.stringify(llmError.response?.data || llmError.message);
          outputChannel.appendLine(`[Text LLM Warning] Status ${status}: ${errDetails}`);
          
          if (status === 401) {
            vscode.window.showWarningMessage('Text model returned 401 Unauthorized (Pollinations API key required for LLM prompt analysis). Using original prompt directly for image generation.');
          } else {
            vscode.window.showWarningMessage(`Prompt enhancement failed (${llmError.message}). Using original prompt directly.`);
          }
          enhancedPrompt = userPrompt;
        }
      } else {
        outputChannel.appendLine('[Auth] No API key configured. Skipping prompt enhancement step.');
      }
      } else {
        if (baseImageUrl) {
          outputChannel.appendLine('[Context] Image edit mode. Skipping codebase context and using exact prompt.');
        } else {
          outputChannel.appendLine('[Context] Codebase context is disabled. Using original prompt directly.');
        }
      }
      
      let uploadedImageUrl = baseImageUrl;

      if (baseImageUrl && baseImageUrl.startsWith('data:')) {
        outputChannel.appendLine('[Image Edit] Base image is base64. Uploading to media.pollinations.ai...');
        if (!apiKey) {
           throw new Error("An API key is required to upload images for editing.");
        }
        try {
          const uploadRes = await axios.post('https://media.pollinations.ai/upload', {
            data: baseImageUrl,
            contentType: 'image/png',
            name: 'base_image.png'
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            }
          });
          
          if (typeof uploadRes.data === 'string' && uploadRes.data.startsWith('http')) {
            uploadedImageUrl = uploadRes.data;
          } else if (uploadRes.data && uploadRes.data.url) {
            uploadedImageUrl = uploadRes.data.url;
          } else {
            uploadedImageUrl = uploadRes.data; // fallback
          }
          outputChannel.appendLine(`[Image Edit] Uploaded base image successfully: ${uploadedImageUrl}`);
        } catch (uploadErr: any) {
          throw new Error(`Failed to upload base image: ${uploadErr.message}`);
        }
      }

      const encodedPrompt = encodeURIComponent(enhancedPrompt);
      let imgModel = encodeURIComponent(configVars['POLLINATIONS_IMAGE_MODEL']);
      
      if (uploadedImageUrl) {
        imgModel = encodeURIComponent('gpt-image-2');
      }

      const imgWidth = encodeURIComponent(configVars['POLLINATIONS_IMAGE_WIDTH']);
      const imgHeight = encodeURIComponent(configVars['POLLINATIONS_IMAGE_HEIGHT']);
      const imgNologo = encodeURIComponent(configVars['POLLINATIONS_IMAGE_NOLOGO']);
      
      const imgEndpoint = configVars['POLLINATIONS_IMAGE_ENDPOINT'].replace(/\/$/, '') + '/';
      let imageUrl = `${imgEndpoint}${encodedPrompt}?model=${imgModel}&width=${imgWidth}&height=${imgHeight}&nologo=${imgNologo}`;

      if (uploadedImageUrl) {
        imageUrl += `&image=${encodeURIComponent(uploadedImageUrl as string)}`;
      }

      outputChannel.appendLine(`[Image Gen] Image URL: ${imageUrl}`);

      // Fetch the image
      const axiosConfig: any = { responseType: 'arraybuffer' };
      if (apiKey) {
        axiosConfig.headers = { Authorization: `Bearer ${apiKey}` };
      }
      const response = await axios.get(imageUrl, axiosConfig);
      const imageBuffer = Buffer.from(response.data);
      const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;

      let savedPath = '';
      // Save image to workspace
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
        const imageGenFolderUri = vscode.Uri.joinPath(workspaceUri, 'imagegen');
        await vscode.workspace.fs.createDirectory(imageGenFolderUri);
        const fileName = `image_${Date.now()}.png`;
        const fileUri = vscode.Uri.joinPath(imageGenFolderUri, fileName);
        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(imageBuffer));
        savedPath = fileUri.fsPath;
        outputChannel.appendLine(`[Image Gen] Saved image to ${savedPath}`);
      }

      this._view.webview.postMessage({ command: 'result', imageUrl: base64Image, sourceUrl: imageUrl, enhancedPrompt });
      outputChannel.appendLine(`[Generation Completed] Successfully sent image to webview${savedPath ? ' and saved to workspace' : ''}.`);

    } catch (error: any) {
      outputChannel.appendLine(`[Fatal Error] ${error.message}`);
      vscode.window.showErrorMessage(`Failed to generate: ${error.message}`);
      this._view.webview.postMessage({ command: 'status', text: `Failed to generate: ${error.message}` });
    }
  }

  private _getMainHtml(useCodebaseContext: boolean) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Generator</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        textarea, select, input { width: 100%; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; margin-bottom: 10px; box-sizing: border-box; }
        textarea { height: 80px; resize: vertical; }
        .btn { width: 100%; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; margin-bottom: 8px; cursor: pointer; font-size: 14px; }
        .btn:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary { background-color: transparent; border: 1px solid var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); font-size: 12px; padding: 4px 8px; margin-top: 6px; }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-secondary.active { border-color: var(--vscode-focusBorder); }
        #status { margin-top: 10px; font-style: italic; }
        #result { margin-top: 20px; }
        #result img { max-width: 100%; border-radius: 4px; margin-top: 10px; }
        .prompt-box { background-color: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); padding: 10px; margin-top: 10px; font-size: 0.9em; word-wrap: break-word; }
        .links-row { display: flex; gap: 8px; margin-bottom: 10px; }
    </style>
</head>
<body>
    <h3>Generate Images</h3>
    <p style="font-size: 0.9em;">Uses workspace context & Pollinations AI.</p>
    
    <textarea id="promptInput" placeholder="E.g., Generate a hero illustration for this project..."></textarea>
    
    <div style="display: flex; gap: 8px; margin-bottom: 10px;">
        <div style="flex: 1;">
            <label for="sizePreset" style="font-size: 0.8em;">Size / Aspect Ratio</label>
            <select id="sizePreset">
                <option value="512x512">Square (512x512)</option>
                <option value="1024x576">Landscape (1024x576)</option>
                <option value="576x1024">Portrait (576x1024)</option>
                <option value="1024x1024">High Res Square (1024x1024)</option>
                <option value="custom">Custom...</option>
            </select>
        </div>
    </div>

    <div id="customSizeContainer" style="display: none; gap: 8px; margin-bottom: 10px;">
        <div style="flex: 1;">
            <label for="widthInput" style="font-size: 0.8em;">Custom Width</label>
            <input type="number" id="widthInput" value="512" />
        </div>
        <div style="flex: 1;">
            <label for="heightInput" style="font-size: 0.8em;">Custom Height</label>
            <input type="number" id="heightInput" value="512" />
        </div>
    </div>

    <div id="baseImageContainer" style="display: none; align-items: center; gap: 10px; margin-bottom: 10px; padding: 10px; background-color: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);">
        <img id="baseImagePreview" src="" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px;" />
        <span style="flex: 1; font-size: 0.8em;">Editing base image</span>
        <button class="btn-secondary" id="clearBaseImageBtn" style="margin: 0;">❌</button>
    </div>

    <button class="btn" id="generateBtn">Generate</button>

    <div class="links-row" style="align-items: center;">
        <button class="btn-secondary" id="logsBtn">📄 View Logs</button>
        <button class="btn-secondary" id="settingsBtn">⚙️ Settings</button>
        <button class="btn-secondary ${useCodebaseContext ? 'active' : ''}" id="contextToggleBtn" title="Toggle Codebase Context">🌐 Context</button>
    </div>

    <div id="status"></div>
    <div id="result"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const sizePreset = document.getElementById('sizePreset');
        const customSizeContainer = document.getElementById('customSizeContainer');
        const widthInput = document.getElementById('widthInput');
        const heightInput = document.getElementById('heightInput');

        sizePreset.addEventListener('change', () => {
            if (sizePreset.value === 'custom') {
                customSizeContainer.style.display = 'flex';
            } else {
                customSizeContainer.style.display = 'none';
            }
        });

        let currentBaseImageUrl = '';
        let lastSourceUrl = '';
        let lastBase64Url = '';

        document.getElementById('generateBtn').addEventListener('click', () => {
            let finalWidth, finalHeight;
            if (sizePreset.value === 'custom') {
                finalWidth = widthInput.value;
                finalHeight = heightInput.value;
            } else {
                const [w, h] = sizePreset.value.split('x');
                finalWidth = w;
                finalHeight = h;
            }

            vscode.postMessage({ 
                command: 'generate', 
                text: document.getElementById('promptInput').value,
                width: finalWidth,
                height: finalHeight,
                baseImageUrl: currentBaseImageUrl
            });
        });

        document.getElementById('clearBaseImageBtn').addEventListener('click', () => {
            currentBaseImageUrl = '';
            document.getElementById('baseImageContainer').style.display = 'none';
        });

        document.getElementById('logsBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'showOutput' });
        });

        document.getElementById('settingsBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'openSettings' });
        });

        let contextEnabled = ${useCodebaseContext};
        const contextBtn = document.getElementById('contextToggleBtn');
        contextBtn.addEventListener('click', () => {
            contextEnabled = !contextEnabled;
            contextBtn.classList.toggle('active', contextEnabled);
            vscode.postMessage({ command: 'toggleContext', value: contextEnabled });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'status') {
                document.getElementById('status').innerText = message.text;
            } else if (message.command === 'result') {
                document.getElementById('status').innerText = 'Done!';
                document.getElementById('result').innerHTML = \`
                    <strong>Prompt Used:</strong>
                    <div class="prompt-box">\${message.enhancedPrompt}</div>
                    <img src="\${message.imageUrl}" alt="Generated Image" onerror="this.alt='Failed to load image. Check logs for details.'; this.style.border='1px dashed red';" />
                    <button class="btn" id="editImageBtn" style="margin-top: 10px;">Edit This Image</button>
                \`;
                lastSourceUrl = message.sourceUrl;
                lastBase64Url = message.imageUrl;
                document.getElementById('editImageBtn').addEventListener('click', () => {
                    currentBaseImageUrl = lastBase64Url;
                    document.getElementById('baseImagePreview').src = lastBase64Url;
                    document.getElementById('baseImageContainer').style.display = 'flex';
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });
            } else if (message.command === 'updateContextToggle') {
                contextEnabled = message.value;
                document.getElementById('contextToggleBtn').classList.toggle('active', contextEnabled);
            }
        });
    </script>
</body>
</html>`;
  }
}

export function deactivate() {}
