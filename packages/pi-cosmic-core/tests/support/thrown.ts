/** The typed error `run` throws; any other outcome fails the test. */
export const thrownInstance = <E>(
  Ctor: abstract new (...args: never[]) => E,
  run: () => void,
): E => {
  try {
    run();
  } catch (error) {
    if (error instanceof Ctor) return error;
    throw error;
  }
  throw new Error(`expected ${Ctor.name} to be thrown`);
};
