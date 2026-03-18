import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  useReactFlow,
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

/* ── Main component ── */

function PipelineFlowInner({ layers, edges, agentMap }: PipelineFlowProps) {
  const { nodes, flowEdges, height } = useMemo(() => {
    const ns: Node<AgentNodeData>[] = [];

    // Compute total width needed per layer for centering
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
          draggable: false,
          selectable: false,
          focusable: false,
        });
      });
    });

    const es: Edge[] = edges.map((e) => {
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

    const h = layers.length * (NODE_H + LAYER_GAP_Y) - LAYER_GAP_Y + 32;

    return { nodes: ns, flowEdges: es, height: h };
  }, [layers, edges, agentMap]);

  const { fitView } = useReactFlow();
  const handleFitView = useCallback(() => { fitView({ padding: 0.1 }); }, [fitView]);

  return (
    <div style={{ width: "100%", height: Math.max(height, 120) }} className="pipeline-flow">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.3}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls
          showInteractive={false}
          showFitView
          onFitView={handleFitView}
          position="bottom-right"
        />
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
