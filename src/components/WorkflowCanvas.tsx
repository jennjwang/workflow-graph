import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls,
  NodeTypes, NodeChange, applyNodeChanges,
  ConnectionLineType,
  MarkerType,
  ReactFlowInstance,
  Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowStore } from '../store';
import { nodeTypes } from './nodes';
import { layoutTree } from '../lib/layout';
import { WorkflowNodeData } from '../types';
import { Node } from '@xyflow/react';

type WFNode = Node<WorkflowNodeData>;

export function WorkflowCanvas() {
  const nodes           = useWorkflowStore(s => s.nodes);
  const edges           = useWorkflowStore(s => s.edges);
  const manualPositions = useWorkflowStore(s => s.manualPositions);
  const setManualPosition = useWorkflowStore(s => s.setManualPosition);
  const deleteNodes     = useWorkflowStore(s => s.deleteNodes);
  const reparentNode    = useWorkflowStore(s => s.reparentNode);
  const spliceNodeIntoEdge = useWorkflowStore(s => s.spliceNodeIntoEdge);
  const confirmNode     = useWorkflowStore(s => s.confirmNode);
  const unconfirmNode   = useWorkflowStore(s => s.unconfirmNode);
  const pendingFocus    = useWorkflowStore(s => s.pendingFocus);
  const clearPendingFocus = useWorkflowStore(s => s.clearPendingFocus);

  // Click vs. double-click disambiguation. Single-click action is deferred so
  // a follow-up click (within 250ms) can cancel it and trigger discard instead.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Maximum centroid-to-edge-midpoint distance, in flow units, at which an
  // edge becomes a splice candidate while a node is being dragged.
  const SPLICE_THRESHOLD = 70;
  // Maximum centroid-to-node-bbox distance, in flow units, at which a node
  // becomes a reparent target. 0 means inside the bbox; >0 means proximity.
  const REPARENT_PROXIMITY = 80;

  const canvasRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const rfInstance = useRef<ReactFlowInstance<WFNode, Edge> | null>(null);
  // Set when a drag just performed a reparent; suppress the trailing manualPosition save for that node.
  const justReparented = useRef<string | null>(null);

  const [rfNodes, setRfNodes] = useState<Node<WorkflowNodeData>[]>([]);
  // Visual hints while dragging:
  //   spliceEdgeId   — existing edge highlighted to show splice intent
  //   reparentTarget — prospective new parent; we render a dashed preview edge
  //                    from that node to the dragged node so the participant
  //                    can confirm the intended move without overlapping cards.
  const [spliceEdgeId, setSpliceEdgeId] = useState<string | null>(null);
  const [reparentTarget, setReparentTarget] = useState<{ targetId: string; draggedId: string } | null>(null);

  const laidNodes = useMemo(
    () => layoutTree(nodes, edges, manualPositions),
    [nodes, edges, manualPositions]
  );

  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(laidNodes.map(n => n.id));
    return edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
  }, [laidNodes, edges]);

  useEffect(() => {
    if (!draggingRef.current) setRfNodes(laidNodes);
  }, [laidNodes]);

  // Auto-refocus when new nodes are added or a node enters edit mode.
  // Single-node focuses use setCenter (direct, no fitView fallback to
  // "fit-all-nodes" if the target is unmeasured). Multi-node focuses use
  // fitView to frame parent + children together.
  useEffect(() => {
    if (!pendingFocus || pendingFocus.length === 0) return;
    const ids = pendingFocus;
    const handle = setTimeout(() => {
      const inst = rfInstance.current;
      if (!inst) return;
      const all = inst.getNodes() as Node<WorkflowNodeData>[];
      const present = ids.filter(id => all.some(n => n.id === id));
      if (present.length === 0) { clearPendingFocus(); return; }
      if (present.length === 1) {
        const node = all.find(n => n.id === present[0])!;
        const w = node.width ?? 220;
        const h = node.height ?? 80;
        const cx = node.position.x + w / 2;
        const cy = node.position.y + h / 2;
        // Skip the camera move if the node is already comfortably in view at
        // a readable zoom — avoids the jarring "snap to center" when the
        // participant double-clicks a node they can already see clearly.
        const viewport = inst.getViewport();
        const bounds = canvasRef.current?.getBoundingClientRect();
        let alreadyInView = false;
        if (bounds && viewport.zoom >= 0.85) {
          const tl = inst.flowToScreenPosition({ x: node.position.x, y: node.position.y });
          const br = inst.flowToScreenPosition({ x: node.position.x + w, y: node.position.y + h });
          const MARGIN = 60;
          alreadyInView =
            tl.x >= bounds.left + MARGIN &&
            tl.y >= bounds.top + MARGIN &&
            br.x <= bounds.right - MARGIN &&
            br.y <= bounds.bottom - MARGIN;
        }
        if (!alreadyInView) {
          inst.setCenter(cx, cy, { zoom: 1.4, duration: 600 });
        }
      } else {
        inst.fitView({ nodes: present.map(id => ({ id })), padding: 0.4, duration: 600, maxZoom: 1.1 });
      }
      clearPendingFocus();
    }, 120);
    return () => clearTimeout(handle);
  }, [pendingFocus, clearPendingFocus]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes(nds => applyNodeChanges(changes, nds) as Node<WorkflowNodeData>[]);
      const removedIds = changes.filter(c => c.type === 'remove').map(c => c.id);
      if (removedIds.length) deleteNodes(removedIds);
      for (const change of changes) {
        if (change.type === 'position') {
          if (change.dragging) {
            draggingRef.current = true;
          } else if (change.position) {
            draggingRef.current = false;
            if (justReparented.current === change.id) {
              justReparented.current = null;
              continue;
            }
            setManualPosition(change.id, change.position);
          }
        }
      }
    },
    [setManualPosition, deleteNodes]
  );

  // Returns the id + connection-distance of the closest non-dragged node whose
  // right edge is within REPARENT_PROXIMITY of the dragged node's left edge —
  // i.e. how far the two are from being able to connect parent → child.
  // Treating the *right edge* as the anchor matches the LR layout: the parent's
  // outgoing connector emerges there, so it's where participants intuitively
  // aim when proposing a new child.
  const findReparentTarget = useCallback((draggedNode: Node<WorkflowNodeData>): { id: string; dist: number } | null => {
    if (!rfInstance.current) return null;
    const all = rfInstance.current.getNodes() as Node<WorkflowNodeData>[];
    const draggedH = draggedNode.height ?? 80;
    const dragLeftX = draggedNode.position.x;
    const dragMidY = draggedNode.position.y + draggedH / 2;
    let best: { id: string; dist: number } | null = null;
    for (const n of all) {
      if (n.id === draggedNode.id || n.id.startsWith('__backdrop__')) continue;
      const x = n.position.x, y = n.position.y;
      const w = n.width ?? 220, h = n.height ?? 80;
      const rightX = x + w;
      // Closest point on the target's right edge to the dragged left-mid point.
      const clampedY = Math.max(y, Math.min(dragMidY, y + h));
      const d = Math.hypot(dragLeftX - rightX, dragMidY - clampedY);
      if (d > REPARENT_PROXIMITY) continue;
      if (!best || d < best.dist) best = { id: n.id, dist: d };
    }
    return best;
  }, []);

  // Returns the closest edge (with its midpoint distance) within SPLICE_THRESHOLD
  // of the dragged node's centroid, ignoring edges that touch the dragged node.
  const findSpliceEdge = useCallback((draggedNode: Node<WorkflowNodeData>): { id: string; dist: number } | null => {
    if (!rfInstance.current) return null;
    const all = rfInstance.current.getNodes() as Node<WorkflowNodeData>[];
    const draggedW = draggedNode.width ?? 220;
    const draggedH = draggedNode.height ?? 80;
    const cx = draggedNode.position.x + draggedW / 2;
    const cy = draggedNode.position.y + draggedH / 2;

    let best: { id: string; dist: number } | null = null;
    for (const e of visibleEdges) {
      if (e.source === draggedNode.id || e.target === draggedNode.id) continue;
      const src = all.find(n => n.id === e.source);
      const tgt = all.find(n => n.id === e.target);
      if (!src || !tgt) continue;
      const sw = src.width ?? 220, sh = src.height ?? 80;
      const tw = tgt.width ?? 220, th = tgt.height ?? 80;
      const sx = src.position.x + sw / 2, sy = src.position.y + sh / 2;
      const tx = tgt.position.x + tw / 2, ty = tgt.position.y + th / 2;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const d = Math.hypot(cx - mx, cy - my);
      if (!best || d < best.dist) best = { id: e.id, dist: d };
    }
    return best && best.dist < SPLICE_THRESHOLD ? best : null;
  }, [visibleEdges]);

  // While dragging: pick whichever candidate is closer.
  //   Splice candidate (edge midpoint distance)  → "reconnect through this node"
  //   Reparent candidate (target right-edge gap) → "become child of this node"
  // Dropping in the gap between A and B → splice wins (midpoint is closer).
  // Dropping right next to a card with no edges nearby → reparent wins.
  const handleNodeDrag = useCallback((_e: React.MouseEvent, node: Node<WorkflowNodeData>) => {
    if (!rfInstance.current) return;
    if (!node.data.parentId) { setSpliceEdgeId(null); setReparentTarget(null); return; }
    const reparentCand = findReparentTarget(node);
    const spliceCand = findSpliceEdge(node);
    const useSplice = spliceCand && (!reparentCand || spliceCand.dist <= reparentCand.dist);
    if (useSplice) {
      setSpliceEdgeId(spliceCand!.id);
      setReparentTarget(null);
      return;
    }
    if (reparentCand) {
      setReparentTarget({ targetId: reparentCand.id, draggedId: node.id });
      setSpliceEdgeId(null);
      return;
    }
    setSpliceEdgeId(null);
    setReparentTarget(null);
  }, [findReparentTarget, findSpliceEdge]);

  const handleNodeDragStop = useCallback((_e: React.MouseEvent, node: Node<WorkflowNodeData>) => {
    setSpliceEdgeId(null);
    setReparentTarget(null);
    if (!rfInstance.current) return;
    if (!node.data.parentId) return;
    const reparentCand = findReparentTarget(node);
    const spliceCand = findSpliceEdge(node);
    const useSplice = spliceCand && (!reparentCand || spliceCand.dist <= reparentCand.dist);
    if (useSplice) {
      const e = visibleEdges.find(ed => ed.id === spliceCand!.id);
      if (e && spliceNodeIntoEdge(node.id, e.source, e.target)) {
        justReparented.current = node.id;
      }
      return;
    }
    if (reparentCand) {
      const ok = reparentNode(node.id, reparentCand.id);
      if (ok) justReparented.current = node.id;
    }
  }, [reparentNode, spliceNodeIntoEdge, findReparentTarget, findSpliceEdge, visibleEdges]);

  // Highlight the candidate splice edge, plus inject a dashed preview edge from
  // the prospective new parent to the dragged node when reparenting is queued.
  const renderedEdges = useMemo(() => {
    const out: Edge[] = visibleEdges.map(e => e.id === spliceEdgeId
      ? { ...e, className: `${e.className ?? ''} workflow-splice-target`, animated: true }
      : e
    );
    if (reparentTarget) {
      out.push({
        id: '__reparent_preview__',
        source: reparentTarget.targetId,
        target: reparentTarget.draggedId,
        animated: true,
        style: { stroke: '#6366f1', strokeWidth: 2, strokeDasharray: '6 4' },
      });
    }
    return out;
  }, [visibleEdges, spliceEdgeId, reparentTarget]);

  return (
    <div ref={canvasRef} className="flex-1 h-full relative bg-slate-50">
      <ReactFlow
        nodes={rfNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes as NodeTypes}
        onInit={instance => { rfInstance.current = instance; }}
        onNodesChange={handleNodesChange}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={(e, n) => {
          const target = e.target as HTMLElement;
          if (target.closest('input, button, svg')) return;
          // If a single-click is already pending, treat this as the 2nd click
          // of a double-click and let onNodeDoubleClick take over.
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
            return;
          }
          const data = n.data as WorkflowNodeData;
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            if (data.confirmed === false) {
              confirmNode(n.id);
            } else if (data.parentId) {
              // Root has no draft state — never unkeep root.
              unconfirmNode(n.id);
            }
          }, 250);
        }}
        onNodeDoubleClick={(e, n) => {
          const target = e.target as HTMLElement;
          if (target.closest('input, button, svg')) return;
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          // Enter edit mode for the label and focus the canvas on this node
          // so the participant can clearly see what they're typing.
          useWorkflowStore.getState().setEditingNodeId(n.id);
          useWorkflowStore.getState().setPendingFocus([n.id]);
        }}
        nodesDraggable
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={['Backspace', 'Delete']}
        connectionLineType={ConnectionLineType.SmoothStep}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { stroke: '#cbd5e1', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1', width: 12, height: 12 },
        }}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1.4} color="#cbd5e1" />
        <Controls className="!shadow-sm !border !border-gray-200 !rounded-lg overflow-hidden" />
      </ReactFlow>

    </div>
  );
}
