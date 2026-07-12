// Component tests for the tabbed setup page (cinatra-ai/plane-connector#28):
// tab PRESENCE, ORDER (Help always LAST), and CONTENT MAPPING (Setup tab ->
// the connection form, Help tab -> read-only how-to).
//
// This is a structural test over the React ELEMENT TREE the server component
// produces, not a DOM render (the repo's vitest environment is `node`, no
// jsdom — same posture as sdk-ui's own tabs.test.tsx). Calling
// `PlaneConnectorSetupImpl()` executes only that async function; JSX for its
// children (ConnectorSetupPage, Tabs, TabsListRow, TabsTrigger, TabsContent,
// SetupTabContent, HelpTabContent) is NOT invoked — `<X {...props}/>`
// compiles to an unevaluated `{ type: X, props }` element — so we assert
// presence/order/props on those elements directly, and additionally
// hand-invoke the (non-exported, plain sync) tab-content components to
// verify what each tab actually renders.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { PlaneConnectorSetupImpl } from "../plane-setup-impl";
import {
  registerPlaneConnector,
  _resetPlaneDepsForTests,
  type PlaneConnectorHostDeps,
  type PlaneInstanceConfig,
} from "../deps";
import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
import { Tabs, TabsListRow, TabsTrigger, TabsContent } from "@cinatra-ai/sdk-ui/tabs";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { connectPlaneAction } from "../actions";

const INSTANCE: PlaneInstanceConfig = {
  instanceId: "plane-default",
  baseUrl: "https://plane.example.com",
  workspaceSlug: "acme",
  projectId: "9e051c95-7408-4d4e-896e-c714e02e5713",
  encryptedPat: { ciphertext: "ct", iv: "iv" },
  updatedAt: "2026-06-19T00:00:00.000Z",
};

function buildDeps(instance: PlaneInstanceConfig | null): PlaneConnectorHostDeps {
  return {
    secretsCodec: {
      encryptSecret: (plaintext) => ({ ciphertext: plaintext, iv: "iv" }),
      decryptSecret: () => "plane_api_smoke_test_token",
    },
    loadInstanceConfig: async () => instance,
    saveInstanceConfig: async () => {},
  };
}

afterEach(() => {
  _resetPlaneDepsForTests();
});

/** Recursively unwraps a single React child to a plain element (props.children
 *  is sometimes a bare element, sometimes an array — normalize to an array). */
function childArray(children: React.ReactNode): React.ReactElement[] {
  return React.Children.toArray(children).filter((c) =>
    React.isValidElement(c),
  ) as React.ReactElement[];
}

async function renderTree(instance: PlaneInstanceConfig | null) {
  registerPlaneConnector(buildDeps(instance));
  const root = await PlaneConnectorSetupImpl();
  expect(React.isValidElement(root)).toBe(true);
  return root as React.ReactElement<Record<string, unknown>>;
}

describe("PlaneConnectorSetupImpl — page shell", () => {
  it("uses the shared ConnectorSetupPage shell with divider off (Tabs owns the section rule)", async () => {
    const root = await renderTree(null);
    expect(root.type).toBe(ConnectorSetupPage);
    expect(root.props.title).toBe("Plane connector");
    expect(root.props.divider).toBe(false);
  });

  it("wraps the page body in the shared sdk-ui Tabs primitive (no vendored tabs.tsx)", async () => {
    const root = await renderTree(null);
    const tabs = root.props.children as React.ReactElement<Record<string, unknown>>;
    expect(tabs.type).toBe(Tabs);
    expect(tabs.props.defaultValue).toBe("setup");
  });
});

describe("PlaneConnectorSetupImpl — tab presence + order (Help always LAST)", () => {
  it("declares exactly two tab triggers, in order Setup, Help, inside TabsListRow", async () => {
    const root = await renderTree(null);
    const tabs = root.props.children as React.ReactElement<Record<string, unknown>>;
    const tabsChildren = childArray(tabs.props.children as React.ReactNode);

    const listRow = tabsChildren.find((c) => c.type === TabsListRow);
    expect(listRow).toBeTruthy();

    const triggers = childArray(
      (listRow!.props as Record<string, unknown>).children as React.ReactNode,
    );
    expect(triggers).toHaveLength(2);
    expect(triggers.every((t) => t.type === TabsTrigger)).toBe(true);

    const values = triggers.map((t) => (t.props as Record<string, unknown>).value);
    const labels = triggers.map((t) => (t.props as Record<string, unknown>).children);
    expect(values).toEqual(["setup", "help"]);
    expect(labels).toEqual(["Setup", "Help"]);
    // The reserved tab is LAST, not merely present.
    expect(values[values.length - 1]).toBe("help");
  });

  it("declares exactly two TabsContent panels, in the SAME order, Help last", async () => {
    const root = await renderTree(null);
    const tabs = root.props.children as React.ReactElement<Record<string, unknown>>;
    const tabsChildren = childArray(tabs.props.children as React.ReactNode);

    const contents = tabsChildren.filter((c) => c.type === TabsContent);
    expect(contents).toHaveLength(2);

    const values = contents.map((c) => (c.props as Record<string, unknown>).value);
    expect(values).toEqual(["setup", "help"]);
    expect(values[values.length - 1]).toBe("help");
  });
});

describe("PlaneConnectorSetupImpl — content mapping per tab", () => {
  async function getContentPanels(instance: PlaneInstanceConfig | null) {
    const root = await renderTree(instance);
    const tabs = root.props.children as React.ReactElement<Record<string, unknown>>;
    const tabsChildren = childArray(tabs.props.children as React.ReactNode);
    const contents = tabsChildren.filter((c) => c.type === TabsContent);
    const byValue = new Map(
      contents.map((c) => [
        (c.props as Record<string, unknown>).value as string,
        c.props as Record<string, unknown>,
      ]),
    );
    return byValue;
  }

  it("Setup tab maps to the connection form (SetupTabContent), narrower Help tab is separate content", async () => {
    const panels = await getContentPanels(null);
    const setupPanel = panels.get("setup")!;
    const helpPanel = panels.get("help")!;

    const setupInner = setupPanel.children as React.ReactElement<{
      instance: PlaneInstanceConfig | null;
      isConnected: boolean;
    }>;
    const helpInner = helpPanel.children as React.ReactElement<Record<string, never>>;

    // Distinct components (never the same content reused across tabs).
    expect(setupInner.type).not.toBe(helpInner.type);
    expect((setupInner.type as { name?: string }).name).toBe("SetupTabContent");
    expect((helpInner.type as { name?: string }).name).toBe("HelpTabContent");

    // Help content narrows per §II ("Additional configuration tabs" / the
    // reserved Help tab both narrow to the Narrow width, left-aligned).
    expect(helpPanel.className).toContain("max-w-xl");
  });

  it("Setup tab content renders the connection form with the connect server action and all four fields, reflecting the persisted instance", async () => {
    const panels = await getContentPanels(INSTANCE);
    const setupPanel = panels.get("setup")!;
    const setupInner = setupPanel.children as React.ReactElement<{
      instance: PlaneInstanceConfig | null;
      isConnected: boolean;
    }>;

    // Hand-invoke the plain sync component to inspect what it actually renders.
    const rendered = (
      setupInner.type as (p: {
        instance: PlaneInstanceConfig | null;
        isConnected: boolean;
      }) => React.ReactElement
    )(setupInner.props);

    expect(hasElementOfTypeRef(rendered, Card)).toBe(true);

    // The <form> is wired to the real connect server action (not a stub/no-op).
    const forms = findAllOfType(rendered, "form");
    expect(forms).toHaveLength(1);
    expect((forms[0].props as Record<string, unknown>).action).toBe(connectPlaneAction);

    // All four Input fields declared by connectPlaneAction's schema are
    // present, by `name` (not just label text) — baseUrl, workspaceSlug,
    // projectId, apiToken — and reflect the persisted instance's saved
    // values via `defaultValue` (uncontrolled inputs; this is what actually
    // survives a re-render, not just text appearing anywhere on the page).
    const inputs = findAllOfType(rendered, Input);
    const byName = new Map(
      inputs.map((el) => [
        (el.props as Record<string, unknown>).name as string,
        el.props as Record<string, unknown>,
      ]),
    );
    expect([...byName.keys()].sort()).toEqual(
      ["apiToken", "baseUrl", "projectId", "workspaceSlug"].sort(),
    );
    expect(byName.get("baseUrl")!.defaultValue).toBe(INSTANCE.baseUrl);
    expect(byName.get("workspaceSlug")!.defaultValue).toBe(INSTANCE.workspaceSlug);
    expect(byName.get("projectId")!.defaultValue).toBe(INSTANCE.projectId);

    const html = renderToText(rendered);
    expect(html).toContain("Base URL");
    expect(html).toContain("Workspace slug");
    expect(html).toContain("Project id");
    expect(html).toContain("API token");
  });

  it("Help tab content is read-only (no <form>, no Save action) and covers the setup how-to", async () => {
    const panels = await getContentPanels(null);
    const helpPanel = panels.get("help")!;
    const helpInner = helpPanel.children as React.ReactElement<Record<string, never>>;

    const rendered = (
      helpInner.type as (p: Record<string, never>) => React.ReactElement
    )(helpInner.props);
    const html = renderToText(rendered);

    // No form / Save anywhere in the Help tab.
    expect(hasElementOfType(rendered, "form")).toBe(false);
    expect(html).not.toContain("Save");

    // Covers the how-to grounded in the connector's own action schema
    // (deps.ts / actions.ts): minting a token, workspace slug, project id,
    // base URL.
    expect(html).toContain("API token");
    expect(html).toContain("workspace slug");
    expect(html).toContain("project id");
    expect(html).toContain("Base URL");
  });
});

// --- tiny structural helpers (no DOM, no react-dom/server dependency) ------

/** Depth-first text extraction over a React element tree — string/number
 *  leaves + a couple of well-known text-bearing props (placeholder, since
 *  Input renders a bare <input> with no text children). */
function renderToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderToText).join(" ");
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const parts: string[] = [];
    const slot = (props["data-slot"] as string) ?? "";
    if (slot) parts.push(`data-slot="${slot}"`);
    if (typeof props.placeholder === "string") parts.push(props.placeholder);
    if (typeof props.defaultValue === "string") parts.push(props.defaultValue);
    parts.push(renderToText(props.children as React.ReactNode));
    return parts.join(" ");
  }
  return "";
}

/** Depth-first search for a host element of the given tag (e.g. "form"). */
function hasElementOfType(node: React.ReactNode, tag: string): boolean {
  return hasElementOfTypeRef(node, tag);
}

/** Depth-first search for an element whose `type` matches (host tag string
 *  OR a specific component reference, e.g. the vendored `Card`). */
function hasElementOfTypeRef(node: React.ReactNode, type: unknown): boolean {
  return findAllOfType(node, type).length > 0;
}

/** Depth-first collection of every element whose `type` matches (host tag
 *  string OR a specific component reference, e.g. the vendored `Input`). */
function findAllOfType(
  node: React.ReactNode,
  type: unknown,
): React.ReactElement[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAllOfType(n, type));
  if (React.isValidElement(node)) {
    const children = (node.props as Record<string, unknown>).children as React.ReactNode;
    const found = node.type === type ? [node] : [];
    return [...found, ...findAllOfType(children, type)];
  }
  return [];
}
