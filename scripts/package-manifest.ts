import { Schema } from "effect";

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
