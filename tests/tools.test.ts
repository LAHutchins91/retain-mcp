import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRO_REQUIRED, SIGN_IN_REQUIRED } from "../src/access.js";
import { createFileRetainStore, type RetainStore } from "../src/retainer-store.js";
import { RETAIN_TOOL_NAMES, createRetainMcpServer } from "../src/retainer-tools.js";

async function connect(options: { userId: string; entitled: boolean; store: RetainStore }) {
  const client = new Client({ name: "retain-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRetainMcpServer(options);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

describe("retainer tools", () => {
  it("lists the Retain tools", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "retain-"));
    const client = await connect({ userId: "", entitled: false, store: createFileRetainStore(path.join(dir, "retain.json")) });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...RETAIN_TOOL_NAMES].sort());
    const blob = listed.tools.map((tool) => `${tool.name} ${tool.description ?? ""}`).join("\n");
    expect(blob).not.toMatch(/\$\d/);
    expect(blob.toLowerCase()).not.toContain("dollar");
  });

  it("refuses tool calls without sign-in or an active trial", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "retain-"));
    const saved = createFileRetainStore(path.join(dir, "retain.json"));
    const anonymous = await connect({ userId: "", entitled: false, store: saved });
    const signedOut = await anonymous.callTool({ name: "list_retainers", arguments: {} });
    expect(signedOut.isError).toBe(true);
    expect(textOf(signedOut)).toContain(SIGN_IN_REQUIRED);

    const unpaid = await connect({ userId: "user-1", entitled: false, store: saved });
    const blocked = await unpaid.callTool({ name: "list_retainers", arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain(PRO_REQUIRED);
  });

  it("refuses outside work and a waived overage unless a retainer change is approved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "retain-"));
    const saved = createFileRetainStore(path.join(dir, "retain.json"));
    const client = await connect({ userId: "user-1", entitled: true, store: saved });
    const created = await client.callTool({
      name: "open_retainer",
      arguments: { clientName: "Northwind", title: "Design retainer" }
    });
    const retainerId = JSON.parse(textOf(created)).retainer.id as string;
    await client.callTool({
      name: "set_included_hours",
      arguments: { retainerId, hours: 12, period: "month" }
    });
    await client.callTool({
      name: "set_overage_terms",
      arguments: { retainerId, handling: "stop", note: "Work stops when the included hours are used." }
    });
    await client.callTool({
      name: "note_included_work",
      arguments: { retainerId, title: "Homepage updates", description: "Revisions to the existing homepage." }
    });
    await client.callTool({
      name: "note_excluded_work",
      arguments: { retainerId, title: "New product pages", description: "Pages for products that are not live yet." }
    });
    await client.callTool({
      name: "set_renewal_date",
      arguments: { retainerId, renewalOn: "2027-04-01" }
    });
    await client.callTool({ name: "approve_retainer", arguments: { retainerId, confirmed: true } });

    const extra = await client.callTool({
      name: "note_included_work",
      arguments: { retainerId, title: "Brand campaign", description: "A campaign that was not approved." }
    });
    expect(extra.isError).toBe(true);
    expect(textOf(extra)).toContain("Refused:");

    const outside = await client.callTool({
      name: "assess_work_request",
      arguments: { retainerId, title: "Brand campaign" }
    });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain("outside the approved retainer");

    const waiver = await client.callTool({
      name: "set_overage_terms",
      arguments: { retainerId, handling: "waived", note: "Skip the overage rule." }
    });
    expect(waiver.isError).toBe(true);
    expect(textOf(waiver)).toContain("Refused:");

    const order = await client.callTool({
      name: "propose_retainer_change",
      arguments: {
        retainerId,
        kind: "waive_overage",
        summary: "Client asked to waive overage for this cycle."
      }
    });
    const changeId = JSON.parse(textOf(order)).id as string;
    const applied = await client.callTool({
      name: "approve_retainer_change",
      arguments: { retainerId, changeId, confirmed: true }
    });
    const record = JSON.parse(textOf(applied));
    expect(record.overage.handling).toBe("waived");

    const read = await client.callTool({ name: "read_retainer", arguments: { retainerId } });
    expect(textOf(read)).toContain("Do not waive overage");
    expect(JSON.parse(textOf(read)).overage.handling).toBe("waived");
  });
});
