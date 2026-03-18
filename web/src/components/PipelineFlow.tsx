import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Controls,
  ControlButton,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getRoleConfig } from "../constants/roles";

/* ── Shared types (re-exported from TeamPanel) ── */

interface SubagentInfo {
  subagentId: string;
  subagentName?: string;
  role?: string;
  dependsOn?: string[];
  phase: "started" | "completed" | "failed";
}

export type FullAgent = SubagentInfo & { dependsOn?: string[] };
export interface DagEdge {
  fromId: string;
  toId: string;
}

/* ── Props ── */

interface PipelineFlowProps {
  layers: FullAgent[][];
  edges: DagEdge[];
  agentMap: Map<string, FullAgent>;
}

/* ── Layout constants ── */

const NODE_W = 130;
const NODE_H = 36;
const LAYER_GAP_Y = 56;
const NODE_GAP_X = 12;

/* ── Phase → color helper ── */

function getPhaseColor(agent: SubagentInfo): string {
  if (agent.phase === "completed") return "#10B981";
  if (agent.phase === "failed") return "#EF4444";
  return getRoleConfig(agent.role)?.color ?? "var(--color-accent)";
}

/* ── Custom node ── */

type AgentNodeData = {
  label: string;
  icon: string;
  iconColor: string;
  phaseColor: string;
  phase: string;
};

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { label, icon, iconColor, phaseColor, phase } = data;
  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[10px]"
        style={{
          width: NODE_W,
          height: NODE_H,
          border: `1.5px solid ${phaseColor}40`,
          backgroundColor: `${phaseColor}0C`,
          boxShadow:
            phase === "started"
              ? `0 0 8px ${phaseColor}30`
              : "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        <span className="shrink-0" style={{ color: iconColor }}>
          {icon}
        </span>
        <span
          className="truncate font-medium leading-tight flex-1 min-w-0"
          style={{ color: "var(--color-text)" }}
        >
          {label}
        </span>
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            backgroundColor: phaseColor,
            boxShadow: phase === "started" ? `0 0 5px ${phaseColor}` : "none",
            animation: phase === "started" ? "dag-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
}

const nodeTypes = { agent: AgentNode };

/* ── Build initial nodes from layers ── */

function buildNodes(layers: FullAgent[][]): Node<AgentNodeData>[] {
  const ns: Node<AgentNodeData>[] = [];
  const maxLayerWidth = Math.max(
    ...layers.map((l) => l.length * NODE_W + (l.length - 1) * NODE_GAP_X),
  );

  layers.forEach((layer, layerIdx) => {
    const layerWidth = layer.length * NODE_W + (layer.length - 1) * NODE_GAP_X;
    const offsetX = (maxLayerWidth - layerWidth) / 2;

    layer.forEach((agent, nodeIdx) => {
      const rc = getRoleConfig(agent.role);
      const phaseColor = getPhaseColor(agent);
      const displayName = agent.subagentName ?? agent.subagentId.slice(0, 8);

      ns.push({
        id: agent.subagentId,
        type: "agent",
        position: {
          x: offsetX + nodeIdx * (NODE_W + NODE_GAP_X),
          y: layerIdx * (NODE_H + LAYER_GAP_Y),
        },
        data: {
          label: displayName,
          icon: rc?.icon ?? "\u{1F916}",
          iconColor: rc?.color ?? "var(--color-accent)",
          phaseColor,
          phase: agent.phase,
        },
      });
    });
  });
  return ns;
}

/* ── Main component ── */

function PipelineFlowInner({ layers, edges, agentMap }: PipelineFlowProps) {
  const initialNodes = useMemo(() => buildNodes(layers), [layers]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // Sync when layers data changes (new agents / phase updates)
  const [prevInitial, setPrevInitial] = useState(initialNodes);
  if (initialNodes !== prevInitial) {
    setPrevInitial(initialNodes);
    setNodes(initialNodes);
  }

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((e) => {
      const fromAgent = agentMap.get(e.fromId);
      const toAgent = agentMap.get(e.toId);
      const bothDone = fromAgent?.phase === "completed" && toAgent?.phase === "completed";
      const anyFailed = fromAgent?.phase === "failed" || toAgent?.phase === "failed";
      const color = anyFailed ? "#EF4444" : bothDone ? "#10B981" : "var(--color-border)";

      return {
        id: `${e.fromId}-${e.toId}`,
        source: e.fromId,
        target: e.toId,
        type: "smoothstep",
        style: {
          stroke: color,
          strokeWidth: 1.5,
          opacity: bothDone ? 0.5 : anyFailed ? 0.4 : 0.55,
        },
        animated: anyFailed,
      };
    });
  }, [edges, agentMap]);

  const height = layers.length * (NODE_H + LAYER_GAP_Y) - LAYER_GAP_Y + 32;

  const { fitView } = useReactFlow();

  const handleReset = useCallback(() => {
    setNodes(buildNodes(layers));
    // wait a tick for React to flush, then fitView
    requestAnimationFrame(() => { fitView({ padding: 0.1 }); });
  }, [layers, setNodes, fitView]);

  return (
    <div style={{ width: "100%", height: Math.max(height, 120) }} className="pipeline-flow">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.3}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls
          showInteractive={false}
          showFitView
          position="bottom-right"
        >
          <ControlButton onClick={handleReset} title="Reset layout">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  );
}

export default function PipelineFlow(props: PipelineFlowProps) {
  return (
    <ReactFlowProvider>
      <PipelineFlowInner {...props} />
    </ReactFlowProvider>
  );
}
