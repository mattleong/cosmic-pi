export type ConfigDocumentErrorFactory<E> = (operation: string, path: string) => () => E;

export interface ConfigDocumentErrorClass<E> {
  readonly make: (props: {
    readonly operation: string;
    readonly path: string;
    readonly message: string;
  }) => E;
}

export const configDocumentErrorFactory =
  <E>(Ctor: ConfigDocumentErrorClass<E>, label: string): ConfigDocumentErrorFactory<E> =>
  (operation, path) =>
  () =>
    Ctor.make({ operation, path, message: `Unable to ${operation} ${label} configuration.` });
