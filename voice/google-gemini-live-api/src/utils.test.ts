import { createTool } from '@mastra/core/tools';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { transformTools, cleanSchemaForGemini } from './utils';

describe('transformTools', () => {
  describe('Basic Tool Transformation', () => {
    it('should transform a tool with Zod inputSchema to Gemini format', () => {
      // Create a test tool with Zod schema
      const tool = createTool({
        id: 'zodTool',
        description: 'A tool with Zod schema',
        inputSchema: z.object({
          name: z.string(),
          age: z.number().optional(),
        }),
        outputSchema: z.string(),
        execute: async ({ context }) => {
          return `Hello, ${context.name}`;
        },
      });

      // Transform the tool
      const transformedTools = transformTools({
        zodTool: tool,
      });

      // Assert the transformation results
      expect(transformedTools).toHaveLength(1);
      const { geminiTool } = transformedTools[0];

      expect(geminiTool).toMatchObject({
        name: 'zodTool',
        description: 'A tool with Zod schema',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            name: expect.objectContaining({ type: 'string' }),
            age: expect.objectContaining({ type: 'number' }),
          }),
          required: ['name'],
        }),
      });

      // Ensure no unsupported properties are present
      expect(geminiTool.parameters).not.toHaveProperty('$schema');
      expect(geminiTool.parameters).not.toHaveProperty('additionalProperties');
    });

    it('should transform a tool with JSON schema parameters to Gemini format', () => {
      // Create a test tool with direct JSON schema
      const tool = {
        id: 'jsonTool',
        description: 'A tool with JSON schema',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['query'],
          additionalProperties: false, // This should be removed
        },
        execute: async (args: { query: string; limit?: number }, options?: any) => {
          return `Searched for: ${args.query}`;
        },
      };

      // Transform the tool
      const transformedTools = transformTools({
        jsonTool: tool,
      });

      // Assert the transformation results
      expect(transformedTools).toHaveLength(1);
      const { geminiTool } = transformedTools[0];

      expect(geminiTool).toMatchObject({
        name: 'jsonTool',
        description: 'A tool with JSON schema',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            query: expect.objectContaining({ type: 'string' }),
            limit: expect.objectContaining({ type: 'integer' }),
          }),
          required: ['query'],
        }),
      });

      // Ensure additionalProperties was removed
      expect(geminiTool.parameters).not.toHaveProperty('additionalProperties');
    });

    it('should handle tools without inputSchema (optional parameter)', () => {
      // Create a tool without inputSchema
      const tool = createTool({
        id: 'noSchemaTool',
        description: 'A tool without input schema',
        execute: async ({ context }) => {
          return 'No input needed';
        },
      });

      // Transform the tool
      const transformedTools = transformTools({
        noSchemaTool: tool,
      });

      // Assert the transformation results
      expect(transformedTools).toHaveLength(1);
      const { geminiTool } = transformedTools[0];

      expect(geminiTool).toMatchObject({
        name: 'noSchemaTool',
        description: 'A tool without input schema',
        parameters: {
          type: 'object',
          properties: {},
        },
      });
    });

    it('should skip tools without execute function', () => {
      const tools = {
        invalidTool: {
          id: 'invalidTool',
          description: 'A tool without execute',
          // No execute function
        },
      };

      const transformedTools = transformTools(tools);
      expect(transformedTools).toHaveLength(0);
    });
  });

  describe('Tool Execution Tests', () => {
    it('should create an adapter function for Mastra tool execution', async () => {
      // Create a tool that expects context
      const tool = createTool({
        id: 'messageTool',
        description: 'A tool that processes a message',
        inputSchema: z.object({
          message: z.string(),
        }),
        outputSchema: z.string(),
        execute: async ({ context }) => {
          return `Processed: ${context.message}`;
        },
      });

      // Transform the tool
      const transformedTools = transformTools({
        messageTool: tool,
      });

      // Execute the transformed tool
      const result = await transformedTools[0].execute({ message: 'Hello' });

      // Verify the adapter correctly passes the context
      expect(result).toBe('Processed: Hello');
    });

    it('should handle legacy tools with parameters property', async () => {
      // Create a legacy tool
      const tool = {
        description: 'A legacy tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
        execute: async (args: any, options?: any) => {
          return `Legacy result: ${args.input}`;
        },
      };

      // Transform the tool
      const transformedTools = transformTools({
        legacyTool: tool,
      });

      // Execute the transformed tool
      const result = await transformedTools[0].execute({ input: 'test' });

      // Verify the adapter correctly handles legacy format
      expect(result).toBe('Legacy result: test');
    });
  });
});

describe('cleanSchemaForGemini', () => {
  it('should remove unsupported JSON Schema properties', () => {
    const dirtySchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
      additionalProperties: false,
      definitions: {
        someDefinition: { type: 'string' },
      },
      $id: 'http://example.com/schema',
      examples: [{ name: 'John', age: 30 }],
      default: { name: 'Anonymous' },
    };

    const cleanedSchema = cleanSchemaForGemini(dirtySchema);

    expect(cleanedSchema).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    });

    // Ensure unsupported properties are removed
    expect(cleanedSchema).not.toHaveProperty('$schema');
    expect(cleanedSchema).not.toHaveProperty('additionalProperties');
    expect(cleanedSchema).not.toHaveProperty('definitions');
    expect(cleanedSchema).not.toHaveProperty('$id');
    expect(cleanedSchema).not.toHaveProperty('examples');
    expect(cleanedSchema).not.toHaveProperty('default');
  });

  it('should recursively clean nested properties', () => {
    const nestedSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            settings: {
              type: 'object',
              properties: {
                theme: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    };

    const cleanedSchema = cleanSchemaForGemini(nestedSchema);

    expect(cleanedSchema.properties.user).not.toHaveProperty('additionalProperties');
    expect(cleanedSchema.properties.user.properties.settings).not.toHaveProperty('additionalProperties');
    expect(cleanedSchema).not.toHaveProperty('additionalProperties');
  });

  it('should handle primitive values and null', () => {
    expect(cleanSchemaForGemini(null)).toBe(null);
    expect(cleanSchemaForGemini(undefined)).toBe(undefined);
    expect(cleanSchemaForGemini('string')).toBe('string');
    expect(cleanSchemaForGemini(123)).toBe(123);
  });
});
