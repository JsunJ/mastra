import type { OtelConfig } from '@mastra/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  AlwaysOnSampler,
  AlwaysOffSampler,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter as OTLPHttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPGrpcExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
// Remove SpanExporter type import since we only use it in function signatures
// The actual classes are imported from the vendor module

/**
 * Manual OpenTelemetry instrumentation for NestJS + Mastra + Laminar
 * This is required when using custom servers (not Mastra's embedded server)
 * Based on: https://github.com/lmnr-ai/lmnr/issues/584
 */

function getSampler(config: OtelConfig) {
  if (!config.sampling) {
    return new AlwaysOnSampler();
  }

  if (!config.enabled) {
    return new AlwaysOffSampler();
  }

  switch (config.sampling.type) {
    case 'ratio':
      return new TraceIdRatioBasedSampler(config.sampling.probability);
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'parent_based': {
      const rootSampler = new TraceIdRatioBasedSampler(config.sampling.root?.probability || 1.0);
      return new ParentBasedSampler({ root: rootSampler });
    }
    default:
      return new AlwaysOnSampler();
  }
}

async function getExporters(config: OtelConfig) {
  const exporters: any[] = [];

  if (config.export?.type === 'otlp') {
    if (config.export?.protocol === 'grpc') {
      exporters.push(
        new OTLPGrpcExporter({
          url: config.export.endpoint,
          headers: config.export.headers,
        }),
      );
    } else {
      exporters.push(
        new OTLPHttpExporter({
          url: config.export.endpoint,
          headers: config.export.headers,
        }),
      );
    }
  } else if (config.export?.type === 'custom') {
    exporters.push(config.export.exporter);
  }

  return exporters;
}

export async function initializeTelemetry(telemetryConfig: OtelConfig) {
  console.log('🔧 Initializing OpenTelemetry instrumentation...');
  console.log('📡 Telemetry Config:', {
    serviceName: telemetryConfig.serviceName,
    enabled: telemetryConfig.enabled,
    exportType: telemetryConfig.export?.type,
    exportProtocol: telemetryConfig.export?.type === 'otlp' ? telemetryConfig.export?.protocol : undefined,
    endpoint: telemetryConfig.export?.type === 'otlp' ? telemetryConfig.export?.endpoint : undefined,
  });

  const sampler = getSampler(telemetryConfig);
  const exporters = await getExporters(telemetryConfig);

  // Use the first exporter (simplified for this example)
  const exporter = exporters[0];

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: telemetryConfig.serviceName || 'telemetry-validation-nestjs',
    }),
    sampler,
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  console.log('✅ OpenTelemetry SDK initialized successfully');

  // Gracefully shut down the SDK on process exit
  process.on('SIGTERM', () => {
    console.log('🛑 Shutting down OpenTelemetry SDK...');
    sdk.shutdown().catch(() => {
      // do nothing
    });
  });

  return sdk;
}
