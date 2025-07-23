import { Mastra, Agent } from '@mastra/core';
import { openai } from '@ai-sdk/openai';
import type { OtelConfig } from '@mastra/core';

// Create the agent that matches the user's setup
const myAgent = new Agent({
  name: 'myAgent',
  instructions: 'You are a helpful assistant.',
  model: openai('gpt-4o'),
});

// Telemetry configuration for self-hosted Laminar
// Environment variables needed:
// - OPENAI_API_KEY: Your OpenAI API key
// - OTEL_EXPORTER_OTLP_ENDPOINT: Your self-hosted Laminar endpoint (e.g., http://localhost:8000)
// - OTEL_EXPORTER_OTLP_HEADERS: Authorization header (e.g., "Authorization=Bearer your_api_key")
export const telemetryConfig: OtelConfig = {
  serviceName: 'laminar',
  enabled: true,
  export: {
    type: 'otlp',
    protocol: 'grpc', // Use 'grpc' if your self-hosted Laminar supports it
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:8000',
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
      ? Object.fromEntries(
          process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map(header => {
            const [key, value] = header.trim().split('=');
            return [key, value];
          }),
        )
      : undefined,
  },
};

// Configure Mastra with telemetry (simplified for self-hosted Laminar)
export const mastra: Mastra = new Mastra({
  agents: { myAgent },
  telemetry: telemetryConfig,
});

// Export telemetry config for manual instrumentation
export { telemetryConfig as telemetry };
