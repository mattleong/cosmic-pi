import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";

const SECRET_WARNINGS = {
  "private key": /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  "AWS secret key": /\bAWS_SECRET_ACCESS_KEY\s*=\s*["']?[^\s'"]{12,}/i,
  "API key":
    /\b(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|MISTRAL|GROQ|TOGETHER|PERPLEXITY|XAI)_API_KEY\s*=\s*["']?[^\s'"]{12,}/i,
  "GitHub token": /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  JWT: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
};

export function getSecretWarnings(text: string, limit = Infinity): string[] {
  const sample = secretScanSample(text, limit);
  return Arr.map(
    Arr.filter(Rec.toEntries(SECRET_WARNINGS), ([, pattern]) => pattern.test(sample)),
    ([label]) => label,
  );
}

function secretScanSample(source: string, limit: number): string {
  if (source.length <= limit) return source;
  const half = Math.floor(limit / 2);
  if (half === 0) return Fn.pipe(source, Str.slice(0, limit));
  return `${Fn.pipe(source, Str.slice(0, half))}\n${Fn.pipe(source, Str.slice(-half))}`;
}
