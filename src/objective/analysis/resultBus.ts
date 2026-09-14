import type { AnalysisResult } from "./types.js";

export type AnalysisResultSubscriber = (result: AnalysisResult) => void;

export class AnalysisResultBus {
  private readonly subscribers = new Set<AnalysisResultSubscriber>();

  subscribe(subscriber: AnalysisResultSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(result: AnalysisResult): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown subscriber error";
        console.error(`[objective-analysis] result subscriber failed message=${message}`);
      }
    }
  }
}
