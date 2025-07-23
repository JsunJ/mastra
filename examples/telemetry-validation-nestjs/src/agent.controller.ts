import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { Readable } from 'stream';
import { mastra } from './mastra.config';

@Controller('agent')
export class AgentController {
  @Get('ask')
  public async askStreamed(@Query('q') q: string) {
    console.log('🔄 Starting streaming request for:', q);

    const stream = await mastra.getAgent('myAgent').stream([
      {
        role: 'user',
        content: q,
      },
    ]);

    console.log('✅ Stream created, converting to readable stream');
    const readable = Readable.from(stream.textStream);
    return new StreamableFile(readable);
  }

  @Get('ask-blocked')
  public async askBlocked(@Query('q') q: string) {
    console.log('🔄 Starting generate request for:', q);

    const result = await mastra.getAgent('myAgent').generate([
      {
        role: 'user',
        content: q,
      },
    ]);

    console.log('✅ Generate completed');
    return result.text;
  }

  // Additional endpoint to help with telemetry debugging
  @Get('debug-stream')
  public async debugStream(@Query('q') q: string = '你是谁？') {
    console.log('🔍 DEBUG: Starting stream with telemetry logging');

    const stream = await mastra.getAgent('myAgent').stream(
      [
        {
          role: 'user',
          content: q,
        },
      ],
      {
        onFinish: (result: any) => {
          console.log('🎉 DEBUG: onFinish called with resolved data:', {
            text: result.text?.substring(0, 50) + '...',
            usage: result.usage,
            finishReason: result.finishReason,
            toolCalls: result.toolCalls?.length,
            warnings: result.warnings?.length,
          });
        },
      },
    );

    // Convert stream to string for easier debugging
    let fullText = '';
    for await (const chunk of stream.textStream) {
      fullText += chunk;
    }

    console.log('✅ DEBUG: Stream completed, final text length:', fullText.length);
    return {
      text: fullText,
      message: 'Check console for telemetry debug info and Laminar dashboard for traces',
    };
  }

  @Get('health')
  public health() {
    return {
      status: 'ok',
      telemetry: {
        endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'Not configured',
        serviceName: 'telemetry-validation-nestjs',
      },
    };
  }
}
