/* eslint-disable @typescript-eslint/no-explicit-any */
// node-pipewire does not publish TypeScript declarations.
import { app } from "electron";

import { isWayland, sinkName, sourceName } from "../constants";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const nodeStartupTimeout = 3_000;

let initialization: Promise<void> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let shuttingDown = false;

function getPids() {
  return app.getAppMetrics().map((proc) => proc.pid ?? -1);
}

async function waitForNode(getNodes: () => any[], name: string) {
  const deadline = Date.now() + nodeStartupTimeout;
  while (Date.now() < deadline) {
    const node = getNodes().find(
      (candidate: any) =>
        candidate.name === name && candidate.ports?.length > 0,
    );
    if (node) return node;
    await delay(50);
  }

  throw new Error(`PipeWire node ${name} did not appear`);
}

function channelName(port: any) {
  if (port.name.includes("FL")) return "FL";
  if (port.name.includes("FR")) return "FR";
  if (port.name.includes("MONO")) return "MONO";
}

function hasCompleteNodeLinks(outputNode: any, inputNode: any, links: any[]) {
  const outputPorts = outputNode.ports.filter((port: any) => {
    const channel = channelName(port);
    return (
      port.direction === "Output" && (channel === "FL" || channel === "FR")
    );
  });
  const inputPorts = inputNode.ports.filter((port: any) => {
    const channel = channelName(port);
    return port.direction === "Input" && (channel === "FL" || channel === "FR");
  });
  // node-pipewire 1.1.0's name linker only handles FL/FR output ports.
  // Treat unsupported layouts as complete so they are skipped rather than
  // repeatedly tearing down valid links that the library cannot recreate.
  if (!outputPorts.length) return true;
  if (!inputPorts.length) return false;

  return outputPorts.every((outputPort: any) => {
    const channel = channelName(outputPort);
    const inputPort = inputPorts.find(
      (port: any) => channelName(port) === channel,
    );
    if (!inputPort) return false;

    return links.some(
      (link: any) =>
        Number(link.output_port_id) === Number(outputPort.id) &&
        Number(link.input_port_id) === Number(inputPort.id),
    );
  });
}

function ensureNodeLink(
  outputNode: any,
  inputNode: any,
  nodes: any[],
  links: any[],
  destroyObject: (id: number) => void,
  linkNodesNameToId: (
    outputNodeName: string,
    inputNodeId: number,
    permanent: boolean,
  ) => void,
) {
  // node-pipewire's name-based API resolves the graph on its native thread,
  // avoiding stale port IDs. Skip duplicate names because that API links all
  // matching nodes and could otherwise include Stoat audio.
  if (
    !outputNode.ports?.length ||
    nodes.filter((node: any) => node.name === outputNode.name).length !== 1
  ) {
    return;
  }

  if (hasCompleteNodeLinks(outputNode, inputNode, links)) return;

  const partialLinks = links.filter(
    (link: any) =>
      Number(link.output_node_id) === Number(outputNode.id) &&
      Number(link.input_node_id) === Number(inputNode.id),
  );
  if (partialLinks.length) {
    partialLinks.forEach((link: any) => destroyObject(Number(link.id)));
    return;
  }

  linkNodesNameToId(outputNode.name, Number(inputNode.id), false);
}

async function initializeVirtualMic() {
  const {
    createPwThread,
    createSink,
    createSource,
    destroyObject,
    getClients,
    getLinks,
    getNodes,
    linkNodesNameToId,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore node-pipewire does not publish TypeScript declarations.
  } = await import("node-pipewire");

  createPwThread();

  // Give the native thread time to connect before querying its initial graph.
  await delay(100);

  const appName = app.getName();

  const refreshRoutes = async () => {
    if (refreshing || shuttingDown) return;
    refreshing = true;
    try {
      let nodes: any[] = getNodes();

      if (!nodes.some((node: any) => node.name === sinkName)) {
        createSink(sinkName, ["FL", "FR"], false);
      }

      if (!nodes.some((node: any) => node.name === sourceName)) {
        createSource(sourceName, ["FL", "FR"], false);
      }

      const [sourceNode, sinkNode] = await Promise.all([
        waitForNode(getNodes, sourceName),
        waitForNode(getNodes, sinkName),
      ]);
      if (shuttingDown) return;

      const links = getLinks();
      const graphNodes = getNodes();
      ensureNodeLink(
        sinkNode,
        sourceNode,
        graphNodes,
        links,
        destroyObject,
        linkNodesNameToId,
      );

      const pids = new Set(getPids());
      const clients = getClients();
      const ownClientIds = new Set(
        clients
          .filter(
            (client: any) =>
              pids.has(Number(client.pid)) ||
              client.application_name === appName,
          )
          .map((client: any) => Number(client.id)),
      );

      nodes = getNodes().filter(
        (node: any) => node.props["media.class"] === "Stream/Output/Audio",
      );

      const ownNodes = nodes.filter(
        (node: any) =>
          ownClientIds.has(Number(node.props["client.id"])) ||
          pids.has(Number(node.props["application.process.id"])) ||
          node.props["application.name"] === appName,
      );
      const ownNodeIds = new Set(ownNodes.map((node: any) => Number(node.id)));

      for (const link of links) {
        if (
          ownNodeIds.has(Number(link.output_node_id)) &&
          Number(link.input_node_id) === Number(sinkNode.id)
        ) {
          destroyObject(Number(link.id));
        }
      }

      for (const node of nodes.filter(
        (candidate: any) => !ownNodeIds.has(Number(candidate.id)),
      )) {
        ensureNodeLink(
          node,
          sinkNode,
          graphNodes,
          links,
          destroyObject,
          linkNodesNameToId,
        );
      }
    } catch (error) {
      console.warn("Failed to update virtual microphone routes:", error);
    } finally {
      refreshing = false;
    }
  };

  await refreshRoutes();
  if (!shuttingDown) {
    pollTimer = setInterval(refreshRoutes, 1_000);
  }
}

export function initVirtualMic() {
  if (!isWayland || initialization) return initialization;

  shuttingDown = false;
  initialization = initializeVirtualMic().catch((error) => {
    initialization = undefined;
    console.warn(
      "node-pipewire failed to initialize; Wayland screen-share audio is unavailable:",
      error,
    );
  });

  return initialization;
}

export function cleanupVirtualMic() {
  shuttingDown = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
