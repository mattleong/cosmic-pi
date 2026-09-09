/** One predeclared candidate. Never tune this against held-out results. */
export const candidateSelectionGuidelines = [
  "Choose code_mode before starting work that needs two or more independent reads/searches, " +
    "a search followed by inspecting its matches, or counting, comparing, joining, or filtering " +
    "tool results. Keep that sequence in one small program rather than carrying intermediate " +
    "results through model turns. Use a direct tool for one simple operation.",
  "Parallelize independent operations with Promise.all. Keep dependencies sequential. " +
    "Return the requested findings with enough evidence to verify them, not whole intermediate " +
    "results. Stop the program before any decision requiring user approval or model judgment.",
];
