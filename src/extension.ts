import * as vscode from 'vscode';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Buffer } from 'buffer';

const outputChannel = vscode.window.createOutputChannel('MittenIMG');

// Publishable BYOP App Key (client_id) from https://enter.pollinations.ai/keys.
// This is a pk_ key, safe to ship in the extension bundle — replace with your own to enable
// "Connect Pollinations Account" and (if earningsEnabled was set on the key) developer earnings.
const POLLINATIONS_APP_CLIENT_ID: string = 'pk_FVW0aHD89fKjqZwT';
const POLLINATIONS_OAUTH_TOKEN_SECRET_KEY = 'imagemitten.pollinationsOAuthToken';
const ONBOARDING_DISMISSED_KEY = 'imagemitten.onboardingDismissed';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(outputChannel);

  const provider = new ImageMittenViewProvider(context.extensionUri, context.secrets, context.globalState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('imagemitten-sidebar.view', provider)
  );

  const disposable = vscode.commands.registerCommand('imagemitten.start', () => {
    vscode.commands.executeCommand('imagemitten-sidebar.view.focus');
  });

  context.subscriptions.push(disposable);
}

class ImageMittenViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _devicePollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secrets: vscode.SecretStorage,
    private readonly _globalState: vscode.Memento
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
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
          vscode.commands.executeCommand('workbench.action.openSettings', 'imagemitten');
          break;
        case 'toggleContext':
          vscode.workspace.getConfiguration('imagemitten').update('useCodebaseContext', message.value, vscode.ConfigurationTarget.Global);
          break;
        case 'saveConvertedImage':
          await this.handleSaveConvertedImage(message.dataUrl, message.format);
          break;
        case 'connectPollinations':
          await this.handleConnectPollinations();
          break;
        case 'disconnectPollinations':
          await this.handleDisconnectPollinations();
          break;
        case 'dismissOnboarding':
          await this._globalState.update(ONBOARDING_DISMISSED_KEY, true);
          break;
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('imagemitten.useCodebaseContext')) {
        const config = vscode.workspace.getConfiguration('imagemitten');
        const useCodebaseContext = config.get<boolean>('useCodebaseContext', true);
        this._view?.webview.postMessage({ command: 'updateContextToggle', value: useCodebaseContext });
      }
    });
    
    webviewView.onDidDispose(() => {
      configListener.dispose();
    });
  }

  private async _updateHtml() {
    if (!this._view) return;
    const config = vscode.workspace.getConfiguration('imagemitten');
    const useCodebaseContext = config.get<boolean>('useCodebaseContext', true);
    const connected = !!(await this._secrets.get(POLLINATIONS_OAUTH_TOKEN_SECRET_KEY));
    const onboardingDismissed = this._globalState.get<boolean>(ONBOARDING_DISMISSED_KEY, false);
    const showOnboarding = !connected && !onboardingDismissed;
    this._view.webview.html = this._getMainHtml(useCodebaseContext, connected, showOnboarding);
  }

  private _buildContextExcludePattern(): string {
    const defaultExcludes = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'];
    const config = vscode.workspace.getConfiguration('imagemitten');
    const userFolders = config.get<string[]>('contextIgnoreFolders', []);

    const userExcludes = userFolders
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
      .map(entry => (entry.includes('*') || entry.includes('/') ? entry : `**/${entry}/**`));

    const allExcludes = Array.from(new Set([...defaultExcludes, ...userExcludes]));
    return `{${allExcludes.join(',')}}`;
  }

  private async _postConnectionStatus() {
    const token = await this._secrets.get(POLLINATIONS_OAUTH_TOKEN_SECRET_KEY);
    this._view?.webview.postMessage({ command: 'connectionStatus', connected: !!token });
  }

  /** Prefers a BYOP OAuth token over the manually-configured settings key. */
  private async getActiveApiKey(): Promise<{ key: string | undefined; source: 'oauth' | 'manual' | 'none' }> {
    const oauthToken = await this._secrets.get(POLLINATIONS_OAUTH_TOKEN_SECRET_KEY);
    if (oauthToken) {
      return { key: oauthToken, source: 'oauth' };
    }
    const manualKey = vscode.workspace.getConfiguration('imagemitten').get<string>('pollinationsApiKey');
    return { key: manualKey || undefined, source: manualKey ? 'manual' : 'none' };
  }

  private async handleConnectPollinations() {
    if (!this._view) return;

    if (!POLLINATIONS_APP_CLIENT_ID || POLLINATIONS_APP_CLIENT_ID === 'pk_REPLACE_WITH_YOUR_APP_KEY') {
      vscode.window.showErrorMessage('MittenIMG is not configured with a Pollinations App Key. Falling back to manual API key entry in Settings.');
      return;
    }

    try {
      outputChannel.appendLine('[BYOP] Requesting device code...');
      const { data: deviceData } = await axios.post('https://enter.pollinations.ai/api/device/code', {
        client_id: POLLINATIONS_APP_CLIENT_ID
      });

      const { device_code, user_code, verification_uri } = deviceData;
      const verificationUrl = verification_uri.startsWith('http')
        ? verification_uri
        : `https://enter.pollinations.ai${verification_uri}`;

      this._view.webview.postMessage({ command: 'connectPending', userCode: user_code, verificationUrl });
      outputChannel.appendLine(`[BYOP] Opening ${verificationUrl} for user code ${user_code}`);
      await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));

      const pollIntervalMs = 5000;
      const maxAttempts = 120; // ~10 minutes
      let attempts = 0;

      await new Promise<void>((resolve) => {
        this._devicePollTimer = setInterval(async () => {
          attempts++;
          try {
            const { data: tokenData } = await axios.post('https://enter.pollinations.ai/api/device/token', {
              device_code
            });

            if (tokenData?.access_token) {
              clearInterval(this._devicePollTimer);
              this._devicePollTimer = undefined;
              await this._secrets.store(POLLINATIONS_OAUTH_TOKEN_SECRET_KEY, tokenData.access_token);
              outputChannel.appendLine('[BYOP] Connected successfully.');
              this._view?.webview.postMessage({ command: 'status', text: 'Connected to Pollinations.' });
              await this._postConnectionStatus();
              resolve();
            }
          } catch (pollError: unknown) {
            const status = axios.isAxiosError(pollError) ? pollError.response?.status : undefined;
            const errCode = axios.isAxiosError(pollError) ? pollError.response?.data?.error : undefined;

            if (errCode === 'authorization_pending') {
              return; // keep polling
            }

            clearInterval(this._devicePollTimer);
            this._devicePollTimer = undefined;
            outputChannel.appendLine(`[BYOP] Device token polling failed (status ${status}): ${errCode || pollError}`);
            this._view?.webview.postMessage({ command: 'status', text: 'Failed to connect to Pollinations. Please try again.', isError: true });
            resolve();
          }

          if (attempts >= maxAttempts && this._devicePollTimer) {
            clearInterval(this._devicePollTimer);
            this._devicePollTimer = undefined;
            outputChannel.appendLine('[BYOP] Device code expired before user approved.');
            this._view?.webview.postMessage({ command: 'status', text: 'Connection request timed out. Please try again.', isError: true });
            resolve();
          }
        }, pollIntervalMs);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[BYOP Error] ${message}`);
      vscode.window.showErrorMessage(`Failed to start Pollinations connection: ${message}`);
      this._view.webview.postMessage({ command: 'status', text: `Failed to start Pollinations connection: ${message}`, isError: true });
    }
  }

  private async handleDisconnectPollinations() {
    if (this._devicePollTimer) {
      clearInterval(this._devicePollTimer);
      this._devicePollTimer = undefined;
    }
    await this._secrets.delete(POLLINATIONS_OAUTH_TOKEN_SECRET_KEY);
    outputChannel.appendLine('[BYOP] Disconnected.');
    await this._postConnectionStatus();
    this._view?.webview.postMessage({ command: 'status', text: 'Disconnected from Pollinations.' });
  }

  private async handleGenerate(userPrompt: string, width?: string, height?: string, baseImageUrl?: string) {
    if (!this._view) return;

    outputChannel.appendLine('========================================');
    outputChannel.appendLine(`[Generation Started] Prompt: "${userPrompt}"`);

    const configVars: Record<string, string> = {
      POLLINATIONS_TEXT_MODEL: 'openai',
      POLLINATIONS_TEXT_ENDPOINT: 'https://gen.pollinations.ai/v1/chat/completions',
      POLLINATIONS_IMAGE_ENDPOINT: 'https://gen.pollinations.ai/image/',
      POLLINATIONS_IMAGE_MODEL: 'zimage',
      POLLINATIONS_IMAGE_WIDTH: width || '512',
      POLLINATIONS_IMAGE_HEIGHT: height || '512',
      POLLINATIONS_IMAGE_NOLOGO: 'true'
    };

    const config = vscode.workspace.getConfiguration('imagemitten');
    const { key: apiKey, source: apiKeySource } = await this.getActiveApiKey();
    const useCodebaseContext = config.get<boolean>('useCodebaseContext', true);

    const handleAuthFailure = async (status: number | undefined) => {
      if (status === 401 && apiKeySource === 'oauth') {
        await this._secrets.delete(POLLINATIONS_OAUTH_TOKEN_SECRET_KEY);
        await this._postConnectionStatus();
        outputChannel.appendLine('[BYOP] Stored token was rejected (401). Cleared connection; please reconnect.');
      }
    };

    try {
      let enhancedPrompt = userPrompt;

      this._view.webview.postMessage({ command: 'status', text: 'Starting generation...' });

      if (useCodebaseContext && !baseImageUrl) {
        let codebaseContext = "No workspace found.";
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        this._view.webview.postMessage({ command: 'status', text: 'Reading workspace files...' });
        outputChannel.appendLine('[Context] Reading workspace files...');
        
        const excludePattern = this._buildContextExcludePattern();
        const uris = await vscode.workspace.findFiles('**/*.*', excludePattern);
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
          } catch {
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
        } catch (llmError: unknown) {
          const status = axios.isAxiosError(llmError) ? llmError.response?.status : undefined;
          const message = llmError instanceof Error ? llmError.message : String(llmError);
          const errDetails = axios.isAxiosError(llmError)
            ? JSON.stringify(llmError.response?.data || message)
            : message;
          outputChannel.appendLine(`[Text LLM Warning] Status ${status}: ${errDetails}`);

          if (status === 401 && apiKeySource === 'oauth') {
            await handleAuthFailure(status);
            vscode.window.showWarningMessage('Your Pollinations connection expired or was revoked. Please reconnect from the sidebar. Using original prompt directly for image generation.');
          } else if (status === 401) {
            vscode.window.showWarningMessage('Text model returned 401 Unauthorized (Pollinations API key required for LLM prompt analysis). Using original prompt directly for image generation.');
          } else {
            vscode.window.showWarningMessage(`Prompt enhancement failed (${message}). Using original prompt directly.`);
          }
          enhancedPrompt = userPrompt;
        }
      } else {
        outputChannel.appendLine('[Auth] No API key configured. Skipping prompt enhancement step.');
      }
      } else {
        if (baseImageUrl) {
          outputChannel.appendLine('[Context] Image edit mode. Skipping codebase context and using exact prompt.');
          this._view.webview.postMessage({ command: 'status', text: 'Preparing image edit...' });
        } else {
          outputChannel.appendLine('[Context] Codebase context is disabled. Using original prompt directly.');
          this._view.webview.postMessage({ command: 'status', text: 'Preparing image prompt...' });
        }
      }

      let uploadedImageUrl = baseImageUrl;

      if (baseImageUrl && baseImageUrl.startsWith('data:')) {
        outputChannel.appendLine('[Image Edit] Base image is base64. Uploading to media.pollinations.ai...');
        this._view.webview.postMessage({ command: 'status', text: 'Uploading base image...' });
        if (!apiKey) {
           throw new Error("Connect your Pollinations account (or set a manual API key) to edit images.");
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
        } catch (uploadErr: unknown) {
          const status = axios.isAxiosError(uploadErr) ? uploadErr.response?.status : undefined;
          await handleAuthFailure(status);
          const message = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          throw new Error(`Failed to upload base image: ${message}`, { cause: uploadErr });
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
      this._view.webview.postMessage({ command: 'status', text: 'Generating image...' });

      // Fetch the image
      const axiosConfig: AxiosRequestConfig = { responseType: 'arraybuffer' };
      if (apiKey) {
        axiosConfig.headers = { Authorization: `Bearer ${apiKey}` };
      }
      let response: AxiosResponse;
      try {
        response = await axios.get(imageUrl, axiosConfig);
      } catch (imageErr: unknown) {
        const status = axios.isAxiosError(imageErr) ? imageErr.response?.status : undefined;
        await handleAuthFailure(status);
        throw imageErr;
      }
      const imageBuffer = Buffer.from(response.data);
      const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;

      let savedPath = '';
      // Save image to workspace
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
        const imageGenFolderUri = vscode.Uri.joinPath(workspaceUri, 'MittenIMG');
        await vscode.workspace.fs.createDirectory(imageGenFolderUri);
        const fileName = `image_${Date.now()}.png`;
        const fileUri = vscode.Uri.joinPath(imageGenFolderUri, fileName);
        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(imageBuffer));
        savedPath = fileUri.fsPath;
        outputChannel.appendLine(`[Image Gen] Saved image to ${savedPath}`);
      }

      this._view.webview.postMessage({ command: 'result', imageUrl: base64Image, sourceUrl: imageUrl, enhancedPrompt });
      outputChannel.appendLine(`[Generation Completed] Successfully sent image to webview${savedPath ? ' and saved to workspace' : ''}.`);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Fatal Error] ${message}`);
      vscode.window.showErrorMessage(`Failed to generate: ${message}`);
      this._view.webview.postMessage({ command: 'status', text: `Failed to generate: ${message}`, isError: true });
    }
  }

  private async handleSaveConvertedImage(dataUrl: string, format: string) {
    if (!this._view) return;

    if (!dataUrl) {
      outputChannel.appendLine('[Convert] No image data received; ignoring saveConvertedImage request.');
      return;
    }

    const formatMap: Record<string, { ext: string; label: string }> = {
      png: { ext: 'png', label: 'PNG' },
      jpeg: { ext: 'jpg', label: 'JPEG' },
      webp: { ext: 'webp', label: 'WebP' }
    };
    const formatInfo = formatMap[format] || formatMap['png'];

    try {
      const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const fileName = `image_${Date.now()}.${formatInfo.ext}`;
      let defaultUri: vscode.Uri;

      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
        const imageGenFolderUri = vscode.Uri.joinPath(workspaceUri, 'MittenIMG');
        await vscode.workspace.fs.createDirectory(imageGenFolderUri);
        defaultUri = vscode.Uri.joinPath(imageGenFolderUri, fileName);
      } else {
        defaultUri = vscode.Uri.file(fileName);
      }

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { [formatInfo.label]: [formatInfo.ext] }
      });

      if (!saveUri) {
        outputChannel.appendLine('[Convert] Save dialog cancelled by user.');
        return;
      }

      await vscode.workspace.fs.writeFile(saveUri, new Uint8Array(buffer));
      outputChannel.appendLine(`[Convert] Saved converted ${formatInfo.label} image to ${saveUri.fsPath}`);

      vscode.window.showInformationMessage(`Saved ${formatInfo.label} image to ${saveUri.fsPath}`);
      this._view.webview.postMessage({ command: 'status', text: `Saved ${formatInfo.label} image to ${saveUri.fsPath}` });

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Convert Error] ${message}`);
      vscode.window.showErrorMessage(`Failed to save converted image: ${message}`);
      this._view.webview.postMessage({ command: 'status', text: `Failed to save converted image: ${message}` });
    }
  }

  private _getMainHtml(useCodebaseContext: boolean, connected: boolean, showOnboarding: boolean) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MittenIMG</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        textarea, select, input { width: 100%; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; margin-bottom: 10px; box-sizing: border-box; }
        textarea { height: 80px; resize: vertical; }
        .btn { width: 100%; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; margin-bottom: 8px; cursor: pointer; font-size: 14px; }
        .btn:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn:disabled { opacity: 0.7; cursor: default; }
        .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; margin-right: 6px; vertical-align: middle; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        #status.generating { display: flex; align-items: center; }
        .btn-secondary { background-color: transparent; border: 1px solid var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); font-size: 12px; padding: 4px 8px; margin-top: 6px; }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-secondary.active { border-color: var(--vscode-focusBorder); }
        #status { margin-top: 10px; font-style: italic; }
        #result { margin-top: 20px; }
        #result img { max-width: 100%; border-radius: 4px; margin-top: 10px; }
        .prompt-box { background-color: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); padding: 10px; margin-top: 10px; font-size: 0.9em; word-wrap: break-word; }
        .links-row { display: flex; gap: 8px; margin-bottom: 10px; }
        .convert-row { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
        .convert-row > div { flex: 1; }
        .convert-row label { display: block; font-size: 0.8em; margin-bottom: 2px; }
        #qualityContainer { display: none; }

        #onboardingScreen { display: ${showOnboarding ? 'block' : 'none'}; text-align: center; padding: 20px 4px; }
        #onboardingScreen .onboarding-icon { font-size: 40px; margin-bottom: 8px; }
        #onboardingScreen h2 { margin: 0 0 6px; }
        #onboardingScreen p.onboarding-desc { font-size: 0.9em; opacity: 0.85; margin: 0 0 18px; line-height: 1.4; }
        #onboardingStatusLine { font-size: 0.85em; margin-bottom: 12px; min-height: 1.2em; }
        #deviceCodeBox { display: none; margin: 14px 0; padding: 10px; background-color: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); font-size: 0.85em; text-align: left; }
        #deviceCodeBox code { font-size: 1.15em; font-weight: bold; letter-spacing: 0.05em; }
        .onboarding-footer { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; align-items: center; font-size: 0.8em; }
        .onboarding-footer a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
        .onboarding-footer a:hover { text-decoration: underline; }

        #mainScreen { display: ${showOnboarding ? 'none' : 'block'}; }
        #accountStatusLine { font-size: 0.75em; opacity: 0.8; margin-bottom: 10px; }
        #accountStatusLine a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
        #accountStatusLine a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div id="onboardingScreen">
        <div class="onboarding-icon">🎨</div>
        <h2>Welcome to MittenIMG</h2>
        <p class="onboarding-desc">Connect your Pollinations account to generate images right from this sidebar — no API key to copy or manage.</p>

        <div id="onboardingStatusLine">${connected ? '✅ Connected to Pollinations' : ''}</div>

        <button class="btn" id="onboardingConnectBtn" style="${connected ? 'display: none;' : ''}">🔌 Connect Pollinations Account</button>
        <button class="btn-secondary" id="onboardingDisconnectBtn" style="${connected ? '' : 'display: none;'} width: 100%;">Disconnect</button>

        <div id="deviceCodeBox">
            Go to <a href="#" id="verificationLink" target="_blank" rel="noopener">enter.pollinations.ai/device</a> and enter code: <code id="userCodeText"></code>
        </div>

        <div class="onboarding-footer">
            <a id="useManualKeyLink">Use a manual API key instead</a>
            <a id="onboardingContinueLink">${connected ? '← Back to app' : 'Skip for now'}</a>
        </div>
    </div>

    <div id="mainScreen">
    <h3>Generate Images</h3>

    <div id="accountStatusLine"><span id="accountStatusText">${connected ? '✅ Connected to Pollinations' : 'Not connected to Pollinations'}</span> · <a id="manageAccountLink">Manage</a></div>

    <p style="font-size: 0.9em;">Describe your image below:</p>

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
        <button class="btn-secondary" id="createNewBtn" title="Reset and start over">🆕 New</button>
        <button class="btn-secondary" id="logsBtn">📄 Logs</button>
        <button class="btn-secondary" id="settingsBtn">⚙️ Settings</button>
        <button class="btn-secondary ${useCodebaseContext ? 'active' : ''}" id="contextToggleBtn" title="Toggle Codebase Context">🌐 Context</button>
    </div>

    <div id="status"></div>
    <div id="result"></div>
    </div>

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

        const generateBtn = document.getElementById('generateBtn');
        const statusDiv = document.getElementById('status');
        let isGenerating = false;

        function setGenerating(generating, text) {
            isGenerating = generating;
            generateBtn.disabled = generating;
            generateBtn.textContent = generating ? 'Generating…' : 'Generate';
            statusDiv.classList.toggle('generating', generating);
            statusDiv.innerHTML = generating ? '<span class="spinner"></span><span>' + (text || 'Starting generation...') + '</span>' : (text || '');
        }

        generateBtn.addEventListener('click', () => {
            let finalWidth, finalHeight;
            if (sizePreset.value === 'custom') {
                finalWidth = widthInput.value;
                finalHeight = heightInput.value;
            } else {
                const [w, h] = sizePreset.value.split('x');
                finalWidth = w;
                finalHeight = h;
            }

            setGenerating(true);

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

        function resetUI() {
            document.getElementById('promptInput').value = '';

            sizePreset.value = '512x512';
            customSizeContainer.style.display = 'none';
            widthInput.value = '512';
            heightInput.value = '512';

            currentBaseImageUrl = '';
            document.getElementById('baseImageContainer').style.display = 'none';

            lastSourceUrl = '';
            lastBase64Url = '';

            setGenerating(false, '');
            statusDiv.classList.remove('generating');
            statusDiv.textContent = '';
            document.getElementById('result').innerHTML = '';
        }

        document.getElementById('createNewBtn').addEventListener('click', () => {
            resetUI();
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

        let pollinationsConnected = ${connected};
        let connecting = false;

        const onboardingScreen = document.getElementById('onboardingScreen');
        const mainScreen = document.getElementById('mainScreen');
        const onboardingConnectBtn = document.getElementById('onboardingConnectBtn');
        const onboardingDisconnectBtn = document.getElementById('onboardingDisconnectBtn');
        const onboardingStatusLine = document.getElementById('onboardingStatusLine');
        const onboardingContinueLink = document.getElementById('onboardingContinueLink');
        const useManualKeyLink = document.getElementById('useManualKeyLink');
        const deviceCodeBox = document.getElementById('deviceCodeBox');
        const accountStatusText = document.getElementById('accountStatusText');
        const manageAccountLink = document.getElementById('manageAccountLink');

        function showOnboardingScreen() {
            onboardingScreen.style.display = 'block';
            mainScreen.style.display = 'none';
        }

        function showMainScreen() {
            onboardingScreen.style.display = 'none';
            mainScreen.style.display = 'block';
        }

        function updateConnectionUi() {
            onboardingStatusLine.textContent = connecting
                ? 'Waiting for approval in your browser…'
                : (pollinationsConnected ? '✅ Connected to Pollinations' : '');
            onboardingConnectBtn.style.display = pollinationsConnected ? 'none' : 'block';
            onboardingConnectBtn.disabled = connecting;
            onboardingConnectBtn.textContent = connecting ? 'Waiting for approval…' : '🔌 Connect Pollinations Account';
            onboardingDisconnectBtn.style.display = pollinationsConnected ? 'block' : 'none';
            onboardingContinueLink.textContent = pollinationsConnected ? '← Back to app' : 'Skip for now';
            if (pollinationsConnected) {
                deviceCodeBox.style.display = 'none';
            }
            accountStatusText.textContent = pollinationsConnected ? '✅ Connected to Pollinations' : 'Not connected to Pollinations';
        }

        onboardingConnectBtn.addEventListener('click', () => {
            connecting = true;
            updateConnectionUi();
            vscode.postMessage({ command: 'connectPollinations' });
        });

        onboardingDisconnectBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'disconnectPollinations' });
        });

        useManualKeyLink.addEventListener('click', () => {
            vscode.postMessage({ command: 'dismissOnboarding' });
            vscode.postMessage({ command: 'openSettings' });
            showMainScreen();
        });

        onboardingContinueLink.addEventListener('click', () => {
            if (!pollinationsConnected) {
                vscode.postMessage({ command: 'dismissOnboarding' });
            }
            showMainScreen();
        });

        manageAccountLink.addEventListener('click', showOnboardingScreen);

        updateConnectionUi();

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'status') {
                if (message.isError) {
                    setGenerating(false, message.text);
                    if (connecting) {
                        connecting = false;
                        updateConnectionUi();
                        onboardingStatusLine.textContent = message.text;
                    }
                } else if (isGenerating) {
                    setGenerating(true, message.text);
                } else {
                    statusDiv.classList.remove('generating');
                    statusDiv.textContent = message.text;
                }
            } else if (message.command === 'result') {
                setGenerating(false, 'Done!');
                document.getElementById('result').innerHTML = \`
                    <details style="display: none;">
                        <summary style="cursor: pointer; font-weight: bold; margin-bottom: 5px;">Prompt Used:</summary>
                        <div class="prompt-box">\${message.enhancedPrompt}</div>
                    </details>
                    <img src="\${message.imageUrl}" alt="Generated Image" onerror="this.alt='Failed to load image. Check logs for details.'; this.style.border='1px dashed red';" style="margin-top: 10px;" />
                    <button class="btn" id="editImageBtn" style="margin-top: 10px;">Edit This Image</button>
                    <details style="margin-top: 10px;">
                        <summary style="cursor: pointer; font-weight: bold;">🔄 Convert to another format</summary>
                        <div class="convert-row">
                            <div>
                                <label for="convertFormat">Format</label>
                                <select id="convertFormat">
                                    <option value="png">PNG</option>
                                    <option value="jpeg">JPEG</option>
                                    <option value="webp">WebP</option>
                                </select>
                            </div>
                            <div id="qualityContainer">
                                <label for="convertQuality">Quality (<span id="qualityValue">92</span>%)</label>
                                <input type="range" id="convertQuality" min="1" max="100" value="92" style="margin-bottom: 0;" />
                            </div>
                        </div>
                        <button class="btn" id="convertSaveBtn" style="margin-top: 8px;">Convert &amp; Save</button>
                    </details>
                \`;
                lastSourceUrl = message.sourceUrl;
                lastBase64Url = message.imageUrl;
                document.getElementById('editImageBtn').addEventListener('click', () => {
                    currentBaseImageUrl = lastBase64Url;
                    document.getElementById('baseImagePreview').src = lastBase64Url;
                    document.getElementById('baseImageContainer').style.display = 'flex';
                    document.getElementById('promptInput').value = '';
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });

                const convertFormat = document.getElementById('convertFormat');
                const qualityContainer = document.getElementById('qualityContainer');
                const convertQuality = document.getElementById('convertQuality');
                const qualityValue = document.getElementById('qualityValue');

                convertFormat.addEventListener('change', () => {
                    qualityContainer.style.display = convertFormat.value === 'png' ? 'none' : 'block';
                });

                convertQuality.addEventListener('input', () => {
                    qualityValue.textContent = convertQuality.value;
                });

                document.getElementById('convertSaveBtn').addEventListener('click', () => {
                    if (!lastBase64Url) { return; }

                    const format = convertFormat.value;
                    const mime = 'image/' + format;
                    const quality = Number(convertQuality.value) / 100;

                    const img = new Image();
                    img.onload = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = img.naturalWidth;
                            canvas.height = img.naturalHeight;
                            const ctx = canvas.getContext('2d');

                            if (format === 'jpeg') {
                                ctx.fillStyle = '#FFFFFF';
                                ctx.fillRect(0, 0, canvas.width, canvas.height);
                            }
                            ctx.drawImage(img, 0, 0);

                            const dataUrl = canvas.toDataURL(mime, quality);
                            vscode.postMessage({ command: 'saveConvertedImage', dataUrl, format });
                        } catch (convErr) {
                            document.getElementById('status').innerText = 'Conversion failed: ' + convErr.message;
                        }
                    };
                    img.onerror = () => {
                        document.getElementById('status').innerText = 'Failed to load image for conversion.';
                    };
                    img.src = lastBase64Url;
                });
            } else if (message.command === 'updateContextToggle') {
                contextEnabled = message.value;
                document.getElementById('contextToggleBtn').classList.toggle('active', contextEnabled);
            } else if (message.command === 'connectPending') {
                document.getElementById('userCodeText').textContent = message.userCode;
                document.getElementById('verificationLink').href = message.verificationUrl;
                deviceCodeBox.style.display = 'block';
            } else if (message.command === 'connectionStatus') {
                const wasConnecting = connecting;
                connecting = false;
                pollinationsConnected = message.connected;
                updateConnectionUi();
                if (pollinationsConnected && wasConnecting) {
                    setTimeout(showMainScreen, 900);
                }
            }
        });
    </script>
</body>
</html>`;
  }
}

export function deactivate() {}
