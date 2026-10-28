import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, loadContracts, loadProject, renderCatalog } from "@projected/cli";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples");
const eventSourced = join(examples, "school-event-sourced");
const stateBased = join(examples, "school-state-based");

describe("analysing a service's code", () => {
  it("binds every contract to the use case the composition root gives it", () => {
    const model = analyze(eventSourced);

    expect(model.bindings).toEqual({
      "enlist-student@1": "enlistStudentV1",
      "enlist-student@2": "enlistStudentV2",
      "report-student-lastname-change@1": "reportStudentLastnameChange",
      "withdraw-student@1": "withdrawStudent",
      "enlisted-students-on-joining-date@1": "enlistedStudentsOnJoiningDate",
      "student-profile@1": "studentProfile",
    });
  });

  it.each([
    ["event-sourced", eventSourced],
    ["state-based", stateBased],
  ])("traces the events a %s command emits through the decisions it calls", (_flavour, root) => {
    const withdraw = analyze(root).useCases.find((useCase) => useCase.name === "withdrawStudent");

    expect(withdraw).toMatchObject({ writes: ["student"], emits: ["StudentWithdrawn"] });
  });

  it("tells reading an aggregate from reading a port", () => {
    const useCases = analyze(eventSourced).useCases;

    expect(useCases.find((u) => u.name === "studentProfile")).toMatchObject({ reads: ["student"], ports: [] });
    expect(useCases.find((u) => u.name === "enlistedStudentsOnJoiningDate")).toMatchObject({ reads: [], ports: ["StudentDirectory"] });
  });

  it("finds event handlers, what they consume and the ports they use", () => {
    const [handler] = analyze(eventSourced).eventHandlers;

    expect(handler).toMatchObject({
      name: "student-directory",
      consumes: ["StudentEnlisted", "StudentLastnameChanged", "StudentWithdrawn"],
      ports: ["StudentDirectory"],
    });
  });

  it("lists ports with their adapters, leaving out the data types they use", () => {
    const model = analyze(eventSourced);

    expect(model.ports.map((port) => [port.name, port.adapters])).toEqual([["StudentDirectory", ["documentStudentDirectory"]]]);
    expect(model.relays).toEqual(["school.events"]);
  });
});

describe("the catalog", () => {
  it("renders the same document from the same code", async () => {
    const project = loadProject(eventSourced);
    const contracts = await loadContracts(project);

    const first = renderCatalog(contracts, analyze(eventSourced), project.flavour);
    const second = renderCatalog(contracts, analyze(eventSourced), project.flavour);

    expect(second).toBe(first);
  }, 30_000);

  it("describes both flavours of the same service identically, but for the flavour", async () => {
    const render = async (root: string) => {
      const project = loadProject(root);
      return renderCatalog(await loadContracts(project), analyze(root), project.flavour).replace(project.flavour, "<flavour>");
    };

    expect(await render(stateBased)).toBe(await render(eventSourced));
  }, 30_000);
});
