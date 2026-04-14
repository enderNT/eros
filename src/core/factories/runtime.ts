import type { AppSettings } from "../../config";
import type { KnowledgeProvider, LlmProvider, MemoryProvider, OutboundTransport } from "../../domain/ports";
import { ChatwootTransport } from "../../adapters/channels/chatwoot-transport";
import { NoopTransport } from "../../adapters/channels/noop-transport";
import { GenericLlmProvider } from "../services/generic-llm-provider";
import { InMemoryMemoryProvider } from "../services/in-memory-memory-provider";
import { Mem0MemoryProvider } from "../services/mem0-memory-provider";
import { NoopKnowledgeProvider } from "../services/noop-knowledge-provider";
import { OpenAiCompatibleLlmProvider } from "../services/openai-compatible-llm-provider";

export function createLlmProvider(settings: AppSettings): LlmProvider {
  const localProvider = new GenericLlmProvider();
  if (settings.llm.provider === "openai_compatible") {
    return new OpenAiCompatibleLlmProvider(settings.llm, localProvider);
  }
  return localProvider;
}

export function createMemoryProvider(settings: AppSettings): MemoryProvider {
  if (settings.memory.provider === "mem0") {
    return new Mem0MemoryProvider(settings.memory);
  }
  return new InMemoryMemoryProvider();
}

export function createKnowledgeProvider(): KnowledgeProvider {
  return new NoopKnowledgeProvider();
}

export function createOutboundTransport(settings: AppSettings): OutboundTransport {
  if (settings.channel.provider === "chatwoot" && settings.channel.replyEnabled) {
    return new ChatwootTransport(settings.channel);
  }
  return new NoopTransport();
}
