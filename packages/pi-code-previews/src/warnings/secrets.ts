const SECRET_WARNINGS = {
  "private key": /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  "AWS secret key": /\bAWS_SECRET_ACCESS_KEY\s*=\s*["']?[^\s'"]{12,}/i,
  "API key":
    /\b(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|MISTRAL|GROQ|TOGETHER|PERPLEXITY|XAI)_API_KEY\s*=\s*["']?[^\s'"]{12,}/i,
  "GitHub token": /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  JWT: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
};

/** Secret categories in `text`, scanning only its head and tail when longer than `limit`. */
export function getSecretWarnings(text: string, limit = Infinity): string[] {
  const sample = secretScanSample(text, limit);
  return Object.entries(SECRET_WARNINGS)
    .filter(([, pattern]) => pattern.test(sample))
    .map(([label]) => label);
}

function secretScanSample(source: string, limit: number): string {
  if (source.length <= limit) return source;
  const half = Math.floor(limit / 2);
  // slice(-0) would scan the entire source when the configured budget is one.
  if (half === 0) return source.slice(0, limit);
  return `${source.slice(0, half)}\n${source.slice(-half)}`;
}
