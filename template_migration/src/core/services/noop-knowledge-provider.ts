import type { KnowledgeDocument } from "../../domain/contracts";
import type { KnowledgeProvider } from "../../domain/ports";

export class NoopKnowledgeProvider implements KnowledgeProvider {
  async retrieve(): Promise<KnowledgeDocument[]> {
    return [];
  }
}
