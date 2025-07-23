// CRITICAL: Initialize OpenTelemetry BEFORE importing any application code
// This is required for self-hosted Laminar when using custom servers like NestJS
// Based on: https://github.com/lmnr-ai/lmnr/issues/584

import { initializeTelemetry } from './instrumentation';
import { telemetry } from './mastra.config';

async function bootstrap() {
  // Initialize OpenTelemetry first (before NestJS)
  await initializeTelemetry(telemetry);

  // Now import and start NestJS
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create(AppModule);

  // Enable CORS for testing
  app.enableCors();

  const port = process.env.PORT || 3000;

  console.log('🚀 Starting Telemetry Validation Server...');
  console.log('📡 Telemetry Configuration:');
  console.log('   - Service: telemetry-validation-nestjs');
  console.log('   - Provider: Self-hosted Laminar');
  console.log(
    '   - Endpoint:',
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'Not configured (defaulting to http://localhost:8000)',
  );
  console.log('   - Headers:', process.env.OTEL_EXPORTER_OTLP_HEADERS ? 'Configured' : 'Not configured');
  console.log('');
  console.log('🔧 Available Endpoints:');
  console.log(`   - GET http://localhost:${port}/agent/ask?q=<question>           (streaming)`);
  console.log(`   - GET http://localhost:${port}/agent/ask-blocked?q=<question>  (generate)`);
  console.log(`   - GET http://localhost:${port}/agent/debug-stream?q=<question> (debug)`);
  console.log(`   - GET http://localhost:${port}/agent/health                    (health check)`);
  console.log('');
  console.log('💡 Test with: curl "http://localhost:3000/agent/ask?q=你是谁？"');
  console.log('📊 Check your self-hosted Laminar dashboard for traces!');
  console.log('');

  await app.listen(port);
  console.log(`✅ Server running on http://localhost:${port}`);
}

bootstrap().catch(console.error);
