import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Controls,
  ControlButton,
  MiniMap,
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
import type { GuildTask, GuildAgent } from "../../types/guild";

interface Props {
  parentTask: GuildTask;
  allTasks: GuildTask[];
  agents: GuildAgent[];
  onSelectTask?: (id: string) => void;
  /** When true, fills parent and shows MiniMap. Both modes are interactive. */
  fullscreen?: boolean;
}

/* ── Layout constants ── */
const NODE_W = 200;
const NODE_H = 42;
const LAYER_GAP_Y = 56;
const NODE_GAP_X = 16;

/* ── Status styling ── */
const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  completed: { color: "#10B981", bg: "#10B9810C", label: "已完成" },
  in_progress: { color: "#3b82f6", bg: "#3b82f60C", label: "进行中" },
  failed: { color: "#EF4444", bg: "#EF44440C", label: "失败" },
  cancelled: { color: "#6b7280", bg: "#6b72800C", label: "已取消" },
  open: { color: "#9ca3af", bg: "#9ca3af0C", label: "待处理" },
  bidding: { color: "#f59e0b", bg: "#f59e0b0C", label: "竞标中" },
  planning: { color: "#8b5cf6", bg: "#8b5cf60C", label: "规划中" },
  blocked: { color: "#d97706", bg: "#d976060C", label: "阻塞" },
};

/* ── Custom node — mirrors PipelineFlow AgentNode style ── */
type SubtaskNodeData = {
  label: string;
  status: string;
  statusColor: string;
  agentIcon?: string;
  agentName?: string;
  agentColor?: string;
  taskId: string;
  onSelect?: (id: string) => void;
};

function SubtaskNode({ data }: NodeProps<Node<SubtaskNodeData>>) {
  const { label, status, statusColor, agentIcon, agentName, agentColor } = data;
  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] cursor-pointer"
        style={{
          width: NODE_W,
          height: NODE_H,
          border: `1.5px solid ${statusColor}40`,
          backgroundColor: `${statusColor}0C`,
          boxShadow:
            status === "in_progress"
              ? `0 0 8px ${statusColor}30`
              : "0 1px 3px rgba(0,0,0,0.06)",
        }}
        onClick={() => data.onSelect?.(data.taskId)}
      >
        {/* Left: status dot */}
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            backgroundColor: statusColor,
            boxShadow: status === "in_progress" ? `0 0 5px ${statusColor}` : "none",
            animation: status === "in_progress" ? "dag-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        {/* Middle: title */}
        <span
          className="truncate font-medium leading-tight flex-1 min-w-0"
          style={{ color: "var(--color-text)" }}
          title={label}
        >
          {label}
        </span>
        {/* Right: agent icon */}
        {agentIcon && (
          <span className="shrink-0 flex items-center gap-0.5 text-[10px]" title={agentName}>
            <span>{agentIcon}</span>
            <span className="truncate max-w-[60px]" style={{ color: agentColor ?? "var(--color-text-muted)" }}>
              {agentName}
            </span>
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
}

const nodeTypes = { subtask: SubtaskNode };

/* ── Topological layering ── */
function buildLayers(subtasks: GuildTask[]): GuildTask[][] {
  const idSet = new Set(subtasks.map((t) => t.id));
  const depMap = new Map<string, string[]>();
  for (const t of subtasks) {
    depMap.set(t.id, (t.dependsOn ?? []).filter((d) => idSet.has(d)));
  }
  const layers: GuildTask[][] = [];
  const placed = new Set<string>();
  while (placed.size < subtasks.length) {
    const layer: GuildTask[] = [];
    for (const t of subtasks) {
      if (placed.has(t.id)) continue;
      if ((depMap.get(t.id) ?? []).every((d) => placed.has(d))) layer.push(t);
    }
    if (layer.length === 0) {
      for (const t of subtasks) if (!placed.has(t.id)) layer.push(t);
    }
    for (const t of layer) placed.add(t.id);
    layers.push(layer);
  }
  return layers;
}

/* ── Build nodes — same pattern as PipelineFlow.buildNodes ── */
function buildNodes(
  subtasks: GuildTask[],
  agents: GuildAgent[],
  onSelectTask?: (id: string) => void,
): Node<SubtaskNodeData>[] {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const layers = buildLayers(subtasks);
  const ns: Node<SubtaskNodeData>[] = [];

  const maxLayerWidth = Math.max(
    ...layers.map((l) => l.length * NODE_W + (l.length - 1) * NODE_GAP_X),
  );

  layers.forEach((layer, layerIdx) => {
    const layerWidth = layer.length * NODE_W + (layer.length - 1) * NODE_GAP_X;
    const offsetX = (maxLayerWidth - layerWidth) / 2;

    layer.forEach((t, nodeIdx) => {
      const agent = t.assignedAgentId ? agentMap.get(t.assignedAgentId) : undefined;
      const style = STATUS_STYLE[t.status] ?? STATUS_STYLE.open;

      ns.push({
        id: t.id,
        type: "subtask",
        position: {
          x: offsetX + nodeIdx * (NODE_W + NODE_GAP_X),
          y: layerIdx * (NODE_H + LAYER_GAP_Y),
        },
        data: {
          label: t.title,
          status: t.status,
          statusColor: style.color,
          agentIcon: agent?.icon,
          agentName: agent?.name,
          agentColor: agent?.color,
          taskId: t.id,
          onSelect: onSelectTask,
        },
      });
    });
  });
  return ns;
}

/* ── Build edges — same coloring as PipelineFlow ── */
function buildEdges(subtasks: GuildTask[]): Edge[] {
  const idSet = new Set(subtasks.map((s) => s.id));
  const taskMap = new Map(subtasks.map((s) => [s.id, s]));
  const es: Edge[] = [];

  for (const t of subtasks) {
    for (const depId of t.dependsOn ?? []) {
      if (!idSet.has(depId)) continue;
      const depTask = taskMap.get(depId);
      const bothDone = depTask?.status === "completed" && t.status === "completed";
      const anyFailed = depTask?.status === "failed" || t.status === "failed";
      const color = anyFailed ? "#EF4444" : bothDone ? "#10B981" : "var(--color-border)";

      es.push({
        id: `${depId}->${t.id}`,
        source: depId,
        target: t.id,
        type: "smoothstep",
        style: {
          stroke: color,
          strokeWidth: 1.5,
          opacity: bothDone ? 0.5 : anyFailed ? 0.4 : 0.55,
        },
        animated: anyFailed,
      });
    }
  }
  return es;
}

/* ── MiniMap node color ── */
function miniMapNodeColor(node: Node): string {
  const status = (node.data as SubtaskNodeData | undefined)?.status ?? "open";
  return STATUS_STYLE[status]?.color ?? "#9ca3af";
}

/* ── Inner component ── */

function SubtaskDAGInner({ parentTask, allTasks, agents, onSelectTask, fullscreen }: Props) {
  const subtasks = useMemo(
    () => allTasks.filter((t) => t.parentTaskId === parentTask.id),
    [allTasks, parentTask.id],
  );

  const initialNodes = useMemo(
    () => buildNodes(subtasks, agents, onSelectTask),
    [subtasks, agents, onSelectTask],
  );
  const flowEdges = useMemo(() => buildEdges(subtasks), [subtasks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // Sync data on subtask changes, preserve user-dragged positions if node set unchanged.
  const [prevInitial, setPrevInitial] = useState(initialNodes);
  if (initialNodes !== prevInitial) {
    setPrevInitial(initialNodes);
    const prevIds = new Set(prevInitial.map((n) => n.id));
    const nextIds = new Set(initialNodes.map((n) => n.id));
    const setChanged = prevIds.size !== nextIds.size || [...nextIds].some((id) => !prevIds.has(id));

    if (setChanged) {
      setNodes(initialNodes);
    } else {
      setNodes((prev) => {
        const dataMap = new Map(initialNodes.map((n) => [n.id, n.data]));
        return prev.map((n) => {
          const d = dataMap.get(n.id);
          return d ? { ...n, data: d } : n;
        });
      });
    }
  }

  const { fitView } = useReactFlow();

  const handleReset = useCallback(() => {
    setNodes(buildNodes(subtasks, agents, onSelectTask));
    requestAnimationFrame(() => { fitView({ padding: 0.1 }); });
  }, [subtasks, agents, onSelectTask, setNodes, fitView]);

  if (subtasks.length === 0) {
    return (
      <div className="text-xs text-center py-3" style={{ color: "var(--color-text-muted)" }}>
        暂无子任务
      </div>
    );
  }

  const layers = buildLayers(subtasks);
  const computedH = layers.length * (NODE_H + LAYER_GAP_Y) - LAYER_GAP_Y + 32;
  const height = fullscreen ? "100%" : Math.max(computedH, 120);

  return (
    <div style={{ height, width: "100%" }} className="subtask-dag">
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
          position="top-right"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}
        >
          <ControlButton onClick={handleReset} title="复位布局">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </ControlButton>
        </Controls>
        {fullscreen && (
          <MiniMap
            nodeColor={miniMapNodeColor}
            maskColor="rgba(0,0,0,0.15)"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
            }}
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
}

export default function SubtaskDAG(props: Props) {
  return (
    <ReactFlowProvider>
      <SubtaskDAGInner {...props} />
    </ReactFlowProvider>
  );
}
