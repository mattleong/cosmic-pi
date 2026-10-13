import { Schema } from "effect";

export function isPackageVersion(version: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      version,
    );
  if (match === null || match[0] !== version) return false;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  return (
    prerelease.every((identifier) => identifier.length > 0 && !/^0\d+$/.test(identifier)) &&
    build.every((identifier) => identifier.length > 0)
  );
}

const DependencyVersions = Schema.Record(Schema.String, Schema.String);

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optional(Schema.Boolean),
  dependencies: Schema.optional(DependencyVersions),
  peerDependencies: Schema.optional(DependencyVersions),
  optionalDependencies: Schema.optional(DependencyVersions),
  exports: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  pi: Schema.optional(Schema.Struct({ extensions: Schema.optional(Schema.Array(Schema.String)) })),
});

export type PackageManifest = typeof PackageManifest.Type;

const ManifestDocument = Schema.Record(Schema.String, Schema.Json);

export type ManifestDocument = typeof ManifestDocument.Type;

const packageManifestFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));
const manifestDocumentFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(ManifestDocument));

export function decodePackageManifest(text: string): PackageManifest {
  return packageManifestFromJson(text);
}

export function decodeManifestDocument(text: string): ManifestDocument {
  return manifestDocumentFromJson(text);
}
