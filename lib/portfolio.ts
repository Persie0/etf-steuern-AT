export type HoldingRecord = {
  identifier: string;
  taxYear: string;
  savedAt: string;
  ownershipStatus: "held" | "sold";
};

export function selectLatestHeldPositions<T extends HoldingRecord>(entries: T[]): T[] {
  const latestByIdentifier = new Map<string, T>();
  for (const entry of entries) {
    const existing = latestByIdentifier.get(entry.identifier);
    if (!existing || entry.taxYear > existing.taxYear || (entry.taxYear === existing.taxYear && entry.savedAt > existing.savedAt)) {
      latestByIdentifier.set(entry.identifier, entry);
    }
  }
  return [...latestByIdentifier.values()].filter((entry) => entry.ownershipStatus === "held");
}
