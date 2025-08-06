import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { ToolsInput } from '@mastra/core/agent';
import { MastraVoice } from '@mastra/core/voice';
import type { VoiceEventType } from '@mastra/core/voice';
import { GoogleAuth } from 'google-auth-library';
import type { WebSocket as WSType } from 'ws';
import { WebSocket } from 'ws';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  GeminiLiveVoiceConfig,
  GeminiLiveVoiceOptions,
  GeminiLiveEventMap,
  GeminiVoiceModel,
  GeminiVoiceName,
  GeminiToolConfig,
  GeminiSessionConfig,
  AudioConfig,
} from './types';

// export type {
//   GeminiLiveVoiceConfig,
//   GeminiLiveVoiceOptions,
//   GeminiLiveEventMap,
//   GeminiVoiceModel,
//   GeminiVoiceName,
//   GeminiToolConfig,
//   GeminiSessionConfig,
//   AudioConfig,
// } from './types';

/**
 * Default configuration values
 */
const DEFAULT_MODEL: GeminiVoiceModel = 'gemini-2.0-flash-live-001';
const DEFAULT_VOICE: GeminiVoiceName = 'Puck';
const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  encoding: 'pcm16',
  channels: 1,
};

/**
 * GeminiLiveVoice provides real-time multimodal voice interactions using Google's Gemini Live API.
 *
 * Features:
 * - Bidirectional audio streaming
 * - Video input support
 * - Built-in VAD and interrupt handling
 * - Tool calling capabilities
 * - Session management and resumption
 * - Live transcription
 *
 * @example
 * ```typescript
 * const voice = new GeminiLiveVoice({
 *   apiKey: 'your-api-key',
 *   model: 'gemini-2.0-flash-live-001',
 *   speaker: 'Puck',
 * });
 *
 * await voice.connect();
 *
 * voice.on('speaking', ({ audio }) => {
 *   playAudio(audio);
 * });
 *
 * await voice.speak('Hello!');
 * ```
 */
export class GeminiLiveVoice extends MastraVoice<
  GeminiLiveVoiceConfig,
  GeminiLiveVoiceOptions,
  GeminiLiveVoiceOptions,
  any,
  GeminiLiveEventMap
> {
  private ws?: WSType;
  private eventEmitter: EventEmitter;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private sessionHandle?: string;
  private currentAudioStream?: NodeJS.ReadableStream;
  private activeStreams = new Set<NodeJS.ReadableStream>();
  private lastSendTime = 0;
  private readonly minSendInterval = 0; // No throttling - let the stream control the pace
  private readonly maxChunkSize = 32768; // 32KB max chunk size per Gemini limits

  // Session management properties
  private sessionId?: string;
  private sessionStartTime?: number;
  private sessionConfig?: GeminiSessionConfig;
  private isResuming = false;
  private contextHistory: Array<{ role: string; content: string; timestamp: number }> = [];
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private reconnectTimeout?: NodeJS.Timeout;

  private readonly apiKey: string;
  private readonly model: GeminiVoiceModel;
  private readonly vertexAI: boolean;
  private readonly project?: string;
  private readonly location: string;
  private readonly instructions?: string;
  private tools?: ToolsInput;
  private readonly debug: boolean;
  private readonly audioConfig: AudioConfig;
  private transformedTools?: Array<{ geminiTool: GeminiToolConfig; execute: (args: any) => Promise<any> }>;
  private readonly responseModality: 'TEXT' | 'AUDIO';

  // Authentication properties
  private authClient?: GoogleAuth;
  private accessToken?: string;
  private tokenExpiryTime?: number;
  private readonly serviceAccountKeyFile?: string;
  private readonly serviceAccountEmail?: string;
  private readonly authScopes: string[];

  /**
   * Creates a new GeminiLiveVoice instance
   *
   * @param config Configuration options
   */
  constructor(config: GeminiLiveVoiceConfig = {}) {
    super({
      speechModel: {
        name: config.model || DEFAULT_MODEL,
        apiKey: config.apiKey || process.env.GOOGLE_API_KEY,
      },
      speaker: config.speaker || DEFAULT_VOICE,
      realtimeConfig: {
        model: config.model || DEFAULT_MODEL,
        apiKey: config.apiKey || process.env.GOOGLE_API_KEY,
        options: config,
      },
    });

    // Validate API key
    const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey && !config.vertexAI) {
      throw new Error(
        'Google API key is required. Set GOOGLE_API_KEY environment variable or pass apiKey to constructor',
      );
    }

    this.apiKey = apiKey || '';
    this.model = config.model || DEFAULT_MODEL;
    this.vertexAI = config.vertexAI || false;
    this.project = config.project || process.env.GOOGLE_CLOUD_PROJECT;
    this.location = config.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    this.instructions = config.instructions;
    this.debug = config.debug || false;
    this.audioConfig = DEFAULT_AUDIO_CONFIG;
    this.sessionConfig = config.sessionConfig;
    this.responseModality = config.responseModality || 'TEXT'; // Default to TEXT for transcription

    // Initialize authentication properties
    this.serviceAccountKeyFile = config.serviceAccountKeyFile;
    this.serviceAccountEmail = config.serviceAccountEmail;
    this.authScopes = config.authScopes || ['https://www.googleapis.com/auth/cloud-platform'];
    this.accessToken = config.accessToken;

    this.eventEmitter = new EventEmitter();

    // Initialize Google Auth client for Vertex AI
    if (this.vertexAI) {
      this.validateAuthConfig();
      this.initializeVertexAIAuth();
    }

    if (this.vertexAI && !this.project) {
      throw new Error(
        'Google Cloud project ID is required when using Vertex AI. Set GOOGLE_CLOUD_PROJECT environment variable or pass project to constructor',
      );
    }
  }

  /**
   * Register an event listener
   * @param event Event name
   * @param callback Callback function that receives event data
   */
  on<E extends VoiceEventType>(
    event: E,
    callback: (data: E extends keyof GeminiLiveEventMap ? GeminiLiveEventMap[E] : unknown) => void,
  ): void {
    this.eventEmitter.on(event as string, callback);
  }

  /**
   * Remove an event listener
   * @param event Event name
   * @param callback Callback function to remove
   */
  off<E extends VoiceEventType>(
    event: E,
    callback: (data: E extends keyof GeminiLiveEventMap ? GeminiLiveEventMap[E] : unknown) => void,
  ): void {
    this.eventEmitter.off(event as string, callback);
  }

  /**
   * Emit an event to listeners
   * @private
   */
  private emit<K extends keyof GeminiLiveEventMap>(event: K, data: GeminiLiveEventMap[K]): boolean {
    return this.eventEmitter.emit(event as string, data);
  }

  /**
   * Establish connection to the Gemini Live API
   */
  async connect(): Promise<void> {
    return this.traced(async () => {
      if (this.connectionState === 'connected') {
        this.log('Already connected to Gemini Live API');
        return;
      }

      // Check if we're attempting to reconnect after a failure
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        throw new Error(`Failed to connect after ${this.maxReconnectAttempts} attempts`);
      }

      this.connectionState = 'connecting';
      this.emit('session', { state: 'connecting' });

      const wsUrl: string = this.vertexAI
        ? `wss://${this.location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.PredictionService.ServerStreamingPredict`
        : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;

      let headers: WebSocket.ClientOptions;

      if (this.vertexAI) {
        // Refresh token if needed before connecting
        await this.refreshTokenIfNeeded();
        const accessToken = await this.getAccessToken();
        headers = { headers: { Authorization: `Bearer ${accessToken}` } };
        this.log('Using Vertex AI authentication with OAuth token');
      } else {
        headers = { headers: { 'x-goog-api-key': this.apiKey } };
        this.log('Using Gemini API authentication with API key');
      }

      try {
        this.ws = new WebSocket(wsUrl, undefined, headers);
        this.setupEventListeners();

        await Promise.all([this.waitForOpen(), this.waitForSessionCreated()]);

        // Send initial configuration or resume session
        if (this.isResuming && this.sessionHandle) {
          await this.sendSessionResumption();
        } else {
          this.sendInitialConfig();
          this.sessionStartTime = Date.now();
          this.sessionId = randomUUID();
        }

        this.connectionState = 'connected';
        this.reconnectAttempts = 0; // Reset on successful connection

        this.log('Successfully connected to Gemini Live API', {
          sessionId: this.sessionId,
          isResuming: this.isResuming,
        });

        // Start session duration monitoring if configured
        if (this.sessionConfig?.maxDuration) {
          this.startSessionDurationMonitor();
        }
      } catch (error) {
        this.connectionState = 'disconnected';
        this.reconnectAttempts++;

        this.log('Connection failed', {
          error,
          attempt: this.reconnectAttempts,
          maxAttempts: this.maxReconnectAttempts,
        });

        // Attempt automatic reconnection if enabled
        if (this.sessionConfig?.enableResumption && this.reconnectAttempts < this.maxReconnectAttempts) {
          await this.scheduleReconnect();
        } else {
          throw error;
        }
      }
    }, 'gemini-live.connect')();
  }

  /**
   * Disconnect from the Gemini Live API
   */
  async disconnect(): Promise<void> {
    // Clean up any active audio streams
    await this.stopCurrentAudioStream();

    // Clean up any remaining active streams
    for (const stream of this.activeStreams) {
      try {
        stream.removeAllListeners();
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      } catch (error) {
        this.log('Error cleaning up stream during disconnect', error);
      }
    }
    this.activeStreams.clear();

    // Clear reconnection timeout if any
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    // Save session handle before disconnecting if resumption is enabled
    if (this.sessionConfig?.enableResumption && this.sessionId) {
      // In a real implementation, the session handle would come from the server
      // For now, we'll use the session ID as a placeholder
      this.sessionHandle = this.sessionId;
      this.log('Session handle saved for resumption', { handle: this.sessionHandle });
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this.connectionState = 'disconnected';
    this.isResuming = false;
    this.emit('session', { state: 'disconnected' });

    this.log('Disconnected from Gemini Live API', {
      sessionId: this.sessionId,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : undefined,
    });
  }

  /**
   * Send text to be converted to speech
   */
  async speak(
    input: string | NodeJS.ReadableStream,
    _options?: GeminiLiveVoiceOptions,
  ): Promise<NodeJS.ReadableStream | void> {
    return this.traced(async () => {
      if (this.connectionState !== 'connected') {
        throw new Error('Not connected to Gemini Live API. Call connect() first.');
      }

      if (typeof input !== 'string') {
        const chunks: Buffer[] = [];
        for await (const chunk of input) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        input = Buffer.concat(chunks).toString('utf-8');
      }

      if (input.trim().length === 0) {
        throw new Error('Input text is empty');
      }

      // Send text message to Gemini Live API
      const textMessage = {
        client_content: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: input,
                },
              ],
            },
          ],
          turn_complete: true,
        },
      };

      try {
        this.ws!.send(JSON.stringify(textMessage));
        this.log('Text message sent', { text: input });

        // The response will come via the event system (handleServerContent)
        // Audio will be emitted through 'speaking' events
        // Text responses will be emitted through 'writing' events
      } catch (error) {
        this.log('Failed to send text message', error);
        throw new Error(`Failed to send text message: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }, 'gemini-live.speak')();
  }

  /**
   * Send audio stream for processing
   */
  async send(audioData: NodeJS.ReadableStream | Int16Array): Promise<void> {
    return this.traced(async () => {
      if (this.connectionState !== 'connected') {
        throw new Error('Not connected to Gemini Live API. Call connect() first.');
      }

      // Stop any existing stream
      await this.stopCurrentAudioStream();

      if ('readable' in audioData && typeof audioData.on === 'function') {
        await this.handleAudioStream(audioData as NodeJS.ReadableStream);
      } else {
        await this.handleAudioBuffer(audioData as Int16Array);
      }
    }, 'gemini-live.send')();
  }

  /**
   * Process speech from audio stream (traditional STT interface)
   */
  async listen(audioStream: NodeJS.ReadableStream, options?: GeminiLiveVoiceOptions): Promise<string> {
    return this.traced(async () => {
      if (this.connectionState !== 'connected') {
        throw new Error('Not connected to Gemini Live API. Call connect() first.');
      }

      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let transcriptionText = '';
        let hasReceivedResponse = false;
        let turnComplete = false;
        const transcriptionId = randomUUID();

        // Set up timeout
        const timeoutMs = options?.timeout || 30000;
        const timeout = setTimeout(() => {
          if (!hasReceivedResponse) {
            cleanup();
            reject(new Error(`Transcription timeout - no response received within ${timeoutMs / 1000} seconds`));
          }
        }, timeoutMs);

        // Listen for transcription responses
        const onWriting = (data: { text: string; role: 'assistant' | 'user' }) => {
          // Accept transcriptions from either role
          transcriptionText += data.text;
          hasReceivedResponse = true;
          this.log('Received transcription text:', {
            transcriptionId,
            role: data.role,
            text: data.text,
            total: transcriptionText.length,
          });
        };

        // Listen for turn completion
        const onTurnComplete = () => {
          turnComplete = true;
          if (hasReceivedResponse) {
            cleanup();
            resolve(transcriptionText.trim() || '');
          }
        };

        // Listen for errors
        const onError = (error: { message: string; code?: string; details?: unknown }) => {
          cleanup();
          reject(new Error(`Transcription failed: ${error.message}`));
        };

        // Listen for session events
        const onSession = (data: { state: string }) => {
          if (data.state === 'disconnected') {
            cleanup();
            reject(new Error('Session disconnected during transcription'));
          }
        };

        // Set up event listeners with unique handlers to avoid conflicts
        const eventHandlers = {
          writing: onWriting,
          turnComplete: onTurnComplete,
          error: onError,
          session: onSession,
        };

        this.on('writing', eventHandlers.writing);
        this.on('turnComplete', eventHandlers.turnComplete);
        this.on('error', eventHandlers.error);
        this.on('session', eventHandlers.session);

        // Cleanup function
        const cleanup = () => {
          clearTimeout(timeout);
          this.off('writing', eventHandlers.writing);
          this.off('turnComplete', eventHandlers.turnComplete);
          this.off('error', eventHandlers.error);
          this.off('session', eventHandlers.session);
        };

        // Process audio stream
        audioStream.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        audioStream.on('error', (error: Error) => {
          cleanup();
          reject(new Error(`Audio stream error: ${error.message}`));
        });

        audioStream.on('end', async () => {
          try {
            // Combine all chunks
            const audioBuffer = Buffer.concat(chunks);
            this.log('Processing audio for transcription:', {
              transcriptionId,
              chunks: chunks.length,
              totalSize: audioBuffer.length,
              estimatedDuration: (audioBuffer.length / (this.audioConfig.inputSampleRate * 2)).toFixed(2) + 's',
            });

            // Validate minimum audio length
            if (audioBuffer.length < 1000) {
              // ~31ms at 16kHz
              cleanup();
              resolve(''); // Return empty string for very short audio
              return;
            }

            // Validate and convert audio using existing methods
            const int16Array = this.validateAndConvertAudioInput(audioBuffer);
            const base64Audio = this.int16ArrayToBase64(int16Array);

            // Create audio message for transcription
            // Use realtime format for better streaming support
            const message = this.createAudioMessage(base64Audio, 'realtime');

            // Send to Gemini Live API
            if (this.ws?.readyState !== WebSocket.OPEN) {
              throw new Error('WebSocket not ready for transcription request');
            }

            this.ws.send(JSON.stringify(message));
            this.log('Sent audio for transcription', { transcriptionId, messageType: 'realtime' });

            // Set up a fallback resolution in case turn complete event is missed
            setTimeout(() => {
              if (hasReceivedResponse && !turnComplete) {
                this.log('Fallback resolution - turn complete not received', { transcriptionId });
                cleanup();
                resolve(transcriptionText.trim() || '');
              }
            }, 5000); // 5 second fallback
          } catch (error) {
            cleanup();
            reject(
              new Error(`Failed to process audio stream: ${error instanceof Error ? error.message : 'Unknown error'}`),
            );
          }
        });
      });
    }, 'gemini-live.listen')();
  }

  /**
   * Get available speakers/voices
   */
  async getSpeakers(): Promise<Array<{ voiceId: string; [key: string]: any }>> {
    return this.traced(async () => {
      // Return available Gemini Live voices
      return [
        { voiceId: 'Puck', description: 'Conversational, friendly' },
        { voiceId: 'Charon', description: 'Deep, authoritative' },
        { voiceId: 'Kore', description: 'Neutral, professional' },
        { voiceId: 'Fenrir', description: 'Warm, approachable' },
      ];
    }, 'gemini-live.getSpeakers')();
  }

  /**
   * Resume a previous session using a session handle
   */
  async resumeSession(handle: string, context?: Array<{ role: string; content: string }>): Promise<void> {
    if (this.connectionState === 'connected') {
      throw new Error('Cannot resume session while already connected. Disconnect first.');
    }

    this.log('Attempting to resume session', { handle });

    this.sessionHandle = handle;
    this.isResuming = true;

    // Restore context history if provided
    if (context) {
      this.contextHistory = context.map(item => ({
        ...item,
        timestamp: Date.now(),
      }));
    }

    try {
      await this.connect();
      this.log('Session resumed successfully', { handle, contextItems: context?.length || 0 });
    } catch (error) {
      this.isResuming = false;
      this.sessionHandle = undefined;
      throw new Error(`Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Send video frame for multimodal processing
   */
  // async sendVideo(_videoData: Buffer | Uint8Array): Promise<void> {
  //   if (this.connectionState !== 'connected') {
  //     throw new Error('Not connected to Gemini Live API. Call connect() first.');
  //   }

  // TODO: Implement video streaming
  // - Convert video frame to JPEG format
  // - Send via WebSocket with appropriate metadata

  // throw new Error('Video streaming not yet implemented');
  // }

  /**
   * Update session configuration during an active session
   */
  async updateSessionConfig(config: Partial<GeminiSessionConfig>): Promise<void> {
    if (this.connectionState !== 'connected') {
      throw new Error('Not connected to Gemini Live API. Call connect() first.');
    }

    this.log('Updating session configuration', config);

    // Merge with existing config
    this.sessionConfig = {
      ...this.sessionConfig,
      ...config,
    };

    // Send configuration update to Gemini Live API
    const updateMessage = {
      session_config_update: {
        ...(config.vad && {
          vad_config: {
            enabled: config.vad.enabled,
            sensitivity: config.vad.sensitivity,
            silence_duration_ms: config.vad.silenceDurationMs,
          },
        }),
        ...(config.interrupts && {
          interrupt_config: {
            enabled: config.interrupts.enabled,
            allow_user_interruption: config.interrupts.allowUserInterruption,
          },
        }),
        ...(config.contextCompression !== undefined && {
          context_compression: config.contextCompression,
        }),
      },
    };

    try {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not ready for configuration update');
      }

      this.ws.send(JSON.stringify(updateMessage));
      this.log('Session configuration updated successfully');

      // Restart session duration monitor if maxDuration changed
      if (config.maxDuration) {
        this.startSessionDurationMonitor();
      }
    } catch (error) {
      this.log('Failed to update session configuration', error);
      throw new Error(
        `Failed to update session configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get current connection state
   */
  getConnectionState(): string {
    return this.connectionState;
  }

  /**
   * Get session handle for resumption
   */
  getSessionHandle(): string | undefined {
    return this.sessionHandle;
  }

  /**
   * Add tools to the voice instance
   * Tools allow the model to perform additional actions during conversations
   */
  addTools(tools?: ToolsInput): void {
    if (!tools) {
      this.tools = undefined;
      this.transformedTools = undefined;
      return;
    }

    this.tools = tools;
    this.transformedTools = this.transformTools(tools);

    this.log('Tools configured', {
      count: this.transformedTools.length,
      names: this.transformedTools.map(t => t.geminiTool.name),
    });

    // If connected, warn that tools can't be updated dynamically
    if (this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.log('Warning: Tools cannot be updated after connection with Gemini Live API.');
      this.log('To use these tools, please disconnect and reconnect.');
      // Still call sendToolsUpdate which will emit an error event
      this.sendToolsUpdate();
    }
  }

  /**
   * Add instructions to guide the model's behavior
   */
  addInstructions(instructions?: string): void {
    // This method is already defined in MastraVoice base class
    // We'll override it to support dynamic updates
    if (this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      // Send instruction update to Gemini
      const message = {
        instruction_update: {
          instructions,
        },
      };
      this.ws.send(JSON.stringify(message));
      this.log('Instructions updated', { instructions });
    }
  }

  /**
   * Get comprehensive session information
   */
  getSessionInfo(): {
    id?: string;
    handle?: string;
    startTime?: Date;
    duration?: number;
    state: string;
    config?: GeminiSessionConfig;
    contextSize: number;
    reconnectAttempts: number;
  } {
    const now = Date.now();
    return {
      id: this.sessionId,
      handle: this.sessionHandle,
      startTime: this.sessionStartTime ? new Date(this.sessionStartTime) : undefined,
      duration: this.sessionStartTime ? now - this.sessionStartTime : undefined,
      state: this.connectionState,
      config: this.sessionConfig,
      contextSize: this.contextHistory.length,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Get session context history
   */
  getContextHistory(): Array<{ role: string; content: string; timestamp: number }> {
    return [...this.contextHistory]; // Return a copy
  }

  /**
   * Add to context history for session continuity
   */
  addToContext(role: 'user' | 'assistant', content: string): void {
    this.contextHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Apply context compression if configured
    if (this.sessionConfig?.contextCompression && this.contextHistory.length > 100) {
      this.compressContext();
    }
  }

  /**
   * Clear session context
   */
  clearContext(): void {
    this.contextHistory = [];
    this.log('Session context cleared');
  }

  /**
   * Enable or disable automatic reconnection
   */
  setAutoReconnect(enabled: boolean): void {
    if (!this.sessionConfig) {
      this.sessionConfig = {};
    }
    this.sessionConfig.enableResumption = enabled;
    this.log(`Auto-reconnect ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get current authentication status
   */
  getAuthStatus(): {
    isAuthenticated: boolean;
    authMethod: 'gemini-api' | 'vertex-ai' | 'none';
    tokenExpiry?: Date;
    project?: string;
  } {
    if (!this.vertexAI) {
      return {
        isAuthenticated: !!this.apiKey,
        authMethod: 'gemini-api',
        project: undefined,
      };
    }

    return {
      isAuthenticated: !!(this.authClient || this.accessToken),
      authMethod: 'vertex-ai',
      tokenExpiry: this.tokenExpiryTime ? new Date(this.tokenExpiryTime) : undefined,
      project: this.project,
    };
  }

  /**
   * Manually refresh the authentication token (for Vertex AI)
   */
  async refreshAuth(): Promise<void> {
    if (!this.vertexAI) {
      throw new Error('Auth refresh is only available for Vertex AI authentication');
    }

    this.log('Manually refreshing authentication token...');
    try {
      // Force token refresh by clearing current token
      this.accessToken = undefined;
      this.tokenExpiryTime = undefined;

      await this.getAccessToken();
      this.log('Authentication token refreshed successfully');
    } catch (error) {
      this.log('Failed to refresh authentication token:', error);
      throw new Error(`Failed to refresh authentication: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Setup WebSocket event listeners for Gemini Live API messages
   * @private
   */
  private setupEventListeners(): void {
    if (!this.ws) {
      throw new Error('WebSocket not initialized');
    }

    // Handle WebSocket connection events
    this.ws.on('open', () => {
      this.log('WebSocket connection opened');
      this.connectionState = 'connected';
      this.emit('session', { state: 'connected' });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.log('WebSocket connection closed', { code, reason: reason.toString() });
      this.connectionState = 'disconnected';
      this.emit('session', { state: 'disconnected' });
    });

    this.ws.on('error', (error: Error) => {
      this.log('WebSocket error', error);
      this.connectionState = 'disconnected';
      this.emit('error', {
        message: error.message,
        code: 'websocket_error',
        details: error,
      });
    });

    // Handle incoming messages from Gemini Live API
    this.ws.on('message', (message: Buffer | string) => {
      try {
        const data = JSON.parse(message.toString());
        this.handleGeminiMessage(data);
      } catch (error) {
        this.log('Failed to parse WebSocket message', error);
        this.emit('error', {
          message: 'Failed to parse WebSocket message',
          code: 'parse_error',
          details: error,
        });
      }
    });
  }

  /**
   * Handle different types of messages from Gemini Live API
   * @private
   */
  private handleGeminiMessage(data: any): void {
    if (this.debug) {
      this.log('Received message', data);
    }

    // Handle different Gemini Live API message structures
    // Note: Gemini uses camelCase for some fields and snake_case for others
    if (data.setupComplete) {
      this.handleSetupComplete(data);
    } else if (data.server_content || data.serverContent) {
      // Handle both snake_case and camelCase versions
      this.handleServerContent(data.server_content || data.serverContent);
    } else if (data.toolCall) {
      void this.handleToolCall(data);
    } else if (data.usage_metadata || data.usageMetadata) {
      // Handle both versions
      this.handleUsageUpdate(data.usage_metadata || data.usageMetadata);
    } else if (data.sessionEnd) {
      this.handleSessionEnd(data);
    } else {
      this.log('Unknown message format', data);
    }
  }

  /**
   * Handle setup completion message
   * @private
   */
  private handleSetupComplete(data: any): void {
    this.log('Setup completed');
    // Emit event for waitForSessionCreated to resolve
    this.eventEmitter.emit('setupComplete', data);
    // Session is now ready for communication
  }

  /**
   * Handle server content (text/audio responses)
   * @private
   */
  private handleServerContent(data: any): void {
    // Handle both snake_case and camelCase versions
    const modelTurn = data.model_turn || data.modelTurn;

    if (modelTurn?.parts) {
      for (const part of modelTurn.parts) {
        // Log the part for debugging
        if (this.debug) {
          this.log('Processing modelTurn part:', {
            hasText: !!part.text,
            hasInlineData: !!(part.inline_data || part.inlineData),
            text: part.text ? part.text.substring(0, 100) : undefined,
          });
        }

        // Handle text content
        if (part.text) {
          this.emit('writing', {
            text: part.text,
            role: 'assistant',
          });
        }

        // Handle audio content
        // Check both inline_data and inlineData
        const inlineData = part.inline_data || part.inlineData;
        if (inlineData && inlineData.mime_type?.includes('audio')) {
          try {
            const int16Array = this.base64ToInt16Array(inlineData.data);

            this.emit('speaking', {
              audio: inlineData.data, // Base64 string
              audioData: int16Array,
              sampleRate: this.audioConfig.outputSampleRate, // Gemini Live outputs at 24kHz
            });
          } catch (error) {
            this.log('Failed to process audio data', error);
            this.emit('error', {
              message: 'Failed to process received audio data',
              code: 'audio_processing_error',
              details: error,
            });
          }
        }
      }
    }

    // Check for turn completion (both versions)
    if (data.turn_complete || data.turnComplete) {
      this.log('Turn completed');
      this.emit('turnComplete', { timestamp: Date.now() });
    }
  }

  /**
   * Handle tool call requests from the model
   * @private
   */
  private async handleToolCall(data: any): Promise<void> {
    if (!data.toolCall) return;

    // Gemini sends function calls in an array
    const functionCalls = data.toolCall.functionCalls || data.toolCall.function_calls || [];

    if (functionCalls.length === 0) {
      this.log('No function calls in tool call message');
      return;
    }

    // Process each function call (usually just one)
    for (const functionCall of functionCalls) {
      const name = functionCall.name;
      const args = functionCall.args || functionCall.arguments || {};
      const id = functionCall.id;
      const toolCallId = id || randomUUID();

      this.log('Tool call received', { name, args, id: toolCallId });

      // Emit tool call start event
      this.emit('toolCallStart', {
        toolCallId,
        toolName: name,
        args: args || {},
      });

      try {
        // Find the tool in our transformed tools
        const tool = this.transformedTools?.find(t => t.geminiTool.name === name);

        if (!tool) {
          throw new Error(`Tool "${name}" not found`);
        }

        // Execute the tool
        const result = await tool.execute(args || {});

        this.log('Tool execution successful', { name, result });

        // Emit tool call result event
        this.emit('toolCallResult', {
          toolCallId,
          toolName: name,
          args: args || {},
          result,
        });

        // Send the result back to Gemini
        await this.sendToolResponse(toolCallId, result);
      } catch (error) {
        this.log('Tool execution failed', { name, error });

        // Emit tool call error event
        this.emit('toolCallError', {
          toolCallId,
          toolName: name,
          args: args || {},
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        // Send error response back to Gemini
        await this.sendToolResponse(toolCallId, {
          error: error instanceof Error ? error.message : 'Tool execution failed',
        });
      }
    } // End of for loop
  }

  /**
   * Handle token usage information
   * @private
   */
  private handleUsageUpdate(data: any): void {
    if (data.usage_metadata) {
      this.emit('usage', {
        inputTokens: data.usage_metadata.prompt_token_count || 0,
        outputTokens: data.usage_metadata.candidates_token_count || 0,
        totalTokens: data.usage_metadata.total_token_count || 0,
        modality: this.determineModality(data),
      });
    }
  }

  /**
   * Handle session end
   * @private
   */
  private handleSessionEnd(data: any): void {
    this.log('Session ended', data.reason);
    this.connectionState = 'disconnected';
    this.emit('session', { state: 'disconnected' });
  }

  /**
   * Determine the modality from message data
   * @private
   */
  private determineModality(data: any): 'audio' | 'text' | 'video' {
    // Simple heuristic - this could be more sophisticated
    if (data.server_content?.model_turn?.parts?.some((part: any) => part.inline_data?.mime_type?.includes('audio'))) {
      return 'audio';
    }
    if (data.server_content?.model_turn?.parts?.some((part: any) => part.inline_data?.mime_type?.includes('video'))) {
      return 'video';
    }
    return 'text';
  }

  /**
   * Send initial configuration to Gemini Live API
   * @private
   */
  private sendInitialConfig(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    // Build the setup message according to the actual Gemini Live API format
    // The message should be wrapped in a "setup" field
    const setupConfig: any = {
      model: `models/${this.model}`, // Gemini expects "models/" prefix
      generation_config: {
        response_modalities: [this.responseModality], // Configurable: TEXT for transcription, AUDIO for voice
        speech_config: {
          voice_config: {
            prebuilt_voice_config: {
              voice_name: this.speaker,
            },
          },
        },
      },
    };

    // Add system instructions if provided
    if (this.instructions) {
      setupConfig.system_instruction = {
        parts: [{ text: this.instructions }],
      };
    }

    // Add tools if configured
    if (this.transformedTools && this.transformedTools.length > 0) {
      setupConfig.tools = [
        {
          function_declarations: this.transformedTools.map(t => ({
            name: t.geminiTool.name,
            description: t.geminiTool.description,
            parameters: t.geminiTool.parameters,
          })),
        },
      ];
    }

    // Wrap in setup message
    const setupMessage = {
      setup: setupConfig,
    };

    this.log('Sending initial config', setupMessage);

    try {
      this.ws.send(JSON.stringify(setupMessage));
    } catch (error) {
      this.log('Failed to send initial config', error);
      throw new Error(
        `Failed to send initial configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Wait for WebSocket connection to open
   * @private
   */
  private waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }

      // If already open, resolve immediately
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      // Set up event listeners with cleanup
      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`WebSocket connection failed: ${error.message}`));
      };

      const onClose = () => {
        cleanup();
        reject(new Error('WebSocket connection closed before opening'));
      };

      const cleanup = () => {
        this.ws?.removeListener('open', onOpen);
        this.ws?.removeListener('error', onError);
        this.ws?.removeListener('close', onClose);
      };

      // Add event listeners
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
      this.ws.once('close', onClose);

      // Add timeout to prevent hanging indefinitely
      setTimeout(() => {
        cleanup();
        reject(new Error('WebSocket connection timeout'));
      }, 30000); // 30 second timeout
    });
  }

  /**
   * Wait for Gemini Live session to be created and ready
   * @private
   */
  private waitForSessionCreated(): Promise<void> {
    return new Promise((resolve, reject) => {
      // For Gemini Live API, the session is ready once WebSocket is open
      // We don't need to wait for a specific setupComplete message

      let isResolved = false;
      let timeoutId: NodeJS.Timeout;

      const onSetupComplete = () => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve();
        }
      };

      const onError = (errorData: any) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(new Error(`Session creation failed: ${errorData.message || 'Unknown error'}`));
        }
      };

      const onSessionEnd = () => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(new Error('Session ended before setup completed'));
        }
      };

      const cleanup = () => {
        this.eventEmitter.removeListener('setupComplete', onSetupComplete);
        this.eventEmitter.removeListener('error', onError);
        this.eventEmitter.removeListener('sessionEnd', onSessionEnd);
        if (timeoutId) clearTimeout(timeoutId);
      };

      // Listen for setup completion (if Gemini sends it)
      this.eventEmitter.once('setupComplete', onSetupComplete);
      this.eventEmitter.once('error', onError);
      this.eventEmitter.once('sessionEnd', onSessionEnd);

      // For Gemini Live API, if WebSocket is open, session is ready
      // Use a shorter timeout and check WebSocket state
      timeoutId = setTimeout(() => {
        if (!isResolved) {
          // If WebSocket is open, consider session ready
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.log('WebSocket open, proceeding without explicit setupComplete');
            isResolved = true;
            cleanup();
            resolve();
          } else {
            isResolved = true;
            cleanup();
            reject(new Error('Session creation timeout'));
          }
        }
      }, 2000); // Much shorter 2 second timeout since WebSocket is already open
    });
  }

  /**
   * Initialize Vertex AI authentication client
   * @private
   */
  private initializeVertexAIAuth(): void {
    try {
      const authOptions: any = {
        scopes: this.authScopes,
        projectId: this.project,
      };

      // Use service account key file if provided
      if (this.serviceAccountKeyFile) {
        authOptions.keyFilename = this.serviceAccountKeyFile;
        this.log('Using service account key file for authentication:', this.serviceAccountKeyFile);
      }

      // Use service account email for impersonation if provided
      if (this.serviceAccountEmail) {
        authOptions.clientOptions = {
          subject: this.serviceAccountEmail,
        };
        this.log('Using service account impersonation:', this.serviceAccountEmail);
      }

      // If no specific auth method provided, use Application Default Credentials (ADC)
      if (!this.serviceAccountKeyFile && !this.serviceAccountEmail && !this.accessToken) {
        this.log('Using Application Default Credentials (ADC) for authentication');
      }

      this.authClient = new GoogleAuth(authOptions);
      this.log('Vertex AI authentication client initialized successfully');
    } catch (error) {
      this.log('Failed to initialize Vertex AI authentication:', error);
      throw new Error(
        `Failed to initialize Vertex AI authentication: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get OAuth access token for Vertex AI authentication
   * @private
   */
  private async getAccessToken(): Promise<string> {
    // If access token is provided directly, use it (but check expiry)
    if (this.accessToken) {
      if (this.tokenExpiryTime && Date.now() < this.tokenExpiryTime) {
        return this.accessToken;
      }
    }

    if (!this.authClient) {
      throw new Error('Authentication client not initialized. Call initializeVertexAIAuth() first.');
    }

    try {
      // Get access token from Google Auth client
      const accessTokenResponse = await this.authClient.getAccessToken();

      if (!accessTokenResponse) {
        throw new Error('Failed to obtain access token - no response from auth client');
      }

      this.accessToken = accessTokenResponse;
      // Set token expiry time (Google tokens typically expire in 1 hour, we'll refresh 5 minutes early)
      this.tokenExpiryTime = Date.now() + 55 * 60 * 1000; // 55 minutes

      this.log('Successfully obtained Vertex AI access token');

      if (!this.accessToken) {
        throw new Error('Access token is empty after successful retrieval');
      }

      return this.accessToken;
    } catch (error) {
      this.log('Failed to obtain access token:', error);

      // Provide helpful error messages for common authentication issues
      if (error instanceof Error) {
        if (error.message.includes('ENOENT')) {
          throw new Error('Service account key file not found. Check the path in serviceAccountKeyFile configuration.');
        }
        if (error.message.includes('invalid_grant')) {
          throw new Error(
            'Invalid service account credentials. Check your service account key file or email configuration.',
          );
        }
        if (error.message.includes('forbidden')) {
          throw new Error(
            'Insufficient permissions. Ensure the service account has the required Cloud Platform scope.',
          );
        }
      }

      throw new Error(
        `Failed to obtain Vertex AI access token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Refresh the access token if it's about to expire
   * @private
   */
  private async refreshTokenIfNeeded(): Promise<void> {
    // Check if token needs refresh (5 minutes before expiry)
    if (this.tokenExpiryTime && Date.now() >= this.tokenExpiryTime - 5 * 60 * 1000) {
      this.log('Access token expiring soon, refreshing...');
      try {
        await this.getAccessToken();
        this.log('Access token refreshed successfully');
      } catch (error) {
        this.log('Failed to refresh access token:', error);
        throw error;
      }
    }
  }

  /**
   * Validate authentication configuration
   * @private
   */
  private validateAuthConfig(): void {
    if (!this.vertexAI) {
      return; // No validation needed for Gemini API
    }

    if (!this.project) {
      throw new Error('Google Cloud project ID is required for Vertex AI authentication');
    }

    // Check if at least one auth method is configured
    const hasServiceAccountFile = !!this.serviceAccountKeyFile;
    const hasServiceAccountEmail = !!this.serviceAccountEmail;
    const hasAccessToken = !!this.accessToken;
    const hasApiKey = !!this.apiKey;

    if (!hasServiceAccountFile && !hasServiceAccountEmail && !hasAccessToken && !hasApiKey) {
      this.log(
        'Warning: No explicit authentication method configured. Will attempt to use Application Default Credentials (ADC).',
      );
      this.log('Ensure GOOGLE_APPLICATION_CREDENTIALS environment variable is set or you are running on Google Cloud.');
    }

    // Validate scopes
    if (this.authScopes.length === 0) {
      throw new Error('At least one OAuth scope is required for Vertex AI authentication');
    }

    if (!this.authScopes.includes('https://www.googleapis.com/auth/cloud-platform')) {
      this.log('Warning: cloud-platform scope not included. This may cause permission issues.');
    }
  }

  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[GeminiLiveVoice] ${message}`, ...args);
    }
  }

  /**
   * Convert Int16Array audio data to base64 string for WebSocket transmission
   * @private
   */
  private int16ArrayToBase64(int16Array: Int16Array): string {
    const buffer = new ArrayBuffer(int16Array.length * 2);
    const view = new DataView(buffer);

    // Convert Int16Array to bytes with little-endian format
    for (let i = 0; i < int16Array.length; i++) {
      view.setInt16(i * 2, int16Array[i]!, true);
    }

    const nodeBuffer = Buffer.from(buffer);
    return nodeBuffer.toString('base64');
  }

  /**
   * Convert base64 string to Int16Array audio data
   * @private
   */
  private base64ToInt16Array(base64Audio: string): Int16Array {
    try {
      const buffer = Buffer.from(base64Audio, 'base64');

      // Convert Buffer to Int16Array
      if (buffer.length % 2 !== 0) {
        throw new Error('Invalid audio data: buffer length must be even for 16-bit audio');
      }

      return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    } catch (error) {
      throw new Error(
        `Failed to decode base64 audio data: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Validate and convert audio data to the required format for Gemini Live API
   * Gemini Live expects 16kHz PCM16 for input
   * @private
   */
  private validateAndConvertAudioInput(audioData: Buffer | Int16Array): Int16Array {
    if (Buffer.isBuffer(audioData)) {
      // Convert Buffer to Int16Array
      if (audioData.length % 2 !== 0) {
        throw new Error('Audio buffer length must be even for 16-bit audio');
      }
      return new Int16Array(audioData.buffer, audioData.byteOffset, audioData.byteLength / 2);
    }

    if (audioData instanceof Int16Array) {
      return audioData;
    }

    throw new Error('Unsupported audio data format. Expected Buffer or Int16Array');
  }

  /**
   * Process audio chunk for streaming - handles format validation and conversion
   * @private
   */
  private processAudioChunk(chunk: Buffer | Uint8Array | Int16Array): string {
    let int16Array: Int16Array;

    if (chunk instanceof Int16Array) {
      int16Array = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      if (chunk.length % 2 !== 0) {
        throw new Error('Audio chunk length must be even for 16-bit audio');
      }
      int16Array = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    } else if (chunk instanceof Uint8Array) {
      if (chunk.length % 2 !== 0) {
        throw new Error('Audio chunk length must be even for 16-bit audio');
      }
      int16Array = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    } else {
      throw new Error('Unsupported audio chunk format');
    }

    return this.int16ArrayToBase64(int16Array);
  }

  /**
   * Validate audio format and sample rate for Gemini Live API requirements
   * @private
   */
  private validateAudioFormat(sampleRate?: number, channels?: number): void {
    if (sampleRate && sampleRate !== this.audioConfig.inputSampleRate) {
      this.log(
        `Warning: Audio sample rate ${sampleRate}Hz does not match expected ${this.audioConfig.inputSampleRate}Hz`,
      );
    }

    if (channels && channels !== this.audioConfig.channels) {
      throw new Error(`Unsupported channel count: ${channels}. Gemini Live API requires mono audio (1 channel)`);
    }
  }

  /**
   * Create an audio message for the Gemini Live API
   * @private
   */
  private createAudioMessage(audioData: string, messageType: 'input' | 'realtime' = 'realtime'): any {
    if (messageType === 'input') {
      // For conversation item creation (traditional listen method)
      return {
        client_content: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  inline_data: {
                    mime_type: 'audio/pcm;rate=16000',
                    data: audioData,
                  },
                },
              ],
            },
          ],
          turn_complete: true,
        },
      };
    } else {
      // For real-time streaming
      return {
        realtime_input: {
          media_chunks: [
            {
              mime_type: 'audio/pcm;rate=16000',
              data: audioData,
            },
          ],
        },
      };
    }
  }

  /**
   * Stop the current audio stream if active
   * @private
   */
  private async stopCurrentAudioStream(): Promise<void> {
    if (this.currentAudioStream) {
      this.log('Stopping current audio stream');

      // Remove from active streams
      this.activeStreams.delete(this.currentAudioStream);

      // Clean up event listeners and destroy stream
      this.currentAudioStream.removeAllListeners();

      if ('destroy' in this.currentAudioStream && typeof this.currentAudioStream.destroy === 'function') {
        this.currentAudioStream.destroy();
      }

      this.currentAudioStream = undefined;
    }
  }

  /**
   * Handle audio stream input with proper resource management
   * @private
   */
  private async handleAudioStream(stream: NodeJS.ReadableStream): Promise<void> {
    this.currentAudioStream = stream;
    this.activeStreams.add(stream);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.activeStreams.delete(stream);
        this.currentAudioStream = undefined;
        stream.removeAllListeners();
      };

      stream.on('data', (chunk: Buffer) => {
        try {
          // If chunk is too large, split it into smaller pieces
          if (chunk.length > this.maxChunkSize) {
            this.log(`Splitting large chunk of ${chunk.length} bytes into smaller pieces`);
            let offset = 0;
            while (offset < chunk.length) {
              const subChunkSize = Math.min(this.maxChunkSize, chunk.length - offset);
              const subChunk = chunk.slice(offset, offset + subChunkSize);
              this.validateAudioChunk(subChunk);
              this.sendAudioChunk(subChunk);
              offset += subChunkSize;
            }
          } else {
            this.validateAudioChunk(chunk);
            this.sendAudioChunk(chunk);
          }
        } catch (error) {
          cleanup();
          this.emit('error', {
            message: `Failed to process audio chunk: ${error instanceof Error ? error.message : 'Unknown error'}`,
            code: 'audio_processing_error',
            details: error,
          });
          reject(error);
        }
      });

      stream.on('error', (error: Error) => {
        cleanup();
        this.emit('error', {
          message: `Audio stream error: ${error.message}`,
          code: 'audio_stream_error',
          details: {
            error: error.stack,
            streamState: 'readableEnded' in stream && stream.readableEnded ? 'ended' : 'active',
            wsState: this.ws?.readyState,
          },
        });
        reject(error);
      });

      stream.on('end', () => {
        cleanup();
        this.log('Audio stream completed');
        resolve();
      });
    });
  }

  /**
   * Handle single audio buffer input
   * @private
   */
  private async handleAudioBuffer(audioData: Int16Array): Promise<void> {
    try {
      const validatedAudio = this.validateAndConvertAudioInput(audioData);
      const base64Audio = this.int16ArrayToBase64(validatedAudio);
      const message = this.createAudioMessage(base64Audio, 'realtime');

      if (this.ws?.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not ready for audio transmission');
      }

      this.ws.send(JSON.stringify(message));
      this.log('Audio buffer sent successfully');
    } catch (error) {
      this.emit('error', {
        message: `Failed to send audio buffer: ${error instanceof Error ? error.message : 'Unknown error'}`,
        code: 'audio_buffer_error',
        details: error,
      });
      throw error;
    }
  }

  /**
   * Send a single audio chunk with throttling and validation
   * @private
   */
  private sendAudioChunk(chunk: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log('WebSocket not ready, dropping audio chunk');
      return;
    }

    // Throttling to prevent overwhelming the WebSocket
    const now = Date.now();
    if (now - this.lastSendTime < this.minSendInterval) {
      this.log('Audio send throttled, dropping chunk');
      return;
    }

    this.lastSendTime = now;

    try {
      const base64Audio = this.processAudioChunk(chunk);
      const message = this.createAudioMessage(base64Audio, 'realtime');
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.log('Failed to send audio chunk', error);
      this.emit('error', {
        message: 'Failed to send audio chunk',
        code: 'audio_chunk_send_error',
        details: error,
      });
    }
  }

  /**
   * Validate audio chunk format for Gemini Live API requirements
   * @private
   */
  private validateAudioChunk(chunk: Buffer): void {
    // Ensure chunk size is multiple of 2 (16-bit samples)
    if (chunk.length % 2 !== 0) {
      throw new Error('Invalid audio data: chunk size must be even for 16-bit audio');
    }

    // Validate reasonable chunk size
    if (chunk.length > this.maxChunkSize) {
      throw new Error(`Audio chunk too large: ${chunk.length} bytes (max: ${this.maxChunkSize})`);
    }

    // Ensure minimum chunk size to avoid too many tiny messages
    if (chunk.length < 32) {
      throw new Error(`Audio chunk too small: ${chunk.length} bytes (min: 32)`);
    }
  }

  /**
   * Send session resumption message
   * @private
   */
  private async sendSessionResumption(): Promise<void> {
    if (!this.sessionHandle) {
      throw new Error('No session handle available for resumption');
    }

    const resumeMessage = {
      session_resume: {
        handle: this.sessionHandle,
        ...(this.contextHistory.length > 0 && {
          context: this.contextHistory.map(item => ({
            role: item.role,
            content: item.content,
          })),
        }),
      },
    };

    try {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not ready for session resumption');
      }

      this.ws.send(JSON.stringify(resumeMessage));
      this.log('Session resumption message sent', { handle: this.sessionHandle });
    } catch (error) {
      this.log('Failed to send session resumption', error);
      throw new Error(`Failed to send session resumption: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Schedule automatic reconnection attempt
   * @private
   */
  private async scheduleReconnect(): Promise<void> {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s

    this.log(`Scheduling reconnection attempt in ${delay}ms`, {
      attempt: this.reconnectAttempts + 1,
      maxAttempts: this.maxReconnectAttempts,
    });

    return new Promise(resolve => {
      this.reconnectTimeout = setTimeout(async () => {
        try {
          await this.connect();
          resolve();
        } catch (error) {
          this.log('Reconnection attempt failed', error);
          resolve(); // Resolve anyway to prevent hanging
        }
      }, delay);
    });
  }

  /**
   * Start monitoring session duration
   * @private
   */
  private startSessionDurationMonitor(): void {
    if (!this.sessionConfig?.maxDuration) {
      return;
    }

    // Parse duration string (e.g., '24h', '2h', '30m')
    const durationMs = this.parseDuration(this.sessionConfig.maxDuration);

    if (!durationMs) {
      this.log('Invalid session duration format', { duration: this.sessionConfig.maxDuration });
      return;
    }

    // Clear existing monitor if any
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Set timeout for session expiry warning
    const warningTime = durationMs - 5 * 60 * 1000; // 5 minutes before expiry

    if (warningTime > 0) {
      setTimeout(() => {
        this.emit('sessionExpiring', {
          expiresIn: 5 * 60 * 1000,
          sessionId: this.sessionId,
        });
      }, warningTime);
    }

    // Set timeout for session expiry
    setTimeout(() => {
      this.log('Session duration limit reached, disconnecting');
      void this.disconnect();
    }, durationMs);
  }

  /**
   * Parse duration string to milliseconds
   * @private
   */
  private parseDuration(duration: string): number | null {
    const match = duration.match(/^(\d+)([hms])$/);
    if (!match) return null;

    const value = parseInt(match[1]!, 10);
    const unit = match[2];

    switch (unit) {
      case 'h':
        return value * 60 * 60 * 1000;
      case 'm':
        return value * 60 * 1000;
      case 's':
        return value * 1000;
      default:
        return null;
    }
  }

  /**
   * Send tool response back to Gemini
   * @private
   */
  private async sendToolResponse(toolCallId: string, result: any): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not ready for tool response');
    }

    // Gemini Live API expects functionResponses format
    const message = {
      toolResponse: {
        functionResponses: [
          {
            id: toolCallId,
            response: {
              output: typeof result === 'string' ? result : JSON.stringify(result),
            },
          },
        ],
      },
    };

    this.ws.send(JSON.stringify(message));
    this.log('Tool response sent', { toolCallId, result });
  }

  /**
   * Send tools update to active session
   * NOTE: Gemini Live API doesn't support dynamic tool updates after session starts.
   * Tools must be configured during initial setup.
   * @private
   */
  private sendToolsUpdate(): void {
    if (!this.transformedTools || this.transformedTools.length === 0) {
      return;
    }

    // Gemini Live API doesn't support dynamic tool updates
    // We need to reconnect with the new tools configuration
    this.log(
      'Warning: Gemini Live API does not support dynamic tool updates. Tools must be configured before connecting.',
    );
    this.emit('error', {
      message:
        'Tools cannot be updated after connection. Please disconnect and reconnect with the new tool configuration.',
      code: 'tools_update_not_supported',
      details: {
        toolCount: this.transformedTools.length,
        toolNames: this.transformedTools.map(t => t.geminiTool.name),
      },
    });
  }

  /**
   * Transform Mastra tools to Gemini format
   * @private
   */
  private transformTools(
    tools: ToolsInput,
  ): Array<{ geminiTool: GeminiToolConfig; execute: (args: any) => Promise<any> }> {
    const transformedTools: Array<{ geminiTool: GeminiToolConfig; execute: (args: any) => Promise<any> }> = [];

    for (const [name, tool] of Object.entries(tools)) {
      let parameters: any;

      // Extract parameters from tool definition
      if ('inputSchema' in tool && tool.inputSchema) {
        if (this.isZodObject(tool.inputSchema)) {
          parameters = zodToJsonSchema(tool.inputSchema);
          delete parameters.$schema;
        } else {
          parameters = tool.inputSchema;
        }
      } else if ('parameters' in tool) {
        if (this.isZodObject(tool.parameters)) {
          parameters = zodToJsonSchema(tool.parameters);
          delete parameters.$schema;
        } else {
          parameters = tool.parameters;
        }
      } else {
        this.log(`Tool ${name} has neither inputSchema nor parameters, skipping`);
        continue;
      }

      // Create Gemini tool configuration
      const geminiTool: GeminiToolConfig = {
        name,
        description: tool.description || `Tool: ${name}`,
        parameters,
      };

      if (tool.execute) {
        // Create an adapter function for tool execution
        const executeAdapter = async (args: any) => {
          try {
            if (!tool.execute) {
              throw new Error(`Tool ${name} has no execute function`);
            }

            // For ToolAction, the first argument is a context object
            if ('inputSchema' in tool) {
              return await tool.execute({ context: args });
            }
            // For VercelTool, pass args directly with minimal options
            else {
              const options = {
                toolCallId: 'gemini-tool-call',
                messages: [],
              };
              return await tool.execute(args, options);
            }
          } catch (error) {
            this.log(`Error executing tool ${name}:`, error);
            throw error;
          }
        };

        transformedTools.push({ geminiTool, execute: executeAdapter });
      } else {
        this.log(`Tool ${name} has no execute function, skipping`);
      }
    }

    return transformedTools;
  }

  /**
   * Check if a schema is a Zod object
   * @private
   */
  private isZodObject(schema: unknown): boolean {
    return (
      !!schema &&
      typeof schema === 'object' &&
      '_def' in schema &&
      !!(schema as any)._def &&
      typeof (schema as any)._def === 'object' &&
      'typeName' in (schema as any)._def &&
      (schema as any)._def.typeName === 'ZodObject'
    );
  }

  /**
   * Compress context history to manage memory
   * @private
   */
  private compressContext(): void {
    if (this.contextHistory.length <= 50) {
      return;
    }

    // Keep first 10 and last 40 messages
    const firstMessages = this.contextHistory.slice(0, 10);
    const lastMessages = this.contextHistory.slice(-40);

    this.contextHistory = [
      ...firstMessages,
      {
        role: 'system',
        content: `[${this.contextHistory.length - 50} messages compressed]`,
        timestamp: Date.now(),
      },
      ...lastMessages,
    ];

    this.log('Context history compressed', {
      originalSize: this.contextHistory.length + (this.contextHistory.length - 50),
      compressedSize: this.contextHistory.length,
    });
  }
}
