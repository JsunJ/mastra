# @mastra/voice-google-gemini-live

Google Gemini Live API integration for Mastra, providing real-time multimodal voice interactions with advanced capabilities including video input, tool calling, and session management.

## Installation

```bash
npm install @mastra/voice-google-gemini-live
```

## Configuration

The module supports multiple authentication methods:

### For Google Gemini API (Simple)

```bash
GOOGLE_API_KEY=your_api_key
```

### For Vertex AI (Production - Multiple Options)

#### Option 1: Application Default Credentials (Recommended)

```bash
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
GOOGLE_CLOUD_PROJECT=your_project_id
```

#### Option 2: Service Account Key File

```typescript
const voice = new GeminiLiveVoice({
  vertexAI: true,
  project: 'your-project-id',
  serviceAccountKeyFile: '/path/to/service-account.json',
});
```

#### Option 3: Service Account Impersonation

```typescript
const voice = new GeminiLiveVoice({
  vertexAI: true,
  project: 'your-project-id',
  serviceAccountEmail: 'service-account@project.iam.gserviceaccount.com',
});
```

#### Option 4: Direct Access Token

```typescript
const voice = new GeminiLiveVoice({
  vertexAI: true,
  project: 'your-project-id',
  accessToken: 'your-oauth-access-token',
});
```

## Usage

```typescript
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';

// Initialize with Gemini API
const voice = new GeminiLiveVoice({
  apiKey: 'your-api-key', // Optional, can use GOOGLE_API_KEY env var
  model: 'gemini-2.0-flash-live-001',
  speaker: 'Puck', // Default voice
  responseModality: 'TEXT', // 'TEXT' or 'AUDIO' (default: 'TEXT')
});

// OR initialize with Vertex AI (recommended for production)
const voice = new GeminiLiveVoice({
  vertexAI: true,
  project: 'your-project-id',
  model: 'gemini-2.0-flash-live-001',
  speaker: 'Puck',
  responseModality: 'TEXT', // 'TEXT' for text responses, 'AUDIO' for voice
  // Authentication handled automatically via ADC or configure manually
});

// Connect to the Live API
await voice.connect();

// Listen for responses
voice.on('speaking', ({ audio }) => {
  // Handle audio response (Int16Array)
  playAudio(audio);
});

voice.on('writing', ({ text, role }) => {
  // Handle transcribed text
  console.log(`${role}: ${text}`);
});

// Send text to speech
await voice.speak('Hello from Mastra!');

// Send audio stream
const microphoneStream = getMicrophoneStream();
await voice.send(microphoneStream);

// When done, disconnect
voice.disconnect();
```

## Features

- **Real-time bidirectional audio streaming**
- **Multimodal input support** (audio, video, text)
- **Built-in Voice Activity Detection (VAD)**
- **Interrupt handling** - Natural conversation flow
- **Session management** - Resume conversations after network interruptions
- **Tool calling support** - Integrate with external APIs and functions
- **Live transcription** - Real-time speech-to-text
- **Multiple voice options** - Choose from various voice personalities
- **Multilingual support** - Support for 30+ languages

## Advanced Features

### Response Modalities

The Gemini Live API can respond with either text or audio (but not both simultaneously):

```typescript
// For text responses (e.g., chatbots, transcription)
const textVoice = new GeminiLiveVoice({
  apiKey: 'your-api-key',
  responseModality: 'TEXT', // Default
});

// For audio responses (e.g., voice assistants)
const audioVoice = new GeminiLiveVoice({
  apiKey: 'your-api-key',
  responseModality: 'AUDIO',
});
```

### Video Input

```typescript
// Send video frames alongside audio
const videoStream = getCameraStream();
await voice.sendVideo(videoStream);
```

### Tool Calling

```typescript
// IMPORTANT: Tools must be configured BEFORE connecting
const voice = new GeminiLiveVoice({
  apiKey: 'your-api-key',
  responseModality: 'TEXT',
});

// Add tools before connecting
voice.addTools({
  get_weather: {
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string' },
      },
    },
    execute: async ({ location }) => {
      // Implementation
      return { temperature: 72, condition: 'sunny' };
    },
  },
});

// Now connect with tools ready
await voice.connect();
```

### Session Management

```typescript
// Enable session resumption
const voice = new GeminiLiveVoice({
  sessionConfig: {
    enableResumption: true,
    maxDuration: '24h',
  },
});

// Resume a previous session
await voice.resumeSession(sessionHandle);
```

### Authentication Management

For Vertex AI, you can monitor and manage authentication:

```typescript
// Check authentication status
const authStatus = voice.getAuthStatus();
console.log('Authenticated:', authStatus.isAuthenticated);
console.log('Method:', authStatus.authMethod);
console.log('Token expiry:', authStatus.tokenExpiry);

// Manually refresh authentication token (Vertex AI only)
await voice.refreshAuth();
```

## Voice Options

- **Puck** - Conversational, friendly
- **Charon** - Deep, authoritative
- **Kore** - Neutral, professional
- **Fenrir** - Warm, approachable

## Model Options

- `gemini-2.0-flash-live-001` - Latest production model
- `gemini-2.5-flash-preview-native-audio-dialog` - Preview with native audio
- `gemini-live-2.5-flash-preview` - Half-cascade architecture

For detailed API documentation, visit [Google's Gemini Live API docs](https://ai.google.dev/gemini-api/docs/live).
