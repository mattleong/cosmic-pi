/** Source-only, test-runner-independent registered-tool presentation helpers. */
export {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  drawToolRow,
  hostToolRow,
  probeAnimationOwnership,
  toolRowFrames,
  renderContextFixture,
  withPresentationSettings,
  type ToolPresentationHarness,
} from "./src/testing/tool-presentation";
export { issueMessageStyleProblems } from "./src/testing/issue-messages";
export { galleryDirectory, writeGallerySection } from "pi-cosmic-core/testing";
export {
  galleryFrames,
  galleryMessageFrames,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "./src/testing/gallery";
