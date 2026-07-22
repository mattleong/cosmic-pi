import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export class NoDiscoveryAdvisorResourceLoader implements ResourceLoader {
  private readonly extensionRuntime = createExtensionRuntime();
  private readonly systemPrompt: string;
  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }
  getExtensions(): LoadExtensionsResult {
    return { extensions: [], errors: [], runtime: this.extensionRuntime };
  }
  getSkills() {
    return { skills: [], diagnostics: [] };
  }
  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }
  getThemes() {
    return { themes: [], diagnostics: [] };
  }
  getAgentsFiles() {
    return { agentsFiles: [] };
  }
  getSystemPrompt() {
    return this.systemPrompt;
  }
  getAppendSystemPrompt(): string[] {
    return [];
  }
  extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {}
  reload(): Promise<void> {
    return Promise.resolve();
  }
}
