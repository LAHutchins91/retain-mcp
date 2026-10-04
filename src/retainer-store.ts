import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RECORD_GUIDANCE,
  REFUSED_DRAFT,
  REFUSED_EXCLUDED,
  REFUSED_OUTSIDE,
  RetainRefusal,
  RetainUserError,
  assertExclusionTitle,
  assertHoursWrite,
  assertIncludedTitle,
  assertNewExclusion,
  assertNewIncludedWork,
  assertOverageWrite,
  assertRenewalWrite,
  classifyWorkRequest,
  labelKey,
  type ChangeKind,
  type HoursPeriod,
  type OverageHandling,
  type RetainerStatus
} from "./retainer-policy.js";

export type { ChangeKind, HoursPeriod, OverageHandling, RetainerStatus };

const MAX_RETAINERS = 50;
const MAX_WORK = 200;
const MAX_CHANGES = 200;
const MAX_SUPPORT = 200;

export type WorkItem = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type IncludedHours = {
  hours: number;
  period: HoursPeriod;
  updatedAt: string;
};

export type OverageRule = {
  handling: OverageHandling;
  note: string;
  updatedAt: string;
};

export type RetainerChange = {
  id: string;
  kind: ChangeKind;
  status: "proposed" | "approved";
  summary: string;
  workTitle: string | null;
  workDescription: string | null;
  workId: string | null;
  includedHours: number | null;
  period: HoursPeriod | null;
  renewalOn: string | null;
  applied: boolean;
  createdAt: string;
  approvedAt: string | null;
};

export type Retainer = {
  id: string;
  clientName: string;
  title: string;
  summary: string;
  status: RetainerStatus;
  approvedAt: string | null;
  includedHours: IncludedHours | null;
  overage: OverageRule | null;
  includedWork: WorkItem[];
  excludedWork: WorkItem[];
  renewalOn: string | null;
  changes: RetainerChange[];
  createdAt: string;
  updatedAt: string;
};

export type RetainerSummary = {
  id: string;
  clientName: string;
  title: string;
  status: RetainerStatus;
  includedHours: number | null;
  period: HoursPeriod | null;
  renewalOn: string | null;
};

export type Profile = {
  userId: string;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type RetainerRecord = {
  retainer: {
    id: string;
    clientName: string;
    title: string;
    summary: string;
    status: RetainerStatus;
    approvedAt: string | null;
  };
  includedHours: IncludedHours | null;
  overage: OverageRule | null;
  includedWork: WorkItem[];
  excludedWork: WorkItem[];
  renewalOn: string | null;
  approvedChanges: RetainerChange[];
  proposedChanges: RetainerChange[];
  guidance: string;
};

export type OpenRetainerInput = {
  clientName: string;
  title: string;
  summary?: string;
};

export type SetIncludedHoursInput = {
  retainerId: string;
  hours: number;
  period: HoursPeriod;
};

export type SetOverageInput = {
  retainerId: string;
  handling: OverageHandling;
  note: string;
};

export type NoteWorkInput = {
  retainerId: string;
  workId?: string;
  title: string;
  description: string;
};

export type SetRenewalInput = {
  retainerId: string;
  renewalOn: string;
};

export type ProposeChangeInput = {
  retainerId: string;
  kind: ChangeKind;
  summary: string;
  workTitle?: string;
  workDescription?: string;
  workId?: string;
  includedHours?: number;
  period?: HoursPeriod;
  renewalOn?: string;
};

type SupportRequest = { id: string; email: string; message: string; createdAt: string };

type FileData = {
  version: 1;
  profiles: Record<string, Profile>;
  retainers: Record<string, Retainer[]>;
  supportRequests: SupportRequest[];
};

export type RetainStore = {
  getProfile(userId: string): Promise<Profile>;
  updateProfile(userId: string, patch: Partial<Omit<Profile, "userId">>): Promise<Profile>;
  listRetainers(userId: string, offset: number): Promise<{ retainers: RetainerSummary[]; nextOffset: number | null }>;
  openRetainer(userId: string, input: OpenRetainerInput): Promise<Retainer>;
  readRetainer(userId: string, retainerId: string): Promise<RetainerRecord>;
  setIncludedHours(userId: string, input: SetIncludedHoursInput): Promise<IncludedHours>;
  setOverageTerms(userId: string, input: SetOverageInput): Promise<OverageRule>;
  noteIncludedWork(userId: string, input: NoteWorkInput): Promise<WorkItem>;
  noteExcludedWork(userId: string, input: NoteWorkInput): Promise<WorkItem>;
  setRenewalDate(userId: string, input: SetRenewalInput): Promise<{ renewalOn: string }>;
  approveRetainer(userId: string, retainerId: string): Promise<RetainerRecord>;
  assessWorkRequest(userId: string, retainerId: string, title: string): Promise<{ decision: "inside"; title: string; includedWorkId: string }>;
  proposeRetainerChange(userId: string, input: ProposeChangeInput): Promise<RetainerChange>;
  approveRetainerChange(userId: string, retainerId: string, changeId: string): Promise<RetainerRecord>;
  addSupportRequest(input: { email: string; message: string }): Promise<{ id: string }>;
};

export function defaultRetainDataPath(): string {
  return path.join(os.homedir(), ".retain", "retain.json");
}

function emptyData(): FileData {
  return { version: 1, profiles: {}, retainers: {}, supportRequests: [] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) throw new RetainUserError(`${label} must be 1–${max} characters.`);
  return text;
}

function assertHours(hours: number): number {
  if (!Number.isInteger(hours) || hours < 1 || hours > 10000) {
    throw new RetainUserError("Included hours must be a whole number from 1 to 10000.");
  }
  return hours;
}

function assertPeriod(period: string): HoursPeriod {
  if (period !== "month" && period !== "quarter" && period !== "year") {
    throw new RetainUserError("Included hours period must be month, quarter, or year.");
  }
  return period;
}

function assertHandling(value: string): OverageHandling {
  if (value !== "bill" && value !== "stop" && value !== "waived") {
    throw new RetainUserError("Overage handling must be bill, stop, or waived.");
  }
  return value;
}

function assertDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RetainUserError("Renewal date must be a calendar date.");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new RetainUserError("Renewal date must be a calendar date.");
  }
  return value;
}

function blankProfile(userId: string): Profile {
  return {
    userId,
    subscriptionStatus: "none",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false
  };
}

function summary(retainer: Retainer): RetainerSummary {
  return {
    id: retainer.id,
    clientName: retainer.clientName,
    title: retainer.title,
    status: retainer.status,
    includedHours: retainer.includedHours?.hours ?? null,
    period: retainer.includedHours?.period ?? null,
    renewalOn: retainer.renewalOn
  };
}

function toRecord(retainer: Retainer): RetainerRecord {
  return {
    retainer: {
      id: retainer.id,
      clientName: retainer.clientName,
      title: retainer.title,
      summary: retainer.summary,
      status: retainer.status,
      approvedAt: retainer.approvedAt
    },
    includedHours: retainer.includedHours,
    overage: retainer.overage,
    includedWork: retainer.includedWork,
    excludedWork: retainer.excludedWork,
    renewalOn: retainer.renewalOn,
    approvedChanges: retainer.changes.filter((change) => change.status === "approved"),
    proposedChanges: retainer.changes.filter((change) => change.status === "proposed"),
    guidance: RECORD_GUIDANCE
  };
}

function retainersFor(data: FileData, userId: string): Retainer[] {
  const rows = data.retainers[userId];
  if (!rows) {
    data.retainers[userId] = [];
    return data.retainers[userId];
  }
  return rows;
}

function findRetainer(data: FileData, userId: string, retainerId: string): Retainer {
  const retainer = (data.retainers[userId] ?? []).find((row) => row.id === retainerId);
  if (!retainer) throw new RetainUserError("Retainer not found");
  return retainer;
}

function findWork(items: WorkItem[], workId: string, label: string): WorkItem {
  const item = items.find((row) => row.id === workId);
  if (!item) throw new RetainUserError(`${label} not found`);
  return item;
}

function titlesCollide(retainer: Retainer, title: string, ignoreId?: string): "included" | "excluded" | null {
  const key = labelKey(title);
  if (retainer.includedWork.some((item) => item.id !== ignoreId && labelKey(item.title) === key)) return "included";
  if (retainer.excludedWork.some((item) => item.id !== ignoreId && labelKey(item.title) === key)) return "excluded";
  return null;
}

function blankChange(kind: ChangeKind, summary: string): RetainerChange {
  const stamp = nowIso();
  return {
    id: randomUUID(),
    kind,
    status: "proposed",
    summary,
    workTitle: null,
    workDescription: null,
    workId: null,
    includedHours: null,
    period: null,
    renewalOn: null,
    applied: false,
    createdAt: stamp,
    approvedAt: null
  };
}

export function createFileRetainStore(filePath: string): RetainStore {
  let chain: Promise<void> = Promise.resolve();

  async function read(): Promise<FileData> {
    try {
      const text = await readFile(filePath, "utf8");
      if (!text.trim()) return emptyData();
      const parsed = JSON.parse(text) as FileData;
      if (parsed.version !== 1 || !parsed.profiles || !parsed.retainers || !Array.isArray(parsed.supportRequests)) {
        throw new RetainUserError("Retain data could not be read.");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      if (error instanceof RetainUserError) throw error;
      throw new RetainUserError("Retain data could not be read.");
    }
  }

  async function write(data: FileData): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, filePath);
  }

  function enqueue<T>(fn: (data: FileData) => T, persist: boolean): Promise<T> {
    const run = chain.then(async () => {
      const data = await read();
      const result = fn(data);
      if (persist) await write(data);
      return structuredClone(result);
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    getProfile(userId) {
      return enqueue((data) => data.profiles[userId] ?? blankProfile(userId), false);
    },
    updateProfile(userId, patch) {
      return enqueue((data) => {
        const current = data.profiles[userId] ?? blankProfile(userId);
        const next: Profile = { ...current, ...patch, userId };
        data.profiles[userId] = next;
        return next;
      }, true);
    },
    listRetainers(userId, offset) {
      return enqueue((data) => {
        const rows = data.retainers[userId] ?? [];
        const start = Math.max(0, offset);
        const page = rows.slice(start, start + MAX_RETAINERS).map(summary);
        const nextOffset = start + page.length < rows.length ? start + page.length : null;
        return { retainers: page, nextOffset };
      }, false);
    },
    openRetainer(userId, input) {
      return enqueue((data) => {
        const rows = retainersFor(data, userId);
        if (rows.length >= MAX_RETAINERS) throw new RetainUserError("Retainer limit reached.");
        const stamp = nowIso();
        const retainer: Retainer = {
          id: randomUUID(),
          clientName: cleanText(input.clientName, "Client name", 200),
          title: cleanText(input.title, "Title", 200),
          summary: input.summary?.trim() ? cleanText(input.summary, "Summary", 4000) : "",
          status: "draft",
          approvedAt: null,
          includedHours: null,
          overage: null,
          includedWork: [],
          excludedWork: [],
          renewalOn: null,
          changes: [],
          createdAt: stamp,
          updatedAt: stamp
        };
        rows.unshift(retainer);
        return retainer;
      }, true);
    },
    readRetainer(userId, retainerId) {
      return enqueue((data) => toRecord(findRetainer(data, userId, retainerId)), false);
    },
    setIncludedHours(userId, input) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, input.retainerId);
        const hours = assertHours(input.hours);
        const period = assertPeriod(input.period);
        assertHoursWrite(retainer.status, retainer.includedHours?.hours, retainer.includedHours?.period, hours, period);
        const stamp = nowIso();
        retainer.includedHours = { hours, period, updatedAt: stamp };
        retainer.updatedAt = stamp;
        return retainer.includedHours;
      }, true);
    },
    setOverageTerms(userId, input) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, input.retainerId);
        const handling = assertHandling(input.handling);
        const note = cleanText(input.note, "Overage note", 1000);
        assertOverageWrite(retainer.status, retainer.overage?.handling, handling);
        const stamp = nowIso();
        retainer.overage = { handling, note, updatedAt: stamp };
        retainer.updatedAt = stamp;
        return retainer.overage;
      }, true);
    },
    noteIncludedWork(userId, input) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, input.retainerId);
        const title = cleanText(input.title, "Title", 200);
        const description = cleanText(input.description, "Description", 12000);
        const stamp = nowIso();
        if (input.workId) {
          const item = findWork(retainer.includedWork, input.workId, "Included work");
          assertIncludedTitle(retainer.status, item.title, title);
          const collision = titlesCollide(retainer, title, item.id);
          if (collision) throw new RetainUserError("That title is already on the retainer.");
          item.title = title;
          item.description = description;
          item.updatedAt = stamp;
          retainer.updatedAt = stamp;
          return item;
        }
        assertNewIncludedWork(retainer.status);
        if (retainer.includedWork.length >= MAX_WORK) throw new RetainUserError("Included work limit reached.");
        const collision = titlesCollide(retainer, title);
        if (collision === "excluded") throw new RetainUserError("That work is already listed as out of the retainer.");
        if (collision === "included") throw new RetainUserError("That work is already included.");
        const item: WorkItem = { id: randomUUID(), title, description, createdAt: stamp, updatedAt: stamp };
        retainer.includedWork.push(item);
        retainer.updatedAt = stamp;
        return item;
      }, true);
    },
    noteExcludedWork(userId, input) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, input.retainerId);
        const title = cleanText(input.title, "Title", 200);
        const description = cleanText(input.description, "Description", 12000);
        const stamp = nowIso();
        if (input.workId) {
          const item = findWork(retainer.excludedWork, input.workId, "Excluded work");
          assertExclusionTitle(retainer.status, item.title, title);
          const collision = titlesCollide(retainer, title, item.id);
          if (collision) throw new RetainUserError("That title is already on the retainer.");
          item.title = title;
          item.description = description;
          item.updatedAt = stamp;
          retainer.updatedAt = stamp;
          return item;
        }
        assertNewExclusion(retainer.status);
        if (retainer.excludedWork.length >= MAX_WORK) throw new RetainUserError("Excluded work limit reached.");
        const collision = titlesCollide(retainer, title);
        if (collision === "included") throw new RetainUserError("That work is already included in the retainer.");
        if (collision === "excluded") throw new RetainUserError("That work is already listed as out.");
        const item: WorkItem = { id: randomUUID(), title, description, createdAt: stamp, updatedAt: stamp };
        retainer.excludedWork.push(item);
        retainer.updatedAt = stamp;
        return item;
      }, true);
    },
    setRenewalDate(userId, input) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, input.retainerId);
        const renewalOn = assertDate(input.renewalOn);
        assertRenewalWrite(retainer.status, retainer.renewalOn, renewalOn);
        retainer.renewalOn = renewalOn;
        retainer.updatedAt = nowIso();
        return { renewalOn };
      }, true);
    },
    approveRetainer(userId, retainerId) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, retainerId);
        if (retainer.status === "approved") return toRecord(retainer);
        if (retainer.includedWork.length === 0) {
          throw new RetainUserError("Included work is required before the retainer can be approved.");
        }
        if (!retainer.includedHours) {
          throw new RetainUserError("Included hours are required before the retainer can be approved.");
        }
        if (!retainer.overage) {
          throw new RetainUserError("An overage rule is required before the retainer can be approved.");
        }
        if (!retainer.renewalOn) {
          throw new RetainUserError("A renewal date is required before the retainer can be approved.");
        }
        const stamp = nowIso();
        retainer.status = "approved";
        retainer.approvedAt = stamp;
        retainer.updatedAt = stamp;
        return toRecord(retainer);
      }, true);
    },
    assessWorkRequest(userId, retainerId, title) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, retainerId);
        const cleaned = cleanText(title, "Work title", 200);
        const decision = classifyWorkRequest(
          retainer.status,
          retainer.includedWork.map((item) => item.title),
          retainer.excludedWork.map((item) => item.title),
          cleaned
        );
        if (decision === "excluded") throw new RetainRefusal(REFUSED_EXCLUDED);
        if (decision === "draft") throw new RetainRefusal(REFUSED_DRAFT);
        if (decision === "outside") throw new RetainRefusal(REFUSED_OUTSIDE);
        const match = retainer.includedWork.find((item) => labelKey(item.title) === labelKey(cleaned));
        if (!match) throw new RetainRefusal(REFUSED_OUTSIDE);
        return { decision: "inside" as const, title: match.title, includedWorkId: match.id };
      }, false);
    },
    proposeRetainerChange(userId, input) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, input.retainerId);
        if (retainer.status !== "approved") {
          throw new RetainUserError("Approve the retainer before proposing a change.");
        }
        if (retainer.changes.length >= MAX_CHANGES) throw new RetainUserError("Retainer change limit reached.");
        const summary = cleanText(input.summary, "Summary", 1000);
        const change = blankChange(input.kind, summary);
        if (input.kind === "add_included_work") {
          change.workTitle = cleanText(input.workTitle ?? "", "Work title", 200);
          change.workDescription = cleanText(input.workDescription ?? "", "Work description", 12000);
          const collision = titlesCollide(retainer, change.workTitle);
          if (collision === "included") throw new RetainUserError("That work is already included.");
          if (collision === "excluded") {
            throw new RetainUserError("That work is listed as out. Retire that exclusion in an approved change before including it.");
          }
        } else if (input.kind === "add_exclusion") {
          change.workTitle = cleanText(input.workTitle ?? "", "Work title", 200);
          change.workDescription = cleanText(input.workDescription ?? "", "Work description", 12000);
          const collision = titlesCollide(retainer, change.workTitle);
          if (collision === "excluded") throw new RetainUserError("That work is already listed as out.");
          if (collision === "included") throw new RetainUserError("That work is already included in the retainer.");
        } else if (input.kind === "retire_exclusion") {
          if (!input.workId) throw new RetainUserError("Excluded work not found");
          findWork(retainer.excludedWork, input.workId, "Excluded work");
          change.workId = input.workId;
        } else if (input.kind === "waive_overage") {
          if (!retainer.overage) throw new RetainUserError("An overage rule is required before overage can be waived.");
          if (retainer.overage.handling === "waived") throw new RetainUserError("Overage is already waived.");
        } else if (input.kind === "revise_hours") {
          if (!retainer.includedHours) throw new RetainUserError("Included hours are required before they can be revised.");
          change.includedHours = assertHours(input.includedHours ?? Number.NaN);
          change.period = input.period ? assertPeriod(input.period) : retainer.includedHours.period;
          if (change.includedHours === retainer.includedHours.hours && change.period === retainer.includedHours.period) {
            throw new RetainUserError("That change does not revise the included hours.");
          }
        } else if (input.kind === "move_renewal") {
          change.renewalOn = assertDate(input.renewalOn ?? "");
          if (change.renewalOn === retainer.renewalOn) {
            throw new RetainUserError("That change does not move the renewal date.");
          }
        } else {
          throw new RetainUserError("Unknown retainer change.");
        }
        retainer.changes.unshift(change);
        retainer.updatedAt = change.createdAt;
        return change;
      }, true);
    },
    approveRetainerChange(userId, retainerId, changeId) {
      return enqueue((data) => {
        const retainer = findRetainer(data, userId, retainerId);
        const change = retainer.changes.find((row) => row.id === changeId);
        if (!change) throw new RetainUserError("Retainer change not found");
        if (change.applied) return toRecord(retainer);
        if (retainer.status !== "approved") throw new RetainUserError("Approve the retainer before proposing a change.");
        const stamp = nowIso();
        if (change.kind === "add_included_work") {
          if (!change.workTitle || !change.workDescription) throw new RetainUserError("That work is already included.");
          const collision = titlesCollide(retainer, change.workTitle);
          if (collision === "included") throw new RetainUserError("That work is already included.");
          if (collision === "excluded") {
            throw new RetainUserError("That work is listed as out. Retire that exclusion in an approved change before including it.");
          }
          if (retainer.includedWork.length >= MAX_WORK) throw new RetainUserError("Included work limit reached.");
          retainer.includedWork.push({
            id: randomUUID(),
            title: change.workTitle,
            description: change.workDescription,
            createdAt: stamp,
            updatedAt: stamp
          });
        } else if (change.kind === "add_exclusion") {
          if (!change.workTitle || !change.workDescription) throw new RetainUserError("That work is already listed as out.");
          const collision = titlesCollide(retainer, change.workTitle);
          if (collision) throw new RetainUserError("That title is already on the retainer.");
          if (retainer.excludedWork.length >= MAX_WORK) throw new RetainUserError("Excluded work limit reached.");
          retainer.excludedWork.push({
            id: randomUUID(),
            title: change.workTitle,
            description: change.workDescription,
            createdAt: stamp,
            updatedAt: stamp
          });
        } else if (change.kind === "retire_exclusion") {
          if (!change.workId) throw new RetainUserError("Excluded work not found");
          const index = retainer.excludedWork.findIndex((item) => item.id === change.workId);
          if (index < 0) throw new RetainUserError("Excluded work not found");
          retainer.excludedWork.splice(index, 1);
        } else if (change.kind === "waive_overage") {
          if (!retainer.overage) throw new RetainUserError("An overage rule is required before overage can be waived.");
          if (retainer.overage.handling === "waived") throw new RetainUserError("Overage is already waived.");
          retainer.overage = { ...retainer.overage, handling: "waived", updatedAt: stamp };
        } else if (change.kind === "revise_hours") {
          if (!retainer.includedHours || change.includedHours === null || !change.period) {
            throw new RetainUserError("Included hours are required before they can be revised.");
          }
          retainer.includedHours = { hours: change.includedHours, period: change.period, updatedAt: stamp };
        } else if (change.kind === "move_renewal") {
          if (!change.renewalOn) throw new RetainUserError("Renewal date must be a calendar date.");
          retainer.renewalOn = change.renewalOn;
        }
        change.status = "approved";
        change.applied = true;
        change.approvedAt = stamp;
        retainer.updatedAt = stamp;
        return toRecord(retainer);
      }, true);
    },
    addSupportRequest(input) {
      return enqueue((data) => {
        const request: SupportRequest = {
          id: randomUUID(),
          email: input.email,
          message: input.message,
          createdAt: nowIso()
        };
        data.supportRequests.push(request);
        if (data.supportRequests.length > MAX_SUPPORT) data.supportRequests.splice(0, data.supportRequests.length - MAX_SUPPORT);
        return { id: request.id };
      }, true);
    }
  };
}

export function isRetainRefusal(error: unknown): error is RetainRefusal {
  return error instanceof RetainRefusal;
}
