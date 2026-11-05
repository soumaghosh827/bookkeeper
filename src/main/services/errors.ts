export class FieldError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

