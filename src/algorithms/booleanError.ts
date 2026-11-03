/** Thrown when a boolean operation can't produce a valid solid, rather than returning a wrong one. */
export class BooleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BooleanError';
  }
}
