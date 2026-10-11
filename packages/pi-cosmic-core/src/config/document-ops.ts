export type ConfigDocumentErrorFactory<E> = (operation: string, path: string) => () => E;

export type ConfigDocumentErrorClass<E> = new (props: {
  readonly operation: string;
  readonly path: string;
  readonly message: string;
}) => E;

export const makeConfigDocumentErrorFactory =
  <E>(Ctor: ConfigDocumentErrorClass<E>, label: string): ConfigDocumentErrorFactory<E> =>
  (operation, path) =>
  () =>
    new Ctor({ operation, path, message: `Unable to ${operation} ${label} configuration.` });
