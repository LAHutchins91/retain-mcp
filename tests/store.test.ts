import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REFUSED_EXCLUDED, REFUSED_HOURS, REFUSED_OUTSIDE, REFUSED_RENEWAL, REFUSED_WAIVE } from "../src/retainer-policy.js";
import { createFileRetainStore } from "../src/retainer-store.js";

async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "retain-"));
  return createFileRetainStore(path.join(dir, "retain.json"));
}

async function approved() {
  const saved = await store();
  const retainer = await saved.openRetainer("user-1", { clientName: "Northwind", title: "Design retainer" });
  await saved.setIncludedHours("user-1", { retainerId: retainer.id, hours: 20, period: "month" });
  await saved.setOverageTerms("user-1", {
    retainerId: retainer.id,
    handling: "bill",
    note: "Hours past the included amount follow the agreed overage basis."
  });
  const included = await saved.noteIncludedWork("user-1", {
    retainerId: retainer.id,
    title: "Homepage updates",
    description: "Revisions to the existing homepage."
  });
  const excluded = await saved.noteExcludedWork("user-1", {
    retainerId: retainer.id,
    title: "New product pages",
    description: "Pages for products that are not live yet."
  });
  await saved.setRenewalDate("user-1", { retainerId: retainer.id, renewalOn: "2027-01-01" });
  await saved.approveRetainer("user-1", retainer.id);
  return { saved, retainerId: retainer.id, includedId: included.id, excludedId: excluded.id };
}

describe("retainer store", () => {
  it("refuses work outside the retainer and refuses waiving overage after approval", async () => {
    const { saved, retainerId, includedId, excludedId } = await approved();

    await expect(saved.noteIncludedWork("user-1", {
      retainerId,
      title: "Brand campaign",
      description: "A campaign that was never in the retainer."
    })).rejects.toThrow(REFUSED_OUTSIDE);

    await expect(saved.assessWorkRequest("user-1", retainerId, "Brand campaign")).rejects.toThrow(REFUSED_OUTSIDE);
    await expect(saved.assessWorkRequest("user-1", retainerId, "New product pages")).rejects.toThrow(REFUSED_EXCLUDED);
    const inside = await saved.assessWorkRequest("user-1", retainerId, "Homepage updates");
    expect(inside).toMatchObject({ decision: "inside", includedWorkId: includedId });

    await expect(saved.setOverageTerms("user-1", {
      retainerId,
      handling: "waived",
      note: "Please ignore hours past the included amount."
    })).rejects.toThrow(REFUSED_WAIVE);

    await expect(saved.setIncludedHours("user-1", {
      retainerId,
      hours: 40,
      period: "month"
    })).rejects.toThrow(REFUSED_HOURS);

    await expect(saved.setRenewalDate("user-1", {
      retainerId,
      renewalOn: "2027-06-01"
    })).rejects.toThrow(REFUSED_RENEWAL);

    const clarified = await saved.noteIncludedWork("user-1", {
      retainerId,
      workId: includedId,
      title: "Homepage updates",
      description: "Revisions to the existing homepage, including the contact block."
    });
    expect(clarified.description).toContain("contact block");

    const proposed = await saved.proposeRetainerChange("user-1", {
      retainerId,
      kind: "waive_overage",
      summary: "Client asked to pause overage for this cycle."
    });
    expect(proposed.status).toBe("proposed");
    expect(proposed.applied).toBe(false);
    const before = await saved.readRetainer("user-1", retainerId);
    expect(before.overage?.handling).toBe("bill");
    expect(before.proposedChanges).toHaveLength(1);
    expect(before.approvedChanges).toHaveLength(0);

    const waived = await saved.approveRetainerChange("user-1", retainerId, proposed.id);
    expect(waived.overage?.handling).toBe("waived");
    expect(waived.approvedChanges[0]?.applied).toBe(true);

    const added = await saved.proposeRetainerChange("user-1", {
      retainerId,
      kind: "add_included_work",
      summary: "Add the about page the client asked for.",
      workTitle: "About page",
      workDescription: "A single about page."
    });
    const withWork = await saved.approveRetainerChange("user-1", retainerId, added.id);
    expect(withWork.includedWork.map((row) => row.title)).toContain("About page");
    const again = await saved.approveRetainerChange("user-1", retainerId, added.id);
    expect(again.includedWork.filter((row) => row.title === "About page")).toHaveLength(1);

    const retired = await saved.proposeRetainerChange("user-1", {
      retainerId,
      kind: "retire_exclusion",
      summary: "Product pages are no longer excluded.",
      workId: excludedId
    });
    const withoutExclusion = await saved.approveRetainerChange("user-1", retainerId, retired.id);
    expect(withoutExclusion.excludedWork).toHaveLength(0);
    await expect(saved.assessWorkRequest("user-1", retainerId, "New product pages")).rejects.toThrow(REFUSED_OUTSIDE);

    const record = await saved.readRetainer("user-1", retainerId);
    expect(record.guidance).toContain("Do not waive overage");
    expect(record.renewalOn).toBe("2027-01-01");
    expect(record.includedHours?.hours).toBe(20);
  });

  it("keeps each freelancer's retainer and reloads it from disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "retain-"));
    const file = path.join(dir, "retain.json");
    const first = createFileRetainStore(file);
    const retainer = await first.openRetainer("user-1", { clientName: "Ada", title: "Writing retainer" });
    await expect(first.readRetainer("user-2", retainer.id)).rejects.toThrow("Retainer not found");
    const second = createFileRetainStore(file);
    const listed = await second.listRetainers("user-1", 0);
    expect(listed.retainers[0]?.id).toBe(retainer.id);
    expect(await second.listRetainers("user-2", 0)).toEqual({ retainers: [], nextOffset: null });
  });
});
