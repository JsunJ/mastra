# Telemetry Validation - NestJS + Self-Hosted Laminar

This example recreates the user setup from [GitHub Issue #5870](https://github.com/mastra-ai/mastra/issues/5870) to validate that our telemetry streaming fix works with **self-hosted Laminar instances**.

## 🔧 **Key Fix for Self-Hosted Laminar**

**Problem**: When using NestJS (or any custom server) with Mastra, telemetry traces don't appear in self-hosted Laminar dashboards.

**Root Cause**: Mastra only automatically initializes OpenTelemetry instrumentation when using its embedded server. Custom servers like NestJS require **manual instrumentation**.

**Solution**: Based on [Laminar GitHub Issue #584](https://github.com/lmnr-ai/lmnr/issues/584), we need to manually initialize OpenTelemetry **before** starting the NestJS application.

## 🎯 Purpose

Test and validate that:

- ✅ **Before Fix**: `agent.stream()` telemetry showed pending promises: `{"usagePromise":{"status":{"type":"pending"}}}`
- ✅ **After Fix**: `agent.stream()` telemetry shows resolved data: `{"usage":{"promptTokens":21,"completionTokens":48}}`
- ✅ **Self-Hosted Laminar**: Traces now appear in your self-hosted Laminar dashboard

## 🚀 Setup Instructions

### 1. Environment Configuration

Create a `.env` file with these variables for your self-hosted Laminar:

```bash
# OpenAI API Key (required)
OPENAI_API_KEY=your_openai_api_key_here

# Self-Hosted Laminar Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-laminar-host:8000
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your_laminar_api_key"

# Server Configuration
PORT=3000
```

**Common self-hosted Laminar endpoints:**

- Local development: `http://localhost:8000`
- Docker: `http://laminar:8000`
- Custom domain: `https://your-laminar-domain.com`

### 2. Install Dependencies

```bash
cd examples/telemetry-validation-nestjs
npm install
```

### 3. Build and Start Server

```bash
npm run build
npm run start:dev
```

## 🧪 Testing the Fix

### Test Endpoints

The server provides four endpoints for comprehensive testing:

#### 1. Streaming Endpoint (Fixed)

```bash
curl "http://localhost:3000/agent/ask?q=你是谁？"
```

- **Before Fix**: Telemetry would show pending promises
- **After Fix**: Telemetry shows resolved usage, finishReason, etc.

#### 2. Generate Endpoint (Comparison)

```bash
curl "http://localhost:3000/agent/ask-blocked?q=你是谁？"
```

- This always worked correctly (for comparison)

#### 3. Debug Endpoint (Enhanced)

```bash
curl "http://localhost:3000/agent/debug-stream?q=你是谁？"
```

- Shows detailed console logging of the onFinish callback
- Helpful for debugging telemetry capture

#### 4. Health Check

```bash
curl "http://localhost:3000/agent/health"
```

- Shows telemetry configuration status

### Expected Telemetry Results in Self-Hosted Laminar

#### ✅ Streaming Endpoint (After Fix)

```json
{
  "agent.stream.result": "{\"text\":\"我是豆包...\",\"usage\":{\"promptTokens\":21,\"completionTokens\":48,\"totalTokens\":69},\"finishReason\":\"stop\",\"toolCalls\":[],\"warnings\":[]}"
}
```

#### ❌ Previous Behavior (Before Fix)

```json
{
  "agent.stream.result": "{\"warningsPromise\":{\"status\":{\"type\":\"pending\"}},\"usagePromise\":{\"status\":{\"type\":\"pending\"}}...}"
}
```

## 🔍 Architecture & Key Files

### Critical Implementation Details

#### 1. **Manual OpenTelemetry Initialization** (`src/instrumentation.ts`)

```typescript
// Initialize OpenTelemetry BEFORE any application code
await initializeTelemetry(telemetryConfig);
```

#### 2. **Proper Startup Order** (`src/main.ts`)

```typescript
// CRITICAL: Initialize OpenTelemetry first
await initializeTelemetry(telemetry);

// THEN import and start NestJS
const { NestFactory } = await import('@nestjs/core');
```

#### 3. **Simplified Headers** (`src/mastra.config.ts`)

```typescript
// No team ID required for self-hosted Laminar
headers: {
  'Authorization': 'Bearer your_api_key'
}
```

### File Structure

```
src/
├── instrumentation.ts    # Manual OpenTelemetry setup (KEY FIX)
├── mastra.config.ts     # Mastra + telemetry configuration
├── main.ts              # Startup with proper initialization order
├── agent.controller.ts  # Test endpoints matching GitHub issue
└── app.module.ts        # NestJS module
```

## 🔧 Troubleshooting

### No Traces in Self-Hosted Laminar Dashboard

**Most Common Issue**: Missing manual OpenTelemetry initialization

✅ **Solution**: Ensure `initializeTelemetry()` is called **before** importing any NestJS code:

```typescript
// ✅ Correct order
await initializeTelemetry(telemetry);
const { NestFactory } = await import('@nestjs/core');

// ❌ Wrong order (won't work)
const { NestFactory } = await import('@nestjs/core');
await initializeTelemetry(telemetry);
```

### Connection Issues

```
Error: Failed to export spans
```

**Solutions**:

1. Verify your self-hosted Laminar endpoint is accessible
2. Check API key format: `Authorization=Bearer your_key` (no team ID needed)
3. Test endpoint connectivity: `curl http://your-laminar-host:8000/health`
4. Check network/firewall rules

### Build Errors

```
Error: Cannot find module '@mastra/core'
```

**Solution**: Ensure you're in the monorepo and run `npm install` from root first

## 📊 Self-Hosted Laminar Integration

This setup works with:

- ✅ **Docker-based Laminar** deployments
- ✅ **Kubernetes Laminar** deployments
- ✅ **Local development** Laminar instances
- ✅ **Custom domain** Laminar deployments

**Key Differences from Cloud Laminar**:

- No team ID required in headers
- Custom endpoint configuration
- Self-managed API keys

## 🐛 Original Issue Reference

This setup addresses:

1. **[Mastra Issue #5870](https://github.com/mastra-ai/mastra/issues/5870)**: Telemetry captured pending promises instead of resolved values
2. **[Laminar Issue #584](https://github.com/lmnr-ai/lmnr/issues/584)**: Missing traces when using custom servers with self-hosted Laminar

**Root Causes**:

- Mastra's `@InstrumentClass` decorator captured `StreamTextResult` before promises resolved
- Custom servers require manual OpenTelemetry instrumentation for telemetry export

**Solutions**:

- Deferred telemetry capture using enhanced `onFinish` callback (Mastra fix)
- Manual OpenTelemetry initialization before application startup (Self-hosted Laminar fix)

## 🎉 Expected Results

After running this setup:

1. **Console Output**: Shows OpenTelemetry initialization and resolved telemetry data
2. **Self-Hosted Laminar Dashboard**: Displays traces with proper `agent.stream.result` attributes
3. **Resolved Data**: Telemetry shows actual usage, finishReason, toolCalls instead of pending promises
4. **Streaming vs Generate**: Both methods now show resolved telemetry data
