import { randomUUID } from "node:crypto";

export interface ObjectiveTimeMetadata {
  epochId: string;
  espAnchorUs: number;
  backendAnchorMs: number;
  plotT0Ms: number;
}

interface EpochAnchor {
  epochId: string;
  espAnchorUs: number;
  backendAnchorMs: number;
}

export class ObjectiveTimeMapper {
  private readonly anchors = new Map<string, EpochAnchor>();

  map(
    sessionId: string,
    bootId: string,
    packetT0Us: number,
    receivedAtMs: number,
  ): ObjectiveTimeMetadata {
    const key = JSON.stringify([sessionId, bootId]);
    let anchor = this.anchors.get(key);

    if (anchor === undefined) {
      anchor = {
        epochId: randomUUID(),
        espAnchorUs: packetT0Us,
        backendAnchorMs: receivedAtMs,
      };
      this.anchors.set(key, anchor);
    }

    return {
      epochId: anchor.epochId,
      espAnchorUs: anchor.espAnchorUs,
      backendAnchorMs: anchor.backendAnchorMs,
      plotT0Ms: (packetT0Us - anchor.espAnchorUs) / 1_000,
    };
  }
}
