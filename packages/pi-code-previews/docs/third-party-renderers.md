# Third-party renderer adapters

`src/third-party/` is the only owner of explicitly supported external-extension presentation.
`registry.ts` is a static adapter list, not a plugin loader. The existing factory-time resolver
asks this registry for eligible presentation; builtin/native admission stays separate.

To add an adapter:

1. Put source/name admission, bounded Effect Schema evidence projection, and renderer composition
   in its own subdirectory. Register its names/admission/factory in `registry.ts`.
2. Admit only a unique current tool with verified public `SourceInfo`. Names alone, missing history,
   or similarly named files/packages are not ownership evidence. Decline unsupported installations.
3. Return only public renderer callbacks. Never import the provider, inspect execution definitions,
   register tools, change activation/permissions, read provider settings, or fetch stored artifacts.
4. Use the supplied originating appearance/scheduler and `withCodePreviewRenderers`. Preserve opaque
   downstream components/caches/interactions, exact arguments, all raw output/recovery, and images.
   Both original expanded callbacks and content-only callbacks must retain raw evidence: unknown
   summaries use the original slots. Contain construction/drawing failures without replay loops.
5. Test through actual callbacks/resolver and `pi-code-previews/testing`; add gallery scenarios and
   update the package architecture and public compatibility notes. Never infer domain success from
   delivery, counts, or a false Pi error flag.

To remove support, delete the adapter's registry entry, directory, tests, and documentation/gallery
scenarios. No builtin settings or execution wiring needs migration.

## pi-web-access compatibility

The initial adapter covers `web_enable`, `web_search`, `source_check`, `fetch_content`, and
`get_search_content`, based on 0.36.0's public arguments/results. It accepts `npm:pi-web-access`
(including version/tag selectors), `origin: package`, and the exact public package-root-relative
`dist/index.js` or `index.ts` entry. Windows path separators are supported. Arbitrary local/git
installs, configured renamed tools, unfamiliar metadata, and duplicate names fall through.
Unknown/malformed result evidence keeps generic presentation and full downstream/raw expansion.
Recovery references are displayed as evidence, not a guarantee that stored content is available.
No external dependency or user-configuration change is required.
