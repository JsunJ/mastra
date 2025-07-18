import type { IMastraLogger } from './logger';
import { RegisteredLogger } from './logger/constants';
import { ConsoleLogger } from './logger/default-logger';

import type { Telemetry } from './telemetry';

export class MastraBase {
  component: RegisteredLogger = RegisteredLogger.LLM;
  protected logger: IMastraLogger;
  name?: string;
  telemetry?: Telemetry;
  protected idGenerator?: () => string;

  constructor({ component, name }: { component?: RegisteredLogger; name?: string }) {
    this.component = component || RegisteredLogger.LLM;
    this.name = name;
    this.logger = new ConsoleLogger({ name: `${this.component} - ${this.name}` });
  }

  /**
   * Set the logger for the agent
   * @param logger
   */
  __setLogger(logger: IMastraLogger) {
    this.logger = logger;

    if (this.component !== RegisteredLogger.LLM) {
      this.logger.debug(`Logger updated [component=${this.component}] [name=${this.name}]`);
    }
  }

  /**
   * Set the telemetry for the
   * @param telemetry
   */
  __setTelemetry(telemetry: Telemetry) {
    this.telemetry = telemetry;

    if (this.component !== RegisteredLogger.LLM) {
      this.logger.debug(`Telemetry updated [component=${this.component}] [name=${this.telemetry.name}]`);
    }
  }

  /**
   * Set the ID generator function
   * @param idGenerator Function that returns a unique string ID
   */
  __setIdGenerator(idGenerator: () => string) {
    this.idGenerator = idGenerator;

    if (this.component !== RegisteredLogger.LLM) {
      this.logger.debug(`ID generator updated [component=${this.component}] [name=${this.name}]`);
    }
  }

  /**
   * Generate a unique identifier using the configured generator or default to crypto.randomUUID()
   * @returns A unique string ID
   */
  generateId(): string {
    if (this.idGenerator) {
      return this.idGenerator();
    }
    return crypto.randomUUID();
  }

  /**
   * Get the telemetry on the vector
   * @returns telemetry
   */
  __getTelemetry() {
    return this.telemetry;
  }

  /* 
    get experimental_telemetry config
    */
  get experimental_telemetry() {
    return this.telemetry
      ? {
          // tracer: this.telemetry.tracer,
          tracer: this.telemetry.getBaggageTracer(),
          isEnabled: !!this.telemetry.tracer,
        }
      : undefined;
  }
}
