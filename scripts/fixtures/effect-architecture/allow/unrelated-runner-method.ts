declare const service: { runPromise(value: unknown): void };

service.runPromise("not an Effect runner");
