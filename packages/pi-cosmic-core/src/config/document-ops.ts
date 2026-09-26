export type ConfigDocumentErrorFactory<E> = (operation: string, path: string) => () => E;

/** Standard "Unable to <operation> <label> configuration." factory for package config errors. */
export const makeConfigDocumentErrorFactory =
  <E>(
    Ctor: new (props: {
      readonly operation: string;
      readonly path: string;
      readonly message: string;
    }) => E,
    label: string,
  ): ConfigDocumentErrorFactory<E> =>
  (operation, path) =>
  () =>
    new Ctor({ operation, path, message: `Unable to ${operation} ${label} configuration.` });
