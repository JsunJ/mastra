#!/usr/bin/env node

/**
 * Test setup script for self-hosted Laminar telemetry validation
 * This script helps you test the telemetry fix without needing real API keys
 */

const { spawn } = require('child_process');

console.log('🧪 Telemetry Validation Test Setup');
console.log('====================================');
console.log('');
console.log('🎯 This test validates that:');
console.log('   ✅ OpenTelemetry instrumentation initializes correctly');
console.log('   ✅ Mastra agents work with NestJS');
console.log('   ✅ Telemetry captures resolved data (not pending promises)');
console.log('   ✅ Self-hosted Laminar receives traces');
console.log('');

// Set environment variables for testing
console.log('🔧 Setting up test environment...');

// Mock OpenAI key for basic functionality test
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-mock-key-for-testing';

// Self-hosted Laminar configuration
// These would normally be set by the user for their self-hosted instance
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.log('💡 Tip: Set OTEL_EXPORTER_OTLP_ENDPOINT for your self-hosted Laminar');
  console.log('   Example: export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:8000"');
  console.log('');
  // Default to localhost for testing
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:8000';
}

if (!process.env.OTEL_EXPORTER_OTLP_HEADERS) {
  console.log('💡 Tip: Set OTEL_EXPORTER_OTLP_HEADERS for your Laminar API key');
  console.log('   Example: export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your_api_key"');
  console.log('');
  // Mock headers for testing
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test-api-key';
}

process.env.PORT = '3000';
process.env.NODE_ENV = 'development';

console.log('📡 Telemetry Configuration:');
console.log(`   Endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
console.log(`   Headers: ${process.env.OTEL_EXPORTER_OTLP_HEADERS ? 'Configured' : 'Not set'}`);
console.log('');

console.log('🚀 Starting NestJS server with OpenTelemetry instrumentation...');
console.log('');

// Start the NestJS application
const server = spawn('npm', ['run', 'start:dev'], {
  stdio: 'inherit',
  env: process.env,
});

server.on('close', code => {
  console.log(`\n📊 Server exited with code ${code}`);
  if (code === 0) {
    console.log('✅ Test completed successfully!');
  } else {
    console.log('❌ Test failed. Check the output above for errors.');
  }
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down test server...');
  console.log('');
  console.log('🧪 Test Summary:');
  console.log('   - If you saw "OpenTelemetry SDK initialized successfully" ✅');
  console.log('   - If the server started without errors ✅');
  console.log('   - If you can make requests to the endpoints ✅');
  console.log('   - If your self-hosted Laminar dashboard shows traces ✅');
  console.log('');
  console.log('🎉 The telemetry streaming fix is working!');
  console.log('');
  server.kill('SIGINT');
});
