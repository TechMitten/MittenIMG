import * as vscode from 'vscode';
import axios from 'axios';

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
          await this.handleGenerate(message.text);
          break;
        case 'showOutput':
          outputChannel.show();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'image-generator.pollinationsApiKey');
          break;
      }
    });
  }

  private _updateHtml() {
    if (!this._view) return;
    this._view.webview.html = this._getMainHtml();
  }

  private async handleGenerate(userPrompt: string) {
    if (!this._view) return;

    outputChannel.appendLine('========================================');
    outputChannel.appendLine(`[Generation Started] Prompt: "${userPrompt}"`);

    let configVars: Record<string, string> = {
      POLLINATIONS_TEXT_MODEL: 'openai',
      POLLINATIONS_TEXT_ENDPOINT: 'https://gen.pollinations.ai/v1/chat/completions',
      POLLINATIONS_IMAGE_ENDPOINT: 'https://gen.pollinations.ai/image/',
      POLLINATIONS_IMAGE_MODEL: 'flux',
      POLLINATIONS_IMAGE_WIDTH: '512',
      POLLINATIONS_IMAGE_HEIGHT: '512',
      POLLINATIONS_IMAGE_NOLOGO: 'true'
    };

    const config = vscode.workspace.getConfiguration('image-generator');
    const apiKey = config.get<string>('pollinationsApiKey');

    try {
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

      let enhancedPrompt = userPrompt;
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
      
      this._view.webview.postMessage({ command: 'status', text: 'Generating Image...' });

      const encodedPrompt = encodeURIComponent(enhancedPrompt);
      const imgModel = encodeURIComponent(configVars['POLLINATIONS_IMAGE_MODEL']);
      const imgWidth = encodeURIComponent(configVars['POLLINATIONS_IMAGE_WIDTH']);
      const imgHeight = encodeURIComponent(configVars['POLLINATIONS_IMAGE_HEIGHT']);
      const imgNologo = encodeURIComponent(configVars['POLLINATIONS_IMAGE_NOLOGO']);
      
      const imgEndpoint = configVars['POLLINATIONS_IMAGE_ENDPOINT'].replace(/\/$/, '') + '/';
      const imageUrl = `${imgEndpoint}${encodedPrompt}?model=${imgModel}&width=${imgWidth}&height=${imgHeight}&nologo=${imgNologo}`;

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

      this._view.webview.postMessage({ command: 'result', imageUrl: base64Image, enhancedPrompt });
      outputChannel.appendLine(`[Generation Completed] Successfully sent image to webview${savedPath ? ' and saved to workspace' : ''}.`);

    } catch (error: any) {
      outputChannel.appendLine(`[Fatal Error] ${error.message}`);
      vscode.window.showErrorMessage(`Failed to generate: ${error.message}`);
      this._view.webview.postMessage({ command: 'status', text: `Failed to generate: ${error.message}` });
    }
  }

  private _getMainHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Generator</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        textarea, select { width: 100%; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; margin-bottom: 10px; box-sizing: border-box; }
        textarea { height: 80px; resize: vertical; }
        .btn { width: 100%; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; margin-bottom: 8px; cursor: pointer; font-size: 14px; }
        .btn:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary { background-color: transparent; border: 1px solid var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); font-size: 12px; padding: 4px 8px; margin-top: 6px; }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
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
    <button class="btn" id="generateBtn">Generate</button>

    <div class="links-row">
        <button class="btn-secondary" id="logsBtn">📄 View Logs</button>
        <button class="btn-secondary" id="settingsBtn">⚙️ Settings</button>
    </div>

    <div id="status"></div>
    <div id="result"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        document.getElementById('generateBtn').addEventListener('click', () => {
            vscode.postMessage({ 
                command: 'generate', 
                text: document.getElementById('promptInput').value
            });
        });

        document.getElementById('logsBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'showOutput' });
        });

        document.getElementById('settingsBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'openSettings' });
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
                \`;
            }
        });
    </script>
</body>
</html>`;
  }
}

export function deactivate() {}
