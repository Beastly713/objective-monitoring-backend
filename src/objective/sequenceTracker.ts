export type SequenceStatus = "first" | "normal" | "gap" | "duplicate_stale";

export interface SequenceClassification {
  status: SequenceStatus;
  gapBefore: number;
  shouldPublish: boolean;
}

export class SequenceTracker {
  private readonly latestSequences = new Map<string, number>();

  classify(sessionId: string, bootId: string, sequence: number): SequenceClassification {
    const key = JSON.stringify([sessionId, bootId]);
    const previousSequence = this.latestSequences.get(key);

    if (previousSequence === undefined) {
      this.latestSequences.set(key, sequence);
      return { status: "first", gapBefore: 0, shouldPublish: true };
    }

    if (sequence <= previousSequence) {
      return { status: "duplicate_stale", gapBefore: 0, shouldPublish: false };
    }

    this.latestSequences.set(key, sequence);
    if (sequence === previousSequence + 1) {
      return { status: "normal", gapBefore: 0, shouldPublish: true };
    }

    return {
      status: "gap",
      gapBefore: sequence - previousSequence - 1,
      shouldPublish: true,
    };
  }
}
