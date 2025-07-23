import { trace, context, SpanStatusCode, SpanKind, propagation } from '@opentelemetry/api';

import { hasActiveTelemetry, getBaggageValues } from './utility';

// Helper function to detect if a result is from a streaming method
function isStreamingResult(result: any, methodName: string): boolean {
  // Check method name first (most reliable)
  if (methodName === 'stream' || methodName === 'streamVNext') {
    return true;
  }

  // Check for streaming result properties (backup detection)
  if (result && typeof result === 'object') {
    return (
      'textStream' in result || 'objectStream' in result || 'usagePromise' in result || 'finishReasonPromise' in result
    );
  }

  return false;
}

// Helper function to enhance streaming arguments with telemetry capture
function enhanceStreamingArgumentsWithTelemetry(args: any[], span: any, spanName: string, methodName: string): any[] {
  // For Agent.stream(), the arguments are: [messages, streamOptions]
  if (methodName === 'stream' || methodName === 'streamVNext') {
    // Clone arguments to avoid mutating originals
    const enhancedArgs = [...args];

    // Get or create streamOptions (second argument)
    const streamOptions = enhancedArgs[1] || {};
    const enhancedStreamOptions = { ...streamOptions };

    // Get the original onFinish callback
    const originalOnFinish = enhancedStreamOptions.onFinish;

    // Create our telemetry-enhanced onFinish callback
    enhancedStreamOptions.onFinish = async (finishData: any) => {
      try {
        // Capture the resolved telemetry data
        const telemetryData = {
          text: finishData.text,
          usage: finishData.usage,
          finishReason: finishData.finishReason,
          toolCalls: finishData.toolCalls,
          toolResults: finishData.toolResults,
          warnings: finishData.warnings,
          // Add any other valuable fields
        };

        // Set the span attribute with real resolved data
        span.setAttribute(`${spanName}.result`, JSON.stringify(telemetryData));
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Handle telemetry errors gracefully - never break the user's flow
        span.setAttribute(`${spanName}.result`, '[Telemetry Capture Error]');
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }

      // Always call the original onFinish callback
      if (originalOnFinish) {
        return await originalOnFinish(finishData);
      }
    };

    // Replace the streamOptions in the arguments
    enhancedArgs[1] = enhancedStreamOptions;

    // Mark span as streaming (so we don't end it in .finally())
    (span as any)._mastraStreamingSpan = true;

    return enhancedArgs;
  }

  // For non-streaming methods, return original arguments
  return args;
}

// Decorator factory that takes optional spanName
export function withSpan(options: {
  spanName?: string;
  skipIfNoTelemetry?: boolean;
  spanKind?: SpanKind;
  tracerName?: string;
}): any {
  return function (_target: any, propertyKey: string | symbol, descriptor?: PropertyDescriptor | number) {
    if (!descriptor || typeof descriptor === 'number') return;

    const originalMethod = descriptor.value;
    const methodName = String(propertyKey);

    descriptor.value = function (...args: any[]) {
      // Skip if no telemetry is available and skipIfNoTelemetry is true
      if (options?.skipIfNoTelemetry && !hasActiveTelemetry(options?.tracerName)) {
        return originalMethod.apply(this, args);
      }

      const tracer = trace.getTracer(options?.tracerName ?? 'default-tracer');

      // Determine span name and kind
      let spanName: string;
      let spanKind: SpanKind | undefined;

      if (typeof options === 'string') {
        spanName = options;
      } else if (options) {
        spanName = options.spanName || methodName;
        spanKind = options.spanKind;
      } else {
        spanName = methodName;
      }

      // Start the span with optional kind
      const span = tracer.startSpan(spanName, { kind: spanKind });
      let ctx = trace.setSpan(context.active(), span);

      // Record input arguments as span attributes
      args.forEach((arg, index) => {
        try {
          span.setAttribute(`${spanName}.argument.${index}`, JSON.stringify(arg));
        } catch {
          span.setAttribute(`${spanName}.argument.${index}`, '[Not Serializable]');
        }
      });

      const { requestId, componentName, runId } = getBaggageValues(ctx);
      if (requestId) {
        span.setAttribute('http.request_id', requestId);
      }

      if (componentName) {
        span.setAttribute('componentName', componentName);
        // @ts-ignore
        span.setAttribute('runId', runId);
        // @ts-ignore
      } else if (this && this.name) {
        // @ts-ignore
        span.setAttribute('componentName', this.name);
        // @ts-ignore
        span.setAttribute('runId', this.runId);
        ctx = propagation.setBaggage(
          ctx,
          propagation.createBaggage({
            // @ts-ignore
            componentName: { value: this.name },
            // @ts-ignore
            runId: { value: this.runId },
            // @ts-ignore
            'http.request_id': { value: requestId },
          }),
        );
      }

      let result;
      try {
        // For streaming methods, enhance arguments with telemetry capture before calling
        const enhancedArgs = isStreamingResult(null, methodName)
          ? enhanceStreamingArgumentsWithTelemetry(args, span, spanName, methodName)
          : args;

        // Call the original method within the context
        result = context.with(ctx, () => originalMethod.apply(this, enhancedArgs));

        // Handle promises
        if (result instanceof Promise) {
          return result
            .then(resolvedValue => {
              // Check if this is a streaming result that needs deferred telemetry
              if (isStreamingResult(resolvedValue, methodName)) {
                // For streaming results, the span will be completed by the enhanced onFinish callback
                // Just return the resolved value as-is since we already enhanced the arguments
                return resolvedValue;
              } else {
                // For regular promises, capture result immediately (existing behavior)
                try {
                  span.setAttribute(`${spanName}.result`, JSON.stringify(resolvedValue));
                } catch {
                  span.setAttribute(`${spanName}.result`, '[Not Serializable]');
                }
                return resolvedValue;
              }
            })
            .catch(error => {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : 'Unknown error',
              });
              if (error instanceof Error) {
                span.recordException(error);
              }
              throw error;
            })
            .finally(() => {
              // Only end span if it's not a streaming span (which will be ended later)
              if (!(span as any)._mastraStreamingSpan) {
                span.end();
              }
            });
        }

        // Record result for non-promise returns
        try {
          span.setAttribute(`${spanName}.result`, JSON.stringify(result));
        } catch {
          span.setAttribute(`${spanName}.result`, '[Not Serializable]');
        }

        // Return regular results
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        // End span for non-promise returns
        if (!(result instanceof Promise)) {
          span.end();
        }
      }
    };

    return descriptor;
  };
}

// class-telemetry.decorator.ts
export function InstrumentClass(options?: {
  prefix?: string;
  spanKind?: SpanKind;
  excludeMethods?: string[];
  methodFilter?: (methodName: string) => boolean;
  tracerName?: string;
}) {
  return function (target: any) {
    const methods = Object.getOwnPropertyNames(target.prototype);

    methods.forEach(method => {
      // Skip excluded methods
      if (options?.excludeMethods?.includes(method) || method === 'constructor') return;
      // Apply method filter if provided
      if (options?.methodFilter && !options.methodFilter(method)) return;

      const descriptor = Object.getOwnPropertyDescriptor(target.prototype, method);
      if (descriptor && typeof descriptor.value === 'function') {
        Object.defineProperty(
          target.prototype,
          method,
          withSpan({
            spanName: options?.prefix ? `${options.prefix}.${method}` : method,
            skipIfNoTelemetry: true,
            spanKind: options?.spanKind || SpanKind.INTERNAL,
            tracerName: options?.tracerName,
          })(target, method, descriptor),
        );
      }
    });

    return target;
  };
}
