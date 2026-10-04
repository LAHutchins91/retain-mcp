export class RetainRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetainRefusal";
  }
}

export class RetainUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetainUserError";
  }
}

export type OverageHandling = "bill" | "stop" | "waived";

export type HoursPeriod = "month" | "quarter" | "year";

export type RetainerStatus = "draft" | "approved";

export type ChangeKind =
  | "add_included_work"
  | "add_exclusion"
  | "retire_exclusion"
  | "waive_overage"
  | "revise_hours"
  | "move_renewal";

export const REFUSED_OUTSIDE =
  "Refused: that work is outside the approved retainer. Propose an add_included_work change and approve it before treating the work as included.";

export const REFUSED_EXCLUDED =
  "Refused: that work is out of the retainer. Propose a retire_exclusion change and approve it before including it.";

export const REFUSED_WAIVE =
  "Refused: waiving overage is not allowed after the retainer is approved. Propose a waive_overage change and approve that change. set_overage_terms will not waive overage.";

export const REFUSED_OVERAGE_CHANGE =
  "Refused: the approved overage rule stays as it was approved. set_overage_terms will not replace it.";

export const REFUSED_HOURS =
  "Refused: included hours stay as approved. Propose a revise_hours change and approve it.";

export const REFUSED_RENEWAL =
  "Refused: the renewal date stays as approved. Propose a move_renewal change and approve it.";

export const REFUSED_RENAME =
  "Refused: renaming included work would change the retainer. Propose an add_included_work change for new work instead.";

export const REFUSED_NEW_EXCLUSION =
  "Refused: exclusions are locked after approval. Propose an add_exclusion change and approve it.";

export const REFUSED_EXCLUSION_RENAME =
  "Refused: renaming excluded work would change what is out. Propose a retainer change instead.";

export const REFUSED_DRAFT =
  "Refused: this retainer is still a draft, so it is not an approved commitment.";

export const RECORD_GUIDANCE =
  "Answer only from this retainer. Draft status means the terms are not an approved commitment. Proposed retainer changes are not authorization. Do not promise work that is not included. Do not waive overage. Work listed as out stays out. set_overage_terms and note_included_work refuse a waiver and new work after approval.";

export function labelKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function assertOverageWrite(
  status: RetainerStatus,
  current: OverageHandling | undefined,
  next: OverageHandling
): void {
  if (status !== "approved" || current === next) return;
  if (next === "waived") throw new RetainRefusal(REFUSED_WAIVE);
  throw new RetainRefusal(REFUSED_OVERAGE_CHANGE);
}

export function assertNewIncludedWork(status: RetainerStatus): void {
  if (status === "approved") throw new RetainRefusal(REFUSED_OUTSIDE);
}

export function assertIncludedTitle(status: RetainerStatus, currentTitle: string, nextTitle: string): void {
  if (status === "approved" && currentTitle !== nextTitle) throw new RetainRefusal(REFUSED_RENAME);
}

export function assertNewExclusion(status: RetainerStatus): void {
  if (status === "approved") throw new RetainRefusal(REFUSED_NEW_EXCLUSION);
}

export function assertExclusionTitle(status: RetainerStatus, currentTitle: string, nextTitle: string): void {
  if (status === "approved" && currentTitle !== nextTitle) throw new RetainRefusal(REFUSED_EXCLUSION_RENAME);
}

export function assertHoursWrite(
  status: RetainerStatus,
  currentHours: number | undefined,
  currentPeriod: HoursPeriod | undefined,
  nextHours: number,
  nextPeriod: HoursPeriod
): void {
  if (status !== "approved") return;
  if (currentHours === nextHours && currentPeriod === nextPeriod) return;
  throw new RetainRefusal(REFUSED_HOURS);
}

export function assertRenewalWrite(status: RetainerStatus, current: string | null, next: string): void {
  if (status === "approved" && current !== next) throw new RetainRefusal(REFUSED_RENEWAL);
}

export function classifyWorkRequest(
  status: RetainerStatus,
  includedTitles: string[],
  excludedTitles: string[],
  requestTitle: string
): "inside" | "excluded" | "outside" | "draft" {
  const key = labelKey(requestTitle);
  if (excludedTitles.some((title) => labelKey(title) === key)) return "excluded";
  if (status !== "approved") return "draft";
  if (includedTitles.some((title) => labelKey(title) === key)) return "inside";
  return "outside";
}
