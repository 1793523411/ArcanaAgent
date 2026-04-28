import { useMemo, useCallback, useEffect } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PipelineStepSpec } from "../../types/guild";

interface Props {
  steps: PipelineStepSpec[];
  selectedIndex: number | null;
  onSelect: (idx: number | null) => void;
  onChangeSteps: (steps: PipelineStepSpec[]) => void;
  onAddStep: () => void;
}

const NODE_W = 200;
const NODE_H = 56;
const LAYER_GAP_Y = 80;
const NODE_GAP_X = 40;

const KIND_STYLE: Record<string, { border: string; bg: string; label: string; glyph: string }> = {
  task: { border: "#3b82f6", bg: "#ffffff", label: "任务", glyph: "▦" },
  branch: { border: "#8b5cf6", bg: "#ffffff", label: "分支", glyph: "◈" },
  foreach: { border: "#f59e0b", bg: "#ffffff", label: "循环", glyph: "↻" },
};

type StepNodeData = {
  index: number;
  title: string;
  kind: string;
  selected: boolean;
};

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const style = KIND_STYLE[data.kind] ?? KIND_STYLE.task;
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: style.border, width: 10, height: 10, border: "2px solid #fff" }}
      />
      <div
        className="flex items-stretch rounded-lg overflow-hidden text-[11px]"
        style={{
          width: NODE_W,
          height: NODE_H,
          border: data.selected ? `2px solid ${style.border}` : "1px solid var(--color-border)",
          background: "var(--color-surface)",
          boxShadow: data.selected
            ? `0 0 0 3px ${style.border}25, 0 2px 8px rgba(0,0,0,0.08)`
            : "0 1px 2px rgba(0,0,0,0.04)",
          transition: "box-shadow 120ms ease, border-color 120ms ease",
        }}
      >
        {/* Left color bar + kind glyph */}
        <div
          className="flex items-center justify-center shrink-0"
          style={{ width: 28, background: `${style.border}14`, color: style.border }}
          title={style.label}
        >
          <span className="text-base leading-none">{style.glyph}</span>
        </div>
        {/* Main content */}
        <div className="flex-1 min-w-0 px-2.5 py-1.5 flex flex-col justify-center gap-0.5">
          <span
            className="font-mono text-[10px] leading-none"
            style={{ color: "var(--color-text-muted)" }}
          >
            #{data.index}
          </span>
          <div
            className="truncate font-medium leading-tight"
            style={{ color: "var(--color-text)" }}
            title={data.title}
          >
            {data.title || <span style={{ color: "var(--color-text-muted)" }}>未命名</span>}
          </div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: style.border, width: 10, height: 10, border: "2px solid #fff" }}
      />
    </>
  );
}

const nodeTypes = { step: StepNode };

function layout(steps: PipelineStepSpec[]): Map<number, { x: number; y: number }> {
  const N = steps.length;
  const deps: number[][] = steps.map((s) => (s.dependsOn ?? []).filter((d) => d >= 0 && d < N));
  const layers: number[][] = [];
  const placed = new Set<number>();
  while (placed.size < N) {
    const layer: number[] = [];
    for (let i = 0; i < N; i++) {
      if (placed.has(i)) continue;
      if (deps[i].every((d) => placed.has(d))) layer.push(i);
    }
    if (layer.length === 0) {
      for (let i = 0; i < N; i++) if (!placed.has(i)) layer.push(i);
    }
    for (const i of layer) placed.add(i);
    layers.push(layer);
  }
  const maxW = Math.max(...layers.map((l) => l.length * (NODE_W + NODE_GAP_X) - NODE_GAP_X), 0);
  const pos = new Map<number, { x: number; y: number }>();
  layers.forEach((layer, y) => {
    const w = layer.length * (NODE_W + NODE_GAP_X) - NODE_GAP_X;
    const offsetX = (maxW - w) / 2;
    layer.forEach((idx, x) => {
      pos.set(idx, { x: offsetX + x * (NODE_W + NODE_GAP_X), y: y * (NODE_H + LAYER_GAP_Y) });
    });
  });
  return pos;
}

function buildNodes(
  steps: PipelineStepSpec[],
  positions: Map<number, { x: number; y: number }>,
  selectedIndex: number | null,
): Node<StepNodeData>[] {
  return steps.map((s, i) => ({
    id: String(i),
    type: "step",
    position: positions.get(i) ?? { x: i * (NODE_W + NODE_GAP_X), y: 0 },
    data: {
      index: i,
      title: s.title,
      kind: s.kind ?? "task",
      selected: selectedIndex === i,
    },
  }));
}

function buildEdges(steps: PipelineStepSpec[]): Edge[] {
  const es: Edge[] = [];
  steps.forEach((s, i) => {
    for (const d of s.dependsOn ?? []) {
      if (d < 0 || d >= steps.length || d === i) continue;
      es.push({
        id: `${d}->${i}`,
        source: String(d),
        target: String(i),
        type: "smoothstep",
        style: { stroke: "var(--color-border)", strokeWidth: 1.5 },
      });
    }
  });
  return es;
}

function Inner({ steps, selectedIndex, onSelect, onChangeSteps, onAddStep }: Props) {
  const positions = useMemo(() => layout(steps), [steps]);
  const { fitView } = useReactFlow();
  const initialNodes = useMemo(
    () => buildNodes(steps, positions, selectedIndex),
    [steps, positions, selectedIndex],
  );
  const initialEdges = useMemo(() => buildEdges(steps), [steps]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Re-sync when steps change externally. Preserve user-dragged positions
  // only when the id set is unchanged (edge changes, title edits, kind
  // toggles, selection). When nodes are added/removed, fall back to the
  // recomputed layout — otherwise post-deletion the remaining steps would
  // visually "inherit" slots of deleted ones.
  useEffect(() => {
    setNodes((prev) => {
      const prevIds = prev.map((n) => n.id).sort().join(",");
      const nextIds = initialNodes.map((n) => n.id).sort().join(",");
      if (prevIds !== nextIds) return initialNodes;
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return initialNodes.map((n) => {
        const existing = prevById.get(n.id);
        return existing ? { ...n, position: existing.position } : n;
      });
    });
  }, [initialNodes, setNodes]);
  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      const src = parseInt(c.source, 10);
      const tgt = parseInt(c.target, 10);
      if (src === tgt) return;
      // prevent cycle: src must not depend (transitively) on tgt
      const visited = new Set<number>();
      const stack = [src];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === tgt) return; // would create cycle
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const d of steps[cur]?.dependsOn ?? []) stack.push(d);
      }
      const next = steps.map((s, i) =>
        i === tgt
          ? { ...s, dependsOn: Array.from(new Set([...(s.dependsOn ?? []), src])).sort((a, b) => a - b) }
          : s,
      );
      onChangeSteps(next);
      setEdges((eds) => addEdge({ ...c, type: "smoothstep", style: { stroke: "var(--color-border)", strokeWidth: 1.5 } }, eds));
    },
    [steps, onChangeSteps, setEdges],
  );

  const handleEdgesDelete = useCallback(
    (removed: Edge[]) => {
      if (removed.length === 0) return;
      let next = steps;
      for (const e of removed) {
        const src = parseInt(e.source, 10);
        const tgt = parseInt(e.target, 10);
        next = next.map((s, i) =>
          i === tgt ? { ...s, dependsOn: (s.dependsOn ?? []).filter((d) => d !== src) } : s,
        );
      }
      onChangeSteps(next);
    },
    [steps, onChangeSteps],
  );

  const handleNodesDelete = useCallback(
    (removed: Node[]) => {
      if (removed.length === 0) return;
      const toRemove = new Set(removed.map((n) => parseInt(n.id, 10)));
      const kept = steps
        .map((s, i) => ({ s, i }))
        .filter(({ i }) => !toRemove.has(i));
      const oldToNew = new Map<number, number>();
      kept.forEach(({ i }, newIdx) => oldToNew.set(i, newIdx));
      const next = kept.map(({ s }) => ({
        ...s,
        dependsOn: (s.dependsOn ?? [])
          .filter((d) => oldToNew.has(d))
          .map((d) => oldToNew.get(d)!),
      }));
      onChangeSteps(next);
      onSelect(null);
    },
    [steps, onChangeSteps, onSelect],
  );

  const handleNodeClick = useCallback(
    (_: unknown, n: Node) => {
      const idx = parseInt(n.id, 10);
      onSelect(Number.isNaN(idx) ? null : idx);
    },
    [onSelect],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<StepNodeData>>[]) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const handleResetLayout = useCallback(() => {
    const fresh = buildNodes(steps, layout(steps), selectedIndex);
    setNodes(fresh);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 0);
  }, [steps, selectedIndex, setNodes, fitView]);

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onNodesDelete={handleNodesDelete}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelect(null)}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background gap={16} color="var(--color-border)" />
        <Controls
          showInteractive={false}
          position="bottom-right"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
          }}
        />
      </ReactFlow>
      {/* Legend */}
      <div
        className="absolute top-2 left-2 flex gap-2 text-[10px] pointer-events-none"
        style={{ color: "var(--color-text-muted)" }}
      >
        {(["task", "branch", "foreach"] as const).map((k) => {
          const s = KIND_STYLE[k];
          return (
            <div
              key={k}
              className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <span style={{ color: s.border }}>{s.glyph}</span>
              <span>{s.label}</span>
            </div>
          );
        })}
      </div>
      {/* Top-right action buttons */}
      <div className="absolute top-2 right-2 flex items-center gap-2">
        <button
          onClick={handleResetLayout}
          title="重新自动布局并居中"
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium"
          style={{
            background: "var(--color-surface)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          <span className="text-sm leading-none">↺</span> 复位
        </button>
        <button
          onClick={onAddStep}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium"
          style={{
            background: "var(--color-accent)",
            color: "white",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
          }}
        >
          <span className="text-sm leading-none">+</span> 新建步骤
        </button>
      </div>
    </div>
  );
}

export default function PipelineCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
